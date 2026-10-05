const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const test = require('node:test');
const ts = require('typescript');
const { Ticker } = require('@pixi/ticker');

const filename = path.resolve(__dirname, '../src/Core/controller/stage/pixi/PixiController.ts');
const source = ts.createSourceFile(filename, fs.readFileSync(filename, 'utf8'), ts.ScriptTarget.Latest, true);
let method;
function visit(node) {
  if (ts.isMethodDeclaration(node) && node.name.getText(source) === 'addGltfFigure') method = node.getText(source);
  ts.forEachChild(node, visit);
}
visit(source);
assert.ok(method);
// Execute the complete production method with a real Pixi ticker. Only rendering
// resources and the surrounding stage are stand-ins; listener wiring is unmodified.
const compiled = ts.transpileModule(`class Stage { ${method} }`, {
  compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS },
}).outputText;
const makeStage = new Function('PIXI', 'WebGALPixiContainer', 'uuid', 'stageStateManager',
  'createGltfCharacter', 'GltfCharacterSprite', 'baseBlinkParam', 'logger', 'takePreparedGltfCharacter', 'normalizeFigureBounds', 'baseFocusParam', compiled + '\nreturn Stage;');
const flush = () => new Promise(resolve => setImmediate(resolve));
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function fixture(t) {
  const ticker = new Ticker(), loads = [], errors = [], events = [];
  const state={live2dMotion: [], live2dExpression: [], live2dBlink: [], live2dFocus: []};
  let id = 0;
  class Container extends EventEmitter {}
  const Stage = makeStage({ BaseTexture: class {}, Texture: class { constructor() {
    return { baseTexture: { update() { events.push('upload'); } }, destroy() { events.push('texture-dispose'); } };
  } } }, Container, () => String(++id), { getViewStageState: () => state },
  () => { const load = deferred(); loads.push(load); return load.promise; },
  class Sprite { width = 1; height = 1; }, {}, { error: (...args) => errors.push(args) }, () => undefined, bounds => bounds ?? [0,0,0,0], {x:0,y:0,instant:false});
  const stage = new Stage();
  Object.assign(stage, { currentApp: { ticker }, figureObjects: [], stageWidth: 100, stageHeight: 100,
    figureContainer: { addChild() {} }, applyFigureMetadata() {}, getCurrentMouthValue: () => null,
    getStageObjByUuid(uuid) { return this.figureObjects.find(object => object.uuid === uuid); },
    removeStageObjectByKey(key) {
      const object = this.figureObjects.find(item => item.key === key);
      if (!object) return;
      object.disposeGltf?.();
      this.figureObjects = this.figureObjects.filter(item => item !== object);
    }, setContainerInitialPosition() {}, notifyTargetReferenceBoxChanged() {}, requestRender() {},
  });
  const runtime = (name, preparation = Promise.resolve()) => ({
    isActive: true, canvas: {}, setMotion() {}, setExpression() {}, setBlinkParameters() {}, setMouth() {}, setFocus() {},
    prepare: () => preparation,
    update(delta) { events.push(['update', name, delta]); }, dispose() { events.push(['dispose', name]); },
  });
  t.after(() => { for (const object of [...stage.figureObjects]) object.disposeGltf?.(); ticker.destroy(); });
  const tick = () => { if (ticker.lastTime < 0) ticker.lastTime = 0; ticker.update(ticker.lastTime + 20); };
  return { stage, ticker, loads, events, errors, runtime, tick, state };
}

test('first uploaded canvas applies Focus received while the actor was loading',async t=>{
  const f=fixture(t),actor=f.runtime('a');
  actor.setFocus=value=>f.events.push(['focus',{...value}]);
  f.stage.addGltfFigure('a','a');
  f.state.live2dFocus=[{target:'a',focus:{x:1,y:-.5,instant:true}}];
  f.loads[0].resolve(actor);await flush();
  assert.deepEqual(f.events.slice(0,3),[
    ['focus',{x:1,y:-.5,instant:true}],['update','a',0],'upload',
  ]);
});

test('prepared actors attach one update listener each and remove it with the instance', async t => {
  const f = fixture(t), prep = deferred();
  f.stage.addGltfFigure('a', 'a'); f.stage.addGltfFigure('b', 'b');
  f.loads[0].resolve(f.runtime('a', prep.promise)); f.loads[1].resolve(f.runtime('b', prep.promise));
  await flush(); assert.equal(f.ticker.count, 0);
  prep.resolve(); await flush(); assert.equal(f.ticker.count, 2);
  f.events.length = 0; f.tick();
  assert.deepEqual(f.events, [['update', 'a', .02], 'upload', ['update', 'b', .02], 'upload']);
  f.stage.removeStageObjectByKey('a'); assert.equal(f.ticker.count, 1);
  f.stage.removeStageObjectByKey('b'); assert.equal(f.ticker.count, 0);
});

for (const loss of ['removed', 'missing', 'failed']) test(`${loss} during prepare never attaches an update listener`, async t => {
  const f = fixture(t), prep = deferred();
  f.stage.addGltfFigure('a', 'a');
  f.loads[0].resolve(f.runtime('a', prep.promise)); await flush();
  if (loss === 'removed') f.stage.removeStageObjectByKey('a');
  if (loss === 'missing') f.stage.figureObjects = [];
  if (loss === 'failed') prep.reject(new Error('GPU preparation failed'));
  else prep.resolve();
  await flush();
  assert.equal(f.ticker.count, 0);
  assert.equal(f.events.filter(event => Array.isArray(event) && event[0] === 'dispose').length, 1);
  assert.equal(f.events.some(event => Array.isArray(event) && event[0] === 'update'), false);
});

test('update failure removes the listener of only the failed instance', async t => {
  const f = fixture(t);
  f.stage.addGltfFigure('a', 'a'); f.stage.addGltfFigure('b', 'b');
  const broken = f.runtime('a'); broken.update = delta => { if (delta > 0) throw new Error('update failed'); };
  f.loads[0].resolve(broken); f.loads[1].resolve(f.runtime('b')); await flush();
  f.events.length = 0; f.tick();
  assert.equal(f.ticker.count, 1);
  assert.deepEqual(f.stage.figureObjects.map(object => object.key), ['b']);
  assert.equal(f.events.filter(event => Array.isArray(event) && event[0] === 'dispose' && event[1] === 'a').length, 1);
  assert.ok(f.events.some(event => Array.isArray(event) && event[0] === 'update' && event[1] === 'b'));
  f.events.length = 0; f.tick();
  assert.deepEqual(f.events, [['update', 'b', .02], 'upload']);
});
