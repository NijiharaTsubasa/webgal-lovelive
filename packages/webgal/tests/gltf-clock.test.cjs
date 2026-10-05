const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const ts = require('typescript');
const { Ticker } = require('@pixi/ticker');

// Execute the actual glTF tick closure without loading the full browser stage.
const filename = path.resolve(__dirname, '../src/Core/controller/stage/pixi/PixiController.ts');
const source = ts.createSourceFile(filename, fs.readFileSync(filename, 'utf8'), ts.ScriptTarget.Latest, true);
let tickExpression;
function visit(node) {
  if (ts.isMethodDeclaration(node) && node.name.getText(source) === 'addGltfFigure') {
    for (const statement of node.body.statements) {
      if (!ts.isVariableStatement(statement)) continue;
      for (const declaration of statement.declarationList.declarations) {
        if (declaration.name.getText(source) === 'tick') tickExpression = declaration.initializer.getText(source);
      }
    }
  }
  ts.forEachChild(node, visit);
}
visit(source);
assert.ok(tickExpression, 'glTF ticker callback must exist');
const makeTick = new Function('app', 'runtime', 'texture', 'disposed', 'fail', `return ${tickExpression};`);

test('glTF consumes uncapped Pixi elapsed time and speed without changing other ticker listeners', () => {
  for (const speed of [0, .5, 1, 2, -1]) {
    const ticker = new Ticker(), animation = [], other = [];
    let uploads = 0;
    ticker.speed = speed;
    ticker.add(makeTick({ ticker }, { isActive: true, update(delta) { animation.push(delta); } },
      { baseTexture: { update() { uploads++; } } }, false));
    ticker.add(() => other.push(ticker.deltaMS));
    ticker.lastTime = 0;
    ticker.update(250);
    assert.deepEqual(animation, [.25 * speed]);
    assert.deepEqual(other, [100 * speed]);
    assert.equal(uploads, 1);
    ticker.destroy();
  }
});

test('restarting the Pixi ticker resets its clock instead of counting time spent stopped', t => {
  const beforeRequest = Object.getOwnPropertyDescriptor(globalThis, 'requestAnimationFrame');
  const beforeCancel = Object.getOwnPropertyDescriptor(globalThis, 'cancelAnimationFrame');
  Object.defineProperty(globalThis, 'requestAnimationFrame', { configurable: true, value: () => 1 });
  Object.defineProperty(globalThis, 'cancelAnimationFrame', { configurable: true, value: () => {} });
  t.after(() => {
    if (beforeRequest) Object.defineProperty(globalThis, 'requestAnimationFrame', beforeRequest);
    else delete globalThis.requestAnimationFrame;
    if (beforeCancel) Object.defineProperty(globalThis, 'cancelAnimationFrame', beforeCancel);
    else delete globalThis.cancelAnimationFrame;
  });
  const ticker = new Ticker(), animation = [];
  ticker.add(makeTick({ ticker }, { isActive: true, update(delta) { animation.push(delta); } },
    { baseTexture: { update() {} } }, false));
  try {
    ticker.start(); ticker.stop();
    ticker.lastTime -= 5000;
    const before = performance.now();
    ticker.start();
    assert.ok(ticker.lastTime >= before);
    ticker.update(ticker.lastTime + 20);
    assert.ok(Math.abs(animation[0] - .02) < 1e-10);
  } finally { ticker.destroy(); }
});
