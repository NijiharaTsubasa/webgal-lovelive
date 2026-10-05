const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const ts = require('typescript');

const filename = path.resolve(__dirname, '../src/Core/controller/stage/pixi/PixiController.ts');
const source = ts.createSourceFile(filename, fs.readFileSync(filename, 'utf8'), ts.ScriptTarget.Latest, true);
const methods = [];
function visit(node) {
  if (ts.isMethodDeclaration(node) && ['updateTickerStatus', 'requestRender'].includes(node.name.getText(source))) {
    methods.push(node.getText(source));
  }
  ts.forEachChild(node, visit);
}
visit(source);
const compiled = ts.transpileModule(`class Stage { ${methods.join('\n')} }`, {
  compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS },
}).outputText;

function fixture() {
  let showTitle = false;
  const frames = [];
  const Stage = new Function('webgalStore', 'logger', 'requestAnimationFrame', compiled + '\nreturn Stage;')(
    { getState: () => ({ GUI: { showTitle } }) }, { debug() {} }, callback => frames.push(callback),
  );
  const stage = new Stage();
  let renders = 0;
  const ticker = { started: true, start() { this.started = true; }, stop() { this.started = false; } };
  Object.assign(stage, {
    currentApp: { ticker, render() { renders++; } }, stageAnimations: [],
    figureObjects: [{ sourceType: 'gltf' }, { sourceType: 'live2d' }], backgroundObjects: [],
  });
  return { stage, ticker, frames, title(value) { showTitle = value; }, renders: () => renders };
}

test('title suspends dynamic stage ticker and returning to gameplay resumes it', async () => {
  const f = fixture();
  f.title(true);
  f.stage.updateTickerStatus();
  await Promise.resolve();
  assert.equal(f.ticker.started, false);
  assert.equal(f.renders(), 0);
  // An actor completing its asynchronous load while on the title cannot restart it.
  f.stage.updateTickerStatus();
  await Promise.resolve();
  assert.equal(f.ticker.started, false);
  f.title(false);
  f.stage.updateTickerStatus();
  await Promise.resolve();
  assert.equal(f.ticker.started, true);
});

test('a queued one-shot render does not draw underneath the title', () => {
  const f = fixture();
  f.ticker.stop();
  f.stage.requestRender();
  f.title(true);
  f.frames.shift()();
  assert.equal(f.renders(), 0);
  f.title(false);
  f.stage.requestRender();
  f.frames.shift()();
  assert.equal(f.renders(), 1);
});
