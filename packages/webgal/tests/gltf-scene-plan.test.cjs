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

const { planGltfSceneResidency } = load('Core/Modules/gltf/gltfScenePlan.ts');
const { commandType: C } = load('Core/controller/scene/sceneInterface.ts');
const empty = () => ({figName:'',figNameLeft:'',figNameRight:'',figNameLeft13:'',figNameRight13:'',figNameLeft14:'',figNameRight14:'',freeFigure:[],live2dMotion:[],live2dExpression:[]});
const sentence = (command, content='', args={}) => ({command,content,args:Object.entries(args).map(([key,value])=>({key,value})),sentenceAssets:[],subScene:[],isLineBreakHolder:false});
const figure = (name,args={}) => sentence(C.changeFigure,name ? `game/${name}/config.json` : '',args);
const say = () => sentence(C.say,'pause');
const scene = list => ({sceneUrl:'test.txt',sentenceList:list});
const plan = (list,state=empty()) => planGltfSceneResidency(scene(list),state);
const names = result => new Set([...result.appearances.values()].map(item => item.figure.url));

test('scene discovery continues across variables and user input without executing scripts', () => {
 const state=empty(); const result=plan([sentence(C.setVar,'throw new Error("must not execute")'),figure('a',{next:true}),say(),sentence(C.getUserInput,'answer'),figure('b',{right:true,next:true}),say()],state);
 assert.equal(result.capacity,2); assert.equal(names(result).size,2); assert.equal(state.figName,''); assert.equal(result.truncated,false);
});
test('static label jumps skip unreachable references and preserve pending next figures', () => {
 const result=plan([figure('a',{next:true}),sentence(C.jumpLabel,'good'),figure('unreachable'),sentence(C.label,'good'),say()]);
 assert.deepEqual([...names(result)],['game/a/config.json']); assert.equal(result.capacity,1);
});
test('single-choice labels traverse the remaining scene rather than only one visible batch', () => {
 const result=plan([sentence(C.choose,'Start:begin'),figure('unreachable'),sentence(C.label,'begin'),figure('a'),say(),figure('b'),say()]);
 assert.deepEqual([...names(result)].sort(),['game/a/config.json','game/b/config.json']); assert.equal(result.capacity,1);
});
test('two choice paths have independent stage and slot states', () => {
 const result=plan([figure('base',{left:true,next:true}),say(),sentence(C.choose,'L:left|R:right'),sentence(C.label,'left'),figure('b',{right:true,next:true}),say(),sentence(C.jumpLabel,'end'),sentence(C.label,'right'),figure('c',{next:true}),say(),sentence(C.label,'end'),sentence(C.end)]);
 assert.equal(result.capacity,2); assert.equal(names(result).size,3);
 assert.ok(!result.batches.some(batch => batch.some(x=>x.figure.url==='game/b/config.json')&&batch.some(x=>x.figure.url==='game/c/config.json')));
});
test('unknown conditional jumps explore fallthrough and label target', () => {
 const result=plan([sentence(C.setVar,'score=1'),sentence(C.jumpLabel,'yes',{when:'score>0'}),figure('no'),sentence(C.jumpLabel,'done'),sentence(C.label,'yes'),figure('yes'),sentence(C.label,'done'),sentence(C.end)]);
 assert.deepEqual([...names(result)].sort(),['game/no/config.json','game/yes/config.json']); assert.equal(result.capacity,1);
});
test('conditional figure statements explore both outcomes without merging stages', () => {
 const result=plan([figure('base',{left:true,next:true}),say(),figure('maybe',{right:true,when:'flag'}),say()]);
 assert.equal(result.capacity,2); assert.ok(result.batches.some(batch=>batch.length===1)); assert.ok(result.batches.some(batch=>batch.length===2));
});
test('dynamic appearances retain runtime gate but do not hide later static references', () => {
 const result=plan([figure('a'),sentence(C.changeFigure,'{selected}/config.json',{id:'dynamic',next:true}),figure('b',{right:true,next:true}),say()]);
 assert.deepEqual([...names(result)].sort(),['game/a/config.json','game/b/config.json']); assert.deepEqual(result.runtimeGateLines,[1]);
 assert.equal(result.canRelease,false); assert.ok([...result.appearances.values()].every(item=>item.lastUse===Infinity));
});
test('static model with dynamic motion prepares default model and never fetches guessed motion', () => {
 const result=plan([figure('a',{motion:'{motion}',expression:'smile'}),say()]);
 assert.equal(result.appearances.size,1); assert.deepEqual(result.named,[{kind:'expression',name:'smile'}]); assert.deepEqual(result.runtimeGateLines,[0]);
});
test('scene edges do not prepare the next scene or unreachable local tail', () => {
 for(const edge of [sentence(C.changeScene,'next.txt'),sentence(C.return),sentence(C.end),sentence(C.choose,'Next:next.txt')]) {
  const result=plan([figure('a'),edge,figure('not-reachable')]); assert.deepEqual([...names(result)],['game/a/config.json']);
 }
});
test('next batches retain only final figures and preserve named commands on surviving models', () => {
 const result=plan([figure('a',{next:true}),figure('b',{next:true,motion:'one'}),say(),figure('b',{next:true,motion:'two'}),say()]);
 assert.deepEqual([...names(result)],['game/b/config.json']); assert.deepEqual(result.named.map(x=>x.name).sort(),['one','two']);
});
test('bounded visits terminate backward cycles and prevent lexical last-use release', () => {
 const result=plan([sentence(C.label,'loop'),figure('a'),sentence(C.jumpLabel,'loop')]);
 assert.equal(result.capacity,1); assert.equal(result.canRelease,false); assert.equal(result.truncated,false); assert.equal([...result.appearances.values()][0].lastUse,Infinity);
});
test('lifetimes move between contexts rather than requiring three contexts for pairwise overlap', () => {
 const result=plan([figure('a',{id:'a',next:true}),figure('b',{id:'b',next:true}),say(),figure('',{id:'a',next:true}),figure('c',{id:'c',next:true}),say(),figure('',{id:'b',next:true}),figure('a',{id:'a',next:true}),say()]);
 assert.equal(result.capacity,2); assert.equal(result.appearances.size,4);
 assert.deepEqual([...result.appearances.values()].filter(x=>x.key==='a').map(x=>x.slot).sort(),[0,1]);
});
test('forward-only suffix reports when a temporary high slot is never used again', () => {
 const result=plan([figure('a',{left:true,next:true}),figure('b',{right:true,next:true}),say(),figure('',{right:true,next:true}),say(),say()]);
 assert.equal(result.canRelease,true); assert.equal(result.slotLastUse.get(1),2); assert.equal(result.slotLastUse.get(0),5);
});
