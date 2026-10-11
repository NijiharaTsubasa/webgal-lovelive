const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const test = require('node:test');
const ts = require('typescript');

test('residency options and direct display share portrait framing and canvas footprint', async () => {
  const filename = path.resolve(__dirname, '../src/Core/Modules/gltf/gltfCharacter.ts');
  const source = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  const calls = [];
  const OffscreenCharacter = {
    create: async options => { calls.push(options); return {}; },
  };
  const loaded = new Module(filename, module);
  loaded.paths = Module._nodeModulePaths(path.dirname(filename));
  let component = {group:'llas',name:'ch0109_co0002_member'};
  const catalog = {indexUrl:'http://localhost/game/3d/runtime/index.json',load:async()=>catalog,
    model:async()=>({component})};
  loaded.require = name => name === '@/store/store' ? {webgalStore:{getState:()=>({userData:{optionData:{meshClothEnabled:false}}})}} : name === 'webgal-lovelive-gltf-renderer'
    ? { OffscreenCharacter } : name === './fixedGltfResources'
      ? {fixedGltfResources:()=>catalog,resolveFigureConfig:async url=>({url:new URL(url,document.baseURI).href,gltf:true})}
      : Module.prototype.require.call(loaded, name);
  loaded._compile(source, filename);
  const previous = global.document;
  global.document = { baseURI: 'http://localhost/' };
  try {
    const api = loaded.exports;
    calls.push(await api.characterOptions('game/figure/ruby/config.json', 2560, 1440));
    await api.createGltfCharacter('game/figure/ruby/config.json', 2560, 1440);
    assert.deepEqual(calls[0], calls[1]);
    assert.equal(calls[0].width, 1080);
    assert.equal(calls[0].height, 1440);
    assert.equal(calls[0].framing.viewHeight, 1.36 / 1.18);
    assert.equal(calls[0].framing.centerY, 1.195);
    assert.equal(calls[0].framing.groupOffsets.llas, (50 / 1800) * (1.36 / 1.18));
    component = {group:'yohane',name:'CH_yohane_normal01'};
    const yohane = await api.characterOptions('game/3d/figure/yohane/config.json',2560,1440);
    assert.equal(yohane.framing.viewHeight, 1.36 / 1.18);
    assert.equal(yohane.framing.centerY, 1.16);
    component = {group:'yohane',name:'CH_ruby_fairy01'};
    const ruby = await api.characterOptions('game/3d/figure/ruby/config.json',2560,1440);
    assert.equal(ruby.framing.viewHeight, yohane.framing.viewHeight);
    assert.equal(ruby.framing.centerY, 1.06);
    // Costume changes keep one character's framing; asset folder names do not select it.
    component = {group:'yohane',name:'CH_ruby_swimsuit01'};
    const swimsuit = await api.characterOptions('renamed/config.json',2560,1440);
    assert.deepEqual(swimsuit.framing,ruby.framing);
    component = {group:'hasunosora',name:'3d_costume_1001101201'};
    const kaho = await api.characterOptions('other/config.json',2560,1440);
    assert.deepEqual(kaho.framing,calls[0].framing);
  } finally { global.document = previous; }
});
