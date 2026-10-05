const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const ts = require('typescript');

const root = path.resolve(__dirname, '../src');
function moduleFrom(file, imports, cache = new Map()) {
  if (cache.has(file)) return cache.get(file);
  const exports = {};
  cache.set(file,exports);
  const code = ts.transpileModule(fs.readFileSync(path.join(root, file), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  vm.runInNewContext(code, { exports, DOMException, AbortController, console,
    require(name) {
      if (Object.hasOwn(imports,name)) return imports[name];
      if (name.startsWith('@/') || name.startsWith('.')) {
        const relative = name.startsWith('@/') ? name.slice(2) : path.relative(root,path.resolve(root,path.dirname(file),name));
        return moduleFrom(relative.endsWith('.ts') ? relative : `${relative}.ts`,imports,cache);
      }
      return require(name);
    },
  });
  return exports;
}
function fixture() {
  let hooks, mode = 'scene', plan = { batches: [], named: [] }, prepareFailure, onPrepare, onCreate;
  const actors = [], surfaces = [], displayed = new Map();
  class Surface {
    constructor() { this.actors = new Set(); this.active = null; this.disposed = false; surfaces.push(this); }
    activate(actor) { assert.equal(this.disposed, false); assert.ok(!this.active || this.active === actor); this.active = actor; }
    deactivate(actor) { if (this.active === actor) this.active = null; }
    dispose() { if (this.disposed) return; this.disposed = true; for (const actor of [...this.actors]) actor.dispose(); this.actors.clear(); }
  }
  class Actor {
    constructor(options) { this.surface = options.surface; this.surface.actors.add(this); this.disposed = false; actors.push(this); }
    dispose() { this.disposed = true; this.surface.actors.delete(this); this.surface.deactivate(this); }
    static async create(options) { const actor = new Actor(options); await onCreate?.(); return actor; }
  }
  class Runtime {
    constructor(actor, initial, release) { this.actor = actor; this.motion = initial.motion; this.expression = initial.expression; this.release = release; this.isActive = true; this.disposed = false; }
    suspend() { this.isActive = false; }
    activate() { this.isActive = true; this.disposed = false; }
    setMotion(value) { this.motion = value; }
    setExpression(value) { this.expression = value; }
    setFocus(value) { this.focus = {...value}; }
    update() {}
    async prepare() { this.actor.prepared = (this.actor.prepared ?? 0) + 1; await onPrepare?.(this.actor); if (prepareFailure) { const error = prepareFailure; prepareFailure = undefined; throw error; } }
    dispose() { if (this.disposed) return; this.disposed = true; this.isActive = false; this.release(); }
  }
  const sceneData = {currentScene:{sceneUrl:'scene.txt'},currentSentenceId:0};
  const C = moduleFrom('Core/controller/scene/sceneInterface.ts',{}).commandType;
  const sentence = (command,content='',args={}) => ({command,content,args:Object.entries(args).map(([key,value])=>({key,value})),sentenceAssets:[],subScene:[],isLineBreakHolder:false});
  const scene = url => {
    if (plan.sentenceList) return {sceneUrl:url,sentenceList:plan.sentenceList};
    const lines = [], previous = new Set();
    for (const batch of plan.batches) {
      const next = new Set(batch.map(item=>item.key));
      for (const key of previous) if (!next.has(key)) lines.push(sentence(C.changeFigure,'',{id:key,next:true}));
      for (const {key,figure} of batch) lines.push(sentence(C.changeFigure,figure.url,{id:key,next:true,motion:figure.motion,expression:figure.expression}));
      lines.push(sentence(C.say,'pause')); previous.clear(); for (const key of next) previous.add(key);
    }
    return {sceneUrl:url,sentenceList:lines};
  };
  const api = moduleFrom('Core/controller/stage/pixi/gltfSceneResidency.ts', {
    '@/Core/Modules/stage/stageInterface': {
      FIGURE_POSITIONS: ['left','center','right'],
      figureStateKeyByPosition: {left:'figureLeft', center:'figureCenter', right:'figureRight'},
      normalizeFigureBounds: bounds => bounds ?? [0,0,1,1],
    },
    '@/Core/WebGAL': { WebGAL: { stageWidth:1920, stageHeight:1080, sceneManager:{sceneData}, gameplay:{pixiStage:{getStageObjByKey: key => displayed.get(key)}} } },
    '@/Core/live2DCore': {baseFocusParam:{x:0,y:0,instant:false}},
    '@/Core/util/sceneCharacterLoading': { registerSceneCharacterLoadingHooks(value) { hooks = value; }, getCharacterLoadingMode: () => mode },
    './gltfCharacter': { GltfCharacterRuntime:Runtime, characterOptions:async url => ({modelUrl:url}), preloadGltfNamedResources:async () => {} },
    './fixedGltfResources': { resolveFigureConfig:async url => ({gltf:url.endsWith('/config.json')}) },
    'webgal-lovelive-gltf-renderer': { OffscreenCharacter:Actor, CharacterRenderSurface:Surface },
  });
  const state = (items) => ({figureLeft:'',figureCenter:'',figureRight:'',freeFigure:items.map(([key,url]) => ({key,name:url,basePosition:'center'})), live2dMotion:[],live2dExpression:[],live2dFocus:[]});
  const signal = () => new AbortController().signal;
  const take = (key,url,position='center') => {
    const runtime = api.takePreparedGltfCharacter(key,url,position,[0,0,1,1]);
    assert.ok(runtime, 'prepared resident must exist');
    displayed.set(key,{gltfRuntime:runtime}); return runtime;
  };
  const realPrepareScene = hooks.prepareScene;
  hooks.prepareScene = (input,state,signal) => realPrepareScene(scene(input.sceneUrl),state,signal);
  return {api,hooks,actors,surfaces,displayed,state,signal,take,sceneData,C,sentence,
    setMode(value) {mode=value;}, setPlan(value) {plan=value;}, failPrepare() {prepareFailure = Error('fixture preparation failed');},
    onPrepare(fn) {onPrepare=fn;},
    onCreate(fn) {onCreate=fn;},
  };
}
const a = '/a/config.json', b = '/b/config.json';

test('stage restoration and reused preheated actors receive the current Focus before display',async()=>{
  const f=fixture();
  const first=f.state([['actor',a]]);first.live2dFocus=[{target:'actor',focus:{x:.4,y:-.3,instant:true}}];
  await f.hooks.prepareStage(first,f.signal());
  const actor=f.take('actor',a);
  assert.deepEqual(actor.focus,{x:.4,y:-.3,instant:true});
  actor.dispose();
  const next=f.state([['actor',a]]);next.live2dFocus=[{target:'actor',focus:{x:-.6,y:.2,instant:false}}];
  await f.hooks.prepareStage(next,f.signal());
  assert.equal(f.take('actor',a),actor);
  assert.deepEqual(actor.focus,{x:-.6,y:.2,instant:false});
});

test('scene preloads distinct characters in one slot and reuses actors when they return', async () => {
  const f = fixture();
  const figure = url => ({url,position:'center',bounds:[0,0,1,1],motion:'',expression:''});
  f.setPlan({named:[],batches:[[{key:'actor',figure:figure(a)}],[{key:'actor',figure:figure(b)}],[{key:'actor',figure:figure(a)}]]});
  await f.hooks.prepareScene({sceneUrl:'scene.txt'}, f.state([]), f.signal());
  assert.equal(f.actors.length,2); assert.equal(f.surfaces.length,1);
  await f.hooks.prepareStage(f.state([['actor',a]]),f.signal());
  const first = f.take('actor',a); first.dispose();
  await f.hooks.prepareStage(f.state([['actor',b]]),f.signal()); f.take('actor',b).dispose();
  await f.hooks.prepareStage(f.state([['actor',a]]),f.signal());
  assert.equal(f.take('actor',a),first);
  assert.equal(f.actors.length,2); assert.equal(f.surfaces.length,1);
});

test('a newly inserted earlier target does not evict or duplicate the unchanged active actor', async () => {
  const f = fixture();
  await f.hooks.prepareStage(f.state([['existing',a]]),f.signal());
  const existing = f.take('existing',a);
  await f.hooks.prepareStage(f.state([['new',b],['existing',a]]),f.signal());
  assert.equal(f.actors.length,2,'new target needs one actor, unchanged target needs none');
  assert.equal(f.displayed.get('existing').gltfRuntime,existing);
  assert.equal(existing.isActive,true);
  assert.equal(existing.actor.disposed,false);
});

test('failed stage preparation preserves the active runtime and surface for cancellation', async () => {
  const f = fixture();
  await f.hooks.prepareStage(f.state([['actor',a]]),f.signal());
  const active = f.take('actor',a); f.failPrepare();
  await assert.rejects(f.hooks.prepareStage(f.state([['actor',b]]),f.signal()),/fixture preparation failed/);
  assert.equal(active.isActive,true,'previous committed runtime must resume after failure');
  assert.equal(active.actor.surface.active,active.actor);
  assert.equal(active.actor.disposed,false);
  assert.equal(f.api.hasPreparedGltfCharacter('actor',b,'center',[0,0,1,1]),false);
});

test('scene release waits for the active retiring actor and then releases its context', async () => {
  const f = fixture();
  await f.hooks.prepareStage(f.state([['actor',a]]),f.signal());
  const active = f.take('actor',a), surface = active.actor.surface;
  f.setPlan({named:[],batches:[]});
  await f.hooks.prepareScene({sceneUrl:'next.txt'},f.state([]),f.signal());
  assert.equal(surface.disposed,false,'active retiring actor retains its context');
  active.dispose();
  assert.equal(surface.disposed,true); assert.equal(active.actor.disposed,true);
});

test('on-demand disposed residents are not retained and have no live context', async () => {
  const f = fixture(); f.setMode('on-demand');
  await f.hooks.prepareStage(f.state([['actor',a]]),f.signal());
  const active = f.take('actor',a), surface = active.actor.surface;
  active.dispose();
  assert.equal(surface.disposed,true); assert.equal(active.actor.disposed,true);
  await f.hooks.prepareStage(f.state([['actor',a]]),f.signal());
  assert.notEqual(f.take('actor',a),active);
});

test('aborting replacement preparation resumes the previously committed actor', async () => {
  const f = fixture();
  await f.hooks.prepareStage(f.state([['actor',a]]),f.signal());
  const active = f.take('actor',a), controller = new AbortController();
  f.onPrepare(() => controller.abort());
  await assert.rejects(f.hooks.prepareStage(f.state([['actor',b]]),controller.signal), {name:'AbortError'});
  assert.equal(active.isActive,true);
  assert.equal(active.actor.surface.active,active.actor);
  assert.equal(active.actor.disposed,false);
  assert.equal(f.actors.filter(actor => !actor.disposed).length,1);
});

test('switching loading mode rebinds the prepared owner and releases the old active context on commit', async () => {
  const f = fixture();
  await f.hooks.prepareStage(f.state([['actor',a]]),f.signal());
  const active = f.take('actor',a);
  f.setMode('on-demand');
  await f.hooks.prepareStage(f.state([['actor',a]]),f.signal());
  assert.equal(f.api.hasPreparedGltfCharacter('actor',a,'center',[0,0,1,1]),true);
  assert.equal(active.isActive,true);
  assert.equal(active.actor.disposed,false);
  const rebound = f.take('actor',a);
  assert.notEqual(rebound,active);
  active.dispose();
  assert.equal(active.actor.surface.disposed,true);
  assert.equal(f.actors.filter(actor => !actor.disposed).length,1);
  assert.equal(f.displayed.get('actor').gltfRuntime,rebound);
});

test('active motion changes preload inputs without modifying the displayed pose before commit', async () => {
  const f = fixture();
  await f.hooks.prepareStage(f.state([['actor',a]]),f.signal());
  const active = f.take('actor',a), next = f.state([['actor',a]]);
  next.live2dMotion = [{target:'actor',motion:'next'}];
  next.live2dExpression = [{target:'actor',expression:'smile'}];
  await f.hooks.prepareStage(next,f.signal());
  assert.equal(active.motion,''); assert.equal(active.expression,'');
  assert.equal(active.isActive,true);
  assert.equal(f.api.hasPreparedGltfCharacter('actor',a,'center',[0,0,1,1]),false);
  assert.equal(f.actors.length,1);
});

test('failed new-slot preparation releases its empty context and preserves the original active slot', async () => {
  const f = fixture();
  await f.hooks.prepareStage(f.state([['existing',a]]),f.signal());
  const active = f.take('existing',a); f.failPrepare();
  await assert.rejects(f.hooks.prepareStage(f.state([['existing',a],['new',b]]),f.signal()),/fixture preparation failed/);
  assert.equal(active.isActive,true);
  assert.equal(active.actor.surface.disposed,false);
  assert.equal(f.surfaces.filter(surface => !surface.disposed).length,1,'empty temporary context must be released');
  assert.equal(f.actors.filter(actor => !actor.disposed).length,1);
});

test('real reused runtime revives before awaiting async motion and includes commands arriving during prepare', async () => {
  const {GltfCharacterRuntime} = moduleFrom('Core/controller/stage/pixi/gltfCharacter.ts', {'./fixedGltfResources':{}, '@/store/store':{webgalStore:{getState:()=>({userData:{optionData:{meshClothEnabled:false}}})}}});
  let resolveMotion, prepared = 0, released = 0;
  const applied = [];
  const actor = {
    setMotion: async name => { await new Promise(resolve => {resolveMotion=resolve;}); applied.push(name); },
    setExpression: async name => {applied.push(name);},
    prepare: async () => {prepared++;},
  };
  const runtime = new GltfCharacterRuntime(actor,{motion:'',expression:''},() => {released++;});
  runtime.dispose(); assert.equal(released,1);
  runtime.activate(); runtime.suspend(); runtime.setMotion('next');
  const pending = runtime.prepare();
  await Promise.resolve();
  assert.equal(prepared,0,'actor prepare cannot run ahead of motion decoding');
  runtime.setExpression('smile');
  resolveMotion(); await pending;
  assert.deepEqual(applied,['next','smile']);
  assert.ok(prepared>=1);
  assert.equal(runtime.isActive,false,'hidden preparation must not start the ticker');
  runtime.activate(); assert.equal(runtime.isActive,true);
});

test('static last-use releases inactive residents but waits for the active exit owner', async () => {
  const f = fixture();
  const figure = url => ({url,position:'center',bounds:[0,0,1,1],motion:'',expression:''});
  f.setPlan({named:[],batches:[[{key:'actor',figure:figure(a)}],[{key:'actor',figure:figure(b)}],[]]});
  await f.hooks.prepareScene({sceneUrl:'scene.txt'},f.state([]),f.signal());
  await f.hooks.prepareStage(f.state([['actor',b]]),f.signal());
  const active = f.take('actor',b);
  f.sceneData.currentSentenceId=10;
  await f.hooks.prepareStage(f.state([]),f.signal());
  assert.equal(f.actors[0].disposed,true,'expired inactive model is released');
  assert.equal(active.actor.disposed,false,'committed exiting owner is not released early');
  assert.equal(active.actor.surface.disposed,false);
  active.dispose();
  assert.equal(active.actor.disposed,true);
  assert.equal(active.actor.surface.disposed,true);
});

test('matching selects the alternate resident slot instead of constructing a duplicate actor', async () => {
  const f = fixture();
  const figure = url => ({url,position:'center',bounds:[0,0,1,1],motion:'',expression:''});
  f.setPlan({named:[],batches:[[{key:'b',figure:figure(b)}],[{key:'a',figure:figure(a)}],[{key:'b',figure:figure(b)},{key:'a',figure:figure(a)}]]});
  await f.hooks.prepareScene({sceneUrl:'scene.txt'},f.state([]),f.signal());
  assert.equal(f.actors.length,3); assert.equal(f.surfaces.length,2);
  await f.hooks.prepareStage(f.state([['b',b],['a',a]]),f.signal());
  const first=f.take('b',b),second=f.take('a',a);
  assert.notEqual(first.actor.surface,second.actor.surface);
  assert.equal(f.actors.length,3,'reuse an alternative resident instead of allocating a fourth');
});

test('releaseScene drops inactive preloads immediately and retains an active context only until exit', async () => {
  const f=fixture();
  const figure=url=>({url,position:'center',bounds:[0,0,1,1],motion:'',expression:''});
  f.setPlan({named:[],batches:[[{key:'actor',figure:figure(a)}],[{key:'actor',figure:figure(b)}]]});
  await f.hooks.prepareScene({sceneUrl:'scene.txt'},f.state([]),f.signal());
  await f.hooks.prepareStage(f.state([['actor',a]]),f.signal());
  const active=f.take('actor',a);
  f.hooks.releaseScene();
  assert.equal(f.actors[1].disposed,true);
  assert.equal(active.actor.disposed,false);
  active.dispose();
  assert.equal(active.actor.disposed,true);
  assert.ok(f.surfaces.every(surface=>surface.disposed));
});

test('empty scene preparation has no actors or contexts', async () => {
  const f=fixture(); f.setPlan({sentenceList:[]});
  await f.hooks.prepareScene({sceneUrl:'empty.txt'},f.state([]),f.signal());
  assert.equal(f.actors.length,0); assert.equal(f.surfaces.length,0);
});

const figure = url => ({url,position:'center',bounds:[0,0,1,1],motion:'next',expression:'smile'});
test('on-demand lookahead prepares a hidden actor without interrupting the displayed actor, then consumes the same actor', async () => {
  const f=fixture(); f.setMode('on-demand');
  await f.hooks.prepareStage(f.state([['existing',a]]),f.signal());
  const active=f.take('existing',a);
  await f.api.prewarmGltfPredictions([[{key:'new',figure:figure(b)}]]);
  assert.equal(f.actors.length,2);
  assert.equal(active.isActive,true); assert.equal(active.actor.surface.active,active.actor);
  assert.equal(f.actors[1].prepared,1,'background actor must actually prepare');
  await f.hooks.prepareStage(f.state([['existing',a],['new',b]]),f.signal());
  assert.equal(f.take('new',b).actor,f.actors[1]); assert.equal(f.actors.length,2);
});
test('outdated predictions and reset release hidden GPU residents', async () => {
  const f=fixture(); f.setMode('on-demand');
  await f.api.prewarmGltfPredictions([[{key:'new',figure:figure(b)}]]);
  await f.api.prewarmGltfPredictions([]);
  assert.equal(f.actors[0].disposed,true); assert.equal(f.surfaces[0].disposed,true);
  await f.api.prewarmGltfPredictions([[{key:'new',figure:figure(b)}]]);
  f.hooks.releaseScene();
  assert.ok(f.actors.every(actor=>actor.disposed));
});

test('reset during asynchronous background creation disposes the late actor and its context', async () => {
  const f=fixture(); f.setMode('on-demand'); let finish;
  f.onCreate(()=>new Promise(resolve=>{finish=resolve;}));
  const pending=f.api.prewarmGltfPredictions([[{key:'new',figure:figure(b)}]]);
  while (!finish) await Promise.resolve();
  f.hooks.releaseScene(); finish(); await pending;
  assert.ok(f.actors.every(actor=>actor.disposed)); assert.ok(f.surfaces.every(surface=>surface.disposed));
});
test('foreground waits for an in-flight background actor instead of creating a duplicate', async () => {
  const f=fixture(); f.setMode('on-demand'); let finish;
  f.onCreate(()=>new Promise(resolve=>{finish=resolve;}));
  const warm=f.api.prewarmGltfPredictions([[{key:'new',figure:{...figure(b),motion:'',expression:''}}]]);
  while (!finish) await Promise.resolve();
  const gate=f.hooks.prepareStage(f.state([['new',b]]),f.signal());
  finish(); await warm; await gate;
  assert.equal(f.take('new',b).actor,f.actors[0]); assert.equal(f.actors.length,1);
  assert.equal(f.actors[0].prepared,1,'matching warmed commands need no second prepare');
});
test('failed background preparation releases hidden resources, preserves active playback and can retry', async () => {
  const f=fixture(); f.setMode('on-demand');
  await f.hooks.prepareStage(f.state([['existing',a]]),f.signal()); const active=f.take('existing',a);
  f.failPrepare();
  await assert.rejects(f.api.prewarmGltfPredictions([[{key:'new',figure:figure(b)}]]),/fixture preparation failed/);
  assert.equal(active.isActive,true); assert.equal(active.actor.surface.active,active.actor);
  assert.equal(f.actors.filter(actor=>!actor.disposed).length,1);
  await f.api.prewarmGltfPredictions([[{key:'new',figure:figure(b)}]]);
  assert.equal(f.actors.filter(actor=>!actor.disposed).length,2);
});
test('background lookahead skips native Live2D and leaves active motion and expression untouched', async () => {
  const f=fixture(); f.setMode('on-demand');
  await f.hooks.prepareStage(f.state([['existing',a]]),f.signal()); const active=f.take('existing',a);
  await f.api.prewarmGltfPredictions([[{key:'existing',figure:figure(a)},{key:'live2d',figure:figure('/native/model.json')}]]);
  assert.equal(f.actors.length,1); assert.equal(active.motion,''); assert.equal(active.expression,'');
  assert.equal(active.isActive,true);
});
test('current actors and ordinary dialogue do not wait for an unrelated slow background actor', async () => {
  const f=fixture(); f.setMode('on-demand');
  await f.hooks.prepareStage(f.state([['existing',a]]),f.signal()); const active=f.take('existing',a);
  let finish; f.onCreate(()=>new Promise(resolve=>{finish=resolve;}));
  const warm=f.api.prewarmGltfPredictions([[{key:'new',figure:figure(b)}]]);
  while (!finish) await Promise.resolve();
  const next=f.state([['existing',a]]); next.live2dMotion=[{target:'existing',motion:'new-motion'}];
  let committed=false;
  const gate=f.hooks.prepareStage(next,f.signal()).then(()=>{committed=true;});
  for (let i=0;i<30&&!committed;i++) await Promise.resolve();
  assert.equal(committed,true,'unchanged actors must not queue behind a future GPU warmup');
  assert.equal(active.isActive,true); assert.equal(active.motion,'');
  finish(); await warm; await gate;
});
test('ready branch commits while the other branch prepares and survives its failure', async () => {
  const f=fixture(); f.setMode('on-demand'); let finish;
  f.onPrepare(actor=> {if(actor===f.actors[1]) return new Promise(resolve=>{finish=resolve;});});
  const warm=f.api.prewarmGltfPredictions([[{key:'a',figure:{...figure(a),motion:'',expression:''}}],[{key:'b',figure:figure(b)}]]);
  const failed=assert.rejects(warm,/fixture preparation failed/);
  while (!finish) await Promise.resolve();
  let ready=false;
  const gate=f.hooks.prepareStage(f.state([['a',a]]),f.signal()).then(()=>{ready=true;});
  for(let i=0;i<30&&!ready;i++) await Promise.resolve();
  assert.equal(ready,true,'ready choice must not wait for another branch');
  f.failPrepare(); finish(); await failed; await gate;
  assert.equal(f.actors[0].disposed,false,'reserved ready branch survives unrelated failure');
  assert.equal(f.take('a',a).actor,f.actors[0]);
});
test('ready reservation survives an outdated background prediction, and cancellation retains the old picture', async () => {
  const f=fixture(); f.setMode('on-demand');
  await f.hooks.prepareStage(f.state([['existing',a]]),f.signal()); const active=f.take('existing',a);
  await f.api.prewarmGltfPredictions([[{key:'new',figure:{...figure(b),motion:'',expression:''}}]]);
  const controller=new AbortController();
  await f.hooks.prepareStage(f.state([['new',b]]),controller.signal);
  await f.api.prewarmGltfPredictions([]);
  assert.equal(f.actors[1].disposed,false,'prediction cleanup preserves the stage reservation');
  controller.abort();
  assert.equal(f.api.hasPreparedGltfCharacter('new',b,'center',[0,0,1,1]),false);
  assert.equal(f.actors[1].disposed,true,'cancelled reservation no longer needed by prediction is released');
  assert.equal(active.isActive,true); assert.equal(active.actor.surface.active,active.actor);
  f.hooks.releaseScene(); assert.equal(f.actors[1].disposed,true);
});
