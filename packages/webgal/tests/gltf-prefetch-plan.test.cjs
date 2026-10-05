const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const test = require('node:test');
const ts = require('typescript');

const root = path.resolve(__dirname, '../src');
function load(relative, mocks = {}, cache = new Map()) {
  const filename = path.resolve(root, relative);
  if (cache.has(filename)) return cache.get(filename).exports;
  const loaded = new Module(filename, module);
  cache.set(filename, loaded);
  loaded.paths = Module._nodeModulePaths(path.dirname(filename));
  loaded.require = name => {
    if (name in mocks) return mocks[name];
    if (name === '@/store/store') return {webgalStore:{getState:()=>({userData:{optionData:{meshClothEnabled:false}}})}};
    if (name.startsWith('@/') || name.startsWith('.')) {
      const file = name.startsWith('@/') ? name.slice(2) : path.relative(root, path.resolve(path.dirname(filename), name));
      return load(file.endsWith('.ts') ? file : `${file}.ts`, mocks, cache);
    }
    return Module.prototype.require.call(loaded, name);
  };
  loaded._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: {module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020},
  }).outputText, filename);
  return loaded.exports;
}

const {planGltfPreloads, planGltfChoiceBranch, planGltfSceneTransition, mergeGltfBranchPlans} = load('Core/util/prefetcher/gltfPrefetchPlan.ts');
const {commandType: C} = load('Core/controller/scene/sceneInterface.ts');
const empty = () => ({figName:'',figNameLeft:'',figNameRight:'',figNameLeft13:'',figNameRight13:'',
  figNameLeft14:'',figNameRight14:'',freeFigure:[],live2dMotion:[],live2dExpression:[]});
const sentence = (command, content='', args={}) => ({command,content,args:Object.entries(args).map(([key,value])=>({key,value})),
  sentenceAssets:[],subScene:[],isLineBreakHolder:false});
const figure = (model,args={}) => sentence(C.changeFigure,model ? `game/${model}/config.json` : '',args);
const say = () => sentence(C.say,'pause');
const plan = (list,state=empty(),start=0,limit=20) => planGltfPreloads({sceneUrl:'test',sentenceList:list},start,state,'visit',limit);

test('plans repeated model lifetimes and retains simultaneous instances while reusing unchanged slots', () => {
  const result=plan([
    figure('a',{left:true,motion:'first',expression:'smile',next:true}),figure('b',{right:true,next:true}),say(),
    figure('a',{left:true,motion:'second',next:true}),figure('c',{next:true}),say(),
    figure('',{left:true,next:true}),figure('a',{motion:'third',next:true}),figure('a',{right:true,next:true}),say(),
  ]);
  assert.deepEqual(result.requests.map(r=>[r.url,r.motion,r.expression]),[
    ['game/a/config.json','first','smile'],['game/b/config.json','',''],['game/c/config.json','',''],
    ['game/a/config.json','third',''],['game/a/config.json','',''],
  ]);
  assert.equal(new Set(result.requests.map(r=>r.preloadId)).size,5);
  assert.ok(result.named.some(r=>r.kind==='motion'&&r.name==='second'));
});

test('only final identities in a next batch allocate; an unchanged final identity reuses the stage object', () => {
  assert.deepEqual(plan([figure('a',{next:true}),figure('b',{next:true}),say()]).requests.map(r=>r.url),['game/b/config.json']);
  const state=empty();state.figName='game/a/config.json';
  assert.equal(plan([figure('b',{next:true}),figure('a',{next:true}),say()],state).requests.length,0);
});

test('same identity preserves absent commands and bounds; explicit bounds and free-figure positions create identities', () => {
  const state=empty();state.figName='game/a/config.json';
  state.live2dMotion=[{target:'fig-center',motion:'keep',overrideBounds:[1,2,3,4]}];
  state.live2dExpression=[{target:'fig-center',expression:'face'}];
  const preserved=plan([figure('a',{next:true}),say()],state);
  assert.equal(preserved.requests.length,0);
  assert.deepEqual(preserved.named,[{kind:'motion',name:'keep'},{kind:'expression',name:'face'}]);
  assert.equal(plan([figure('a',{bounds:'0,0,0,0',next:true}),say()],state).requests.length,1);
  const sameBounds=plan([figure('a',{bounds:'1,2,3,4',next:true}),say()],state);
  assert.equal(sameBounds.requests.length,0);
  assert.deepEqual(sameBounds.named,[{kind:'expression',name:'face'}]);
  const free=empty(); free.freeFigure=[{key:'person',name:'game/a/config.json',basePosition:'left'}];
  assert.equal(plan([figure('a',{id:'person',left:true,next:true}),say()],free).requests.length,0);
  assert.equal(plan([figure('a',{id:'person',right:true,next:true}),say()],free).requests.length,1);
});

test('clear does not preload its content, and new identities reset absent motion and expression', () => {
  const state=empty();state.figName='game/a/config.json';
  state.live2dMotion=[{target:'fig-center',motion:'old'}]; state.live2dExpression=[{target:'fig-center',expression:'old'}];
  const result=plan([figure('a',{clear:true,next:true}),say(),figure('a',{next:true}),say()],state);
  assert.deepEqual(result.requests.map(r=>[r.motion,r.expression]),[['','']]);
});

test('comment and multiline holders do not exhaust the command window', () => {
  const holders=Array.from({length:60},()=>({...sentence(C.comment,'_WEBGAL_LINE_BREAK_'),isLineBreakHolder:true}));
  assert.equal(plan([...holders,figure('a',{next:true}),say()],empty(),0,2).requests.length,1);
  assert.equal(plan([figure('a',{next:true}),say(),figure('b',{next:true}),say()],empty(),0,2).requests.length,1);
});

test('unknown control flow and interpolation stop speculation without executing scripts', () => {
  for (const boundary of [sentence(C.choose),sentence(C.setVar),sentence(C.jumpLabel),figure('{model}',{next:true}),figure('b',{when:'flag',next:true})]) {
    assert.equal(plan([figure('a',{next:true}),say(),boundary,figure('b',{next:true}),say()]).requests.length,1);
  }
  assert.equal(plan([figure('b',{when:'false',next:true}),figure('a',{next:true}),say()]).requests[0].url,'game/a/config.json');
  assert.equal(plan([figure('b',{when:false,next:true}),figure('a',{next:true}),say()]).requests[0].url,'game/a/config.json');
});

test('remaining occurrence IDs survive advancing past an earlier committed batch', () => {
  const list=[figure('a',{left:true,next:true}),say(),figure('b',{next:true}),say()];
  const before=plan(list);
  const state=empty();state.figNameLeft='game/a/config.json';
  assert.equal(before.requests[1].preloadId,plan(list,state,2).requests[0].preloadId);
});

test('one caption choice follows the actual label while blocking choice UI is preserved', () => {
  const list=[sentence(C.choose,'Chapter:actual'),figure('wrong'),sentence(C.end),
    sentence(C.label,'actual'),figure('right',{next:true}),say()];
  const scene={sceneUrl:'test',sentenceList:list};
  const ahead=plan(list);
  const selected=planGltfChoiceBranch(ahead,0,scene,empty(),'visit');
  assert.deepEqual(selected.requests.map(r=>r.url),['game/right/config.json']);
  const state=empty();state.PerformList=[{id:'choose',script:list[0]}];
  const blocked=plan(list,state,1);
  assert.equal(blocked.requests.length,0);
  assert.deepEqual(planGltfChoiceBranch(blocked,0,scene,state,'visit').requests,selected.requests);
  assert.equal(state.PerformList.length,1);
});

test('two branch plans inherit the choice state independently and interleave all requests', () => {
  const choice=plan([figure('base',{left:true,next:true}),sentence(C.choose,'A:a.txt|B:b.txt')]);
  assert.deepEqual(choice.requests.map(r=>r.url),['game/base/config.json']);
  const branch=prefix=>({sceneUrl:`${prefix}.txt`,sentenceList:[figure('base',{left:true,next:true}),
    ...Array.from({length:5},(_,i)=>figure(`${prefix}${i}`,{id:`person${i}`,next:true})),say(),figure('later'),say()]});
  const a=planGltfChoiceBranch(choice,0,branch('a'),empty(),'visit');
  const b=planGltfChoiceBranch(choice,1,branch('b'),empty(),'visit');
  assert.equal(a.requests.length,5);assert.equal(b.requests.length,5);
  assert.deepEqual(mergeGltfBranchPlans(choice,[a,b]).requests.map(r=>r.url),['game/base/config.json']);
  assert.deepEqual(mergeGltfBranchPlans({...choice,requests:[]},[a,b]).requests.map(r=>r.url),
    Array.from({length:5},(_,i)=>[`game/a${i}/config.json`,`game/b${i}/config.json`]).flat());
});

test('choice targets follow escaped delimiters and conditions without evaluating expressions', () => {
  const result=plan([sentence(C.choose,String.raw`(secret > 0)[run()]->A\|B\:C:one.txt|Other:two.txt`)]);
  assert.deepEqual(result.choice.branches,[{target:'one.txt',scene:true},{target:'two.txt',scene:true}]);
  assert.equal(plan([sentence(C.choose,'A:{target}')]).choice,undefined);
  assert.equal(plan([sentence(C.choose,'A:a|B:b|C:c')]).choice,undefined);
  assert.equal(plan([sentence(C.choose,'A:a',{when:'unknown'})]).choice,undefined);
});

test('a single static branch keeps the ordinary remaining window instead of stopping at its first batch', () => {
  const base=plan([figure('before'),sentence(C.choose,'Title:a.txt')]);
  const branch=planGltfChoiceBranch(base,0,{sceneUrl:'a.txt',sentenceList:[
    figure('a'),say(),figure('b'),say(),figure('c'),say(),
  ]},empty(),'visit');
  assert.deepEqual(mergeGltfBranchPlans(base,[branch]).requests.map(r=>r.url),
    ['game/before/config.json','game/a/config.json','game/b/config.json','game/c/config.json']);
});

test('two branches skip unchanged dialogue, preserve simultaneous duplicate models, and stop at the first new batch', () => {
  const state=empty();state.figName='game/existing/config.json';
  const base=plan([sentence(C.choose,'A:a.txt|B:b.txt')],state);
  const target=motion=>({sceneUrl:`${motion}.txt`,sentenceList:[say(),figure('existing'),say(),
    figure('same',{left:true,motion,next:true}),figure('same',{right:true,motion,expression:'smile',next:true}),say(),
    figure('far'),say()]});
  const branches=['a','b'].map((name,index)=>planGltfChoiceBranch(base,index,target(name),state,'visit'));
  const merged=mergeGltfBranchPlans(base,branches);
  assert.deepEqual(merged.requests.map(r=>[r.url,r.motion,r.expression]),[
    ['game/same/config.json','a',''],['game/same/config.json','b',''],
    ['game/same/config.json','a','smile'],['game/same/config.json','b','smile'],
  ]);
  assert.equal(new Set(merged.requests.map(r=>r.preloadId)).size,4);
});

test('nested choice or cycles stop after one edge and branch lookahead stays bounded', () => {
  const scene={sceneUrl:'test',sentenceList:[sentence(C.label,'again'),sentence(C.choose,'Loop:again'),figure('wrong')]};
  const first=plan(scene.sentenceList);
  const branch=planGltfChoiceBranch(first,0,scene,empty(),'visit');
  assert.equal(branch.requests.length,0);assert.equal(branch.choice,undefined);
  const limited=plan([say(),sentence(C.choose,'A:a.txt')],empty(),0,3);
  assert.equal(planGltfChoiceBranch(limited,0,{sceneUrl:'a.txt',sentenceList:[say(),figure('late')]},empty(),'visit').requests.length,0);
});

test('late choice scene fetch cannot overwrite a newer plan, and rejected fetch retries', async () => {
  let state=empty();const calls=[];const pending=[];let fetches=0;
  const sceneA={sceneUrl:'a',sentenceList:[sentence(C.choose,'A:a.txt')]};
  state.PerformList=[{id:'choose',script:sceneA.sentenceList[0]}];
  const mocks={
    '@/Core/WebGAL':{WebGAL:{stageWidth:800,stageHeight:600}},
    '@/Core/Modules/stage/stageStateManager':{stageStateManager:{getViewStageState:()=>state}},
    '@/Core/controller/stage/pixi/gltfCharacter':{setGltfPreloadRequests:async r=>{calls.push(r)},preloadGltfNamedResources:async()=>{}},
    '@/Core/util/logger':{logger:{warn:()=>{}}},
    '@/Core/util/prefetcher/assetsPrefetcher':{assetsPrefetcher:()=>{}},
    './scenePrefetcher':{scenePrefetcher:()=>{}},
    '@/Core/controller/scene/sceneFetcher':{sceneFetcher:()=>{fetches++;return new Promise((resolve,reject)=>pending.push({resolve,reject}))}},
    '@/Core/parser/sceneParser':{sceneParser:()=>({sceneUrl:'a.txt',sentenceList:[figure('branch'),say()]})},
  };
  const {prefetchSceneByProgress}=load('Core/util/prefetcher/progressPrefetcher.ts',mocks);
  const flush=()=>new Promise(resolve=>setImmediate(resolve));
  prefetchSceneByProgress(sceneA,1);await flush();assert.equal(fetches,1);
  state=empty();prefetchSceneByProgress({sceneUrl:'new',sentenceList:[figure('new'),say()]},0);
  pending[0].resolve('old');await flush();
  assert.deepEqual(calls.at(-1).map(r=>r.url),['game/new/config.json']);
  state.PerformList=[{id:'choose',script:sceneA.sentenceList[0]}];
  prefetchSceneByProgress(sceneA,1);await flush();pending[1].reject(new Error('temporary'));await flush();
  prefetchSceneByProgress(sceneA,1);await flush();assert.equal(fetches,3);
  pending[2].resolve('success');await flush();
  assert.deepEqual(calls.at(-1).map(r=>r.url),['game/branch/config.json']);
});

test('deterministic scene transitions prepare the first new batch with the destination visit identity', () => {
  const state=empty();state.figNameLeft='game/existing/config.json';
  const base=plan([figure('before',{right:true}),say(),sentence(C.changeScene,'next.txt'),figure('unreachable')],state);
  assert.equal(base.transition.target,'next.txt');
  const target={sceneUrl:'next.txt',sentenceList:[say(),figure('existing',{left:true}),say(),
    figure('same',{id:'one',next:true}),figure('same',{id:'two',next:true}),say(),figure('later'),say()]};
  const next=planGltfSceneTransition(base,target,state,'2:next.txt');
  assert.deepEqual(next.requests.map(r=>r.url),['game/same/config.json','game/same/config.json']);
  assert.equal(new Set(next.requests.map(r=>r.preloadId)).size,2);
  assert.ok(next.requests.every(r=>JSON.parse(r.preloadId)[0]==='2:next.txt'));
  assert.deepEqual(mergeGltfBranchPlans(base,[next]).requests.map(r=>r.url),
    ['game/before/config.json','game/same/config.json','game/same/config.json']);
  assert.deepEqual(next.requests,planGltfPreloads(target,0,state,'2:next.txt',20,base.transition.figures,false,true).requests);
});

test('scene transition lookahead has a budget and stops at dynamic conditions, labels and another edge', () => {
  for(const edge of [sentence(C.changeScene,'{target}'),sentence(C.changeScene,'next.txt',{when:'flag'}),
    sentence(C.callScene,'next.txt')]) assert.equal(plan([edge]).transition,undefined);
  const limited=plan([say(),sentence(C.changeScene,'next.txt')],empty(),0,2);
  assert.equal(planGltfSceneTransition(limited,{sceneUrl:'next.txt',sentenceList:[figure('late')]},empty(),'2:next.txt'),undefined);
  const base=plan([sentence(C.changeScene,'next.txt')]);
  const next=planGltfSceneTransition(base,{sceneUrl:'next.txt',sentenceList:[sentence(C.changeScene,'again.txt'),figure('wrong')]},empty(),'2:next.txt');
  assert.equal(next.requests.length,0);assert.equal(next.transition,undefined);
});

test('transition fetches deduplicate, publish bounded first batch, survive progress and discard stale restores', async () => {
  let state=empty();const calls=[];const pending=[];const fetchUrls=[];
  const tail={sceneUrl:'tail.txt',sentenceList:[say(),sentence(C.changeScene,'next.txt')]};
  const target={sceneUrl:'next.txt',sentenceList:[figure('a',{left:true,next:true}),figure('b',{right:true,next:true}),say(),figure('later')]};
  const mocks={
    '@/Core/WebGAL':{WebGAL:{stageWidth:800,stageHeight:600}},
    '@/Core/Modules/stage/stageStateManager':{stageStateManager:{getViewStageState:()=>state}},
    '@/Core/controller/stage/pixi/gltfCharacter':{setGltfPreloadRequests:async r=>{calls.push(r)},preloadGltfNamedResources:async()=>{}},
    '@/Core/util/logger':{logger:{warn:()=>{}}},
    '@/Core/util/prefetcher/assetsPrefetcher':{assetsPrefetcher:()=>{}},
    './scenePrefetcher':{scenePrefetcher:()=>{}},
    '@/Core/controller/scene/sceneFetcher':{sceneFetcher:url=>{fetchUrls.push(url);return new Promise((resolve,reject)=>pending.push({resolve,reject}))}},
    '@/Core/parser/sceneParser':{sceneParser:()=>target},
  };
  const {prefetchSceneByProgress}=load('Core/util/prefetcher/progressPrefetcher.ts',mocks);
  const flush=()=>new Promise(resolve=>setImmediate(resolve));
  prefetchSceneByProgress(tail,0);await flush();
  prefetchSceneByProgress(tail,1);await flush();assert.deepEqual(fetchUrls,['next.txt']);
  pending[0].resolve('target');await flush();
  assert.deepEqual(calls.at(-1).map(r=>r.url),['game/a/config.json','game/b/config.json']);
  const predictedIds=calls.at(-1).map(r=>r.preloadId);
  prefetchSceneByProgress(target,0);
  assert.deepEqual(calls.at(-1).slice(0,2).map(r=>r.preloadId),predictedIds);
  prefetchSceneByProgress(tail,0);await flush();assert.equal(fetchUrls.length,2);
  pending[1].reject(new Error('retry'));await flush();
  prefetchSceneByProgress(tail,0);await flush();assert.equal(fetchUrls.length,3);
  prefetchSceneByProgress({sceneUrl:'restored',sentenceList:[]},0);
  pending[2].resolve('obsolete');await flush();assert.deepEqual(calls.at(-1),[]);
});
test('progress warms only the next new group while retaining named fetch lookahead', () => {
  const warmed=[], fetched=[];
  const mocks={
    '@/Core/WebGAL':{WebGAL:{stageWidth:800,stageHeight:600}},
    '@/Core/Modules/stage/stageStateManager':{stageStateManager:{getViewStageState:empty}},
    '@/Core/controller/stage/pixi/gltfCharacter':{setGltfPreloadRequests:async r=>fetched.push(r),preloadGltfNamedResources:async()=>{}},
    '@/Core/controller/stage/pixi/gltfSceneResidency':{prewarmGltfPredictions:async batches=>warmed.push(batches)},
    '@/Core/util/logger':{logger:{warn:()=>{}}},
    '@/Core/util/prefetcher/assetsPrefetcher':{assetsPrefetcher:()=>{}},
    './scenePrefetcher':{scenePrefetcher:()=>{}},
  };
  const {prefetchSceneByProgress}=load('Core/util/prefetcher/progressPrefetcher.ts',mocks);
  prefetchSceneByProgress({sceneUrl:'test',sentenceList:[say(),figure('a',{left:true,next:true}),figure('b',{right:true,next:true}),say(),figure('c'),say()]},0);
  assert.deepEqual(warmed[0].map(batch=>batch.map(item=>item.figure.url)),[['game/a/config.json','game/b/config.json']]);
  assert.equal(fetched[0].length,3,'lightweight fetching can look farther than GPU preparation');
});
test('GPU choice lookahead includes at most the first new group of each of two branches', () => {
  const {planGltfBackgroundBatches}=load('Core/util/prefetcher/gltfPrefetchPlan.ts');
  const state=empty(), base=plan([sentence(C.choose,'A:a.txt|B:b.txt')]);
  const branches=['a','b'].map((name,index)=>planGltfChoiceBranch(base,index,{sceneUrl:name+'.txt',sentenceList:[say(),figure(name),say(),figure('far'),say()]},state,'visit'));
  assert.deepEqual(planGltfBackgroundBatches(base,branches).map(batch=>batch.map(item=>item.figure.url)),[['game/a/config.json'],['game/b/config.json']]);
});
