const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const test = require('node:test');
const ts = require('typescript');
const PIXI = require('pixi.js');

function loadSource(relative, imports = {}) {
  const filename = path.resolve(__dirname, relative);
  const compiled = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  const sourceModule = new Module(filename, module);
  sourceModule.filename = filename;
  sourceModule.paths = Module._nodeModulePaths(path.dirname(filename));
  sourceModule.require = (name) => imports[name] ?? Module.prototype.require.call(sourceModule, name);
  sourceModule._compile(compiled, filename);
  return sourceModule.exports;
}
const stageInterface = loadSource('../src/Core/Modules/stage/stageInterface.ts');
const { GltfCharacterSprite } = loadSource('../src/Core/controller/stage/pixi/GltfCharacterSprite.ts', {
  '@/Core/Modules/stage/stageInterface': stageInterface,
});

function texture() {
  return new PIXI.Texture(new PIXI.BaseTexture(null, { width: 200, height: 300 }));
}
function rectValues(rect) {
  return [rect.x, rect.y, rect.width, rect.height];
}

test('no bounds preserves Sprite geometry, reference bounds, and dimensions', () => {
  const input = texture();
  const plain = new PIXI.Sprite(input);
  const actor = new GltfCharacterSprite(input);
  for (const sprite of [plain, actor]) {
    sprite.anchor.set(0.5);
    sprite.scale.set(1.2, 0.8);
    sprite.pivot.set(7, 11);
    sprite.position.set(400, 240);
    sprite.rotation = 0.2;
  }
  assert.deepEqual(rectValues(actor.getLocalBounds()), rectValues(plain.getLocalBounds()));
  assert.deepEqual(rectValues(actor.getBounds()), rectValues(plain.getBounds()));
  assert.equal(actor.width, plain.width);
  assert.equal(actor.height, plain.height);
  actor.calculateVertices();
  plain.calculateVertices();
  assert.deepEqual(actor.vertexData, plain.vertexData);
});

test('equal endpoint sums still produce different reference sizes and fitting scales', () => {
  const first = new GltfCharacterSprite(texture(), [10, 20, 30, 40]);
  const second = new GltfCharacterSprite(texture(), [0, 0, 40, 60]);
  assert.deepEqual(rectValues(first.getLocalBounds()), [10, 20, 220, 320]);
  assert.deepEqual(rectValues(second.getLocalBounds()), [0, 0, 240, 360]);
  const fit = (sprite) => Math.min(1920 / sprite.width, 1080 / sprite.height);
  assert.notEqual(fit(first), fit(second));
  for (const sprite of [first, second]) {
    sprite.anchor.set(0.5);
    sprite.pivot.set(20, 30);
    sprite.calculateVertices();
  }
  // Reference bounds change without cropping or changing the drawable quad.
  assert.deepEqual(first.vertexData, second.vertexData);
  assert.deepEqual(rectValues(first.getLocalBounds()), [-90, -130, 220, 320]);
  assert.deepEqual(rectValues(second.getLocalBounds()), [-100, -150, 240, 360]);
  assert.notDeepEqual(rectValues(first.getBounds()), rectValues(second.getBounds()));
});

test('negative scale and size setters measure the adapted reference bounds', () => {
  const actor = new GltfCharacterSprite(texture(), [-10, -20, 30, 40]);
  actor.scale.set(-2, -3);
  assert.equal(actor.width, 480);
  assert.equal(actor.height, 1080);
  actor.width = 120;
  actor.height = 180;
  assert.equal(actor.scale.x, -0.5);
  assert.equal(actor.scale.y, -0.5);
  assert.equal(actor.width, 120);
  assert.equal(actor.height, 180);
});

test('every preset position uses scaled reference width or its stage fraction', () => {
  const actor = new GltfCharacterSprite(texture(), [10, 20, 30, 40]);
  actor.scale.set(2, 2);
  const expected = {
    center: 960,
    left: 220,
    right: 1700,
    left13: 640,
    right13: 1280,
    left14: 480,
    right14: 1440,
  };
  assert.deepEqual(Object.keys(expected), [...stageInterface.FIGURE_POSITIONS]);
  for (const [position, baseX] of Object.entries(expected)) {
    assert.equal(actor.getBaseX(position, 1920), baseX, position);
  }
  const second = new GltfCharacterSprite(texture(), [0, 0, 40, 60]);
  second.scale.set(2, 2);
  assert.equal(second.getBaseX('left', 1920), 240);
  assert.equal(second.getBaseX('right', 1920), 1680);
});
