const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const test = require('node:test');
const ts = require('typescript');

function fixture(t) {
  let calculation = { showName: '', figureAssociatedAnimation: [] };
  let view = { ...calculation, currentDialogKey: 'old' };
  const writes = [], frames = new Map();
  let sequence = 0;
  let now = 1000;
  const oldNow = Date.now;
  Date.now = () => now;
  const oldRAF = global.requestAnimationFrame, oldCancel = global.cancelAnimationFrame;
  global.requestAnimationFrame = callback => { frames.set(++sequence, callback); return sequence; };
  global.cancelAnimationFrame = id => frames.delete(id);
  t.after(() => { global.requestAnimationFrame = oldRAF; global.cancelAnimationFrame = oldCancel; Date.now = oldNow; });
  const stage = { getCalculationStageState: () => calculation, getViewStageState: () => view,
    setStage: (key, value) => { calculation[key] = value; } };
  const mocks = {
    './vocal': { playVocal() { throw Error('unexpected vocal'); } },
    '@/store/store': { webgalStore: { getState: () => ({ userData: { optionData: { voiceInterruption: 0, textSpeed: 1 } } }) } },
    '@/hooks/useTextOptions': { useTextAnimationDuration: () => 0, useTextDelay: () => 10 },
    '@/Core/Modules/perform/performController': { getRandomPerformName: () => 'say-test' },
    '@/Core/util/getSentenceArg': { getBooleanArgByKey: () => false, getFigurePositionFromArgs: () => 'center',
      getStringArgByKey: (_, key) => key === 'figureId' ? 'actor' : null },
    '@/store/userDataInterface': { voiceOption: { no: 0 }, textSize: {} },
    '@/Core/WebGAL': { WebGAL: { flowchartManager: { requestUnlockCurrentScene() {} },
      events: { textSettle: { emit() {} } }, gameplay: { performController: { unmountPerform() {} },
        pixiStage: { setModelMouthY: (...args) => writes.push(args), resetMouthY: key => writes.push(['reset', key]) } } } },
    '@/Stage/TextBox/TextBox': { compileSentence: text => [text] },
    '@/Core/Modules/stage/stageStateManager': { stageStateManager: stage },
  };
  const filename = path.resolve(__dirname, '../src/Core/gameScripts/say.ts');
  const loaded = new Module(filename, module);
  loaded.require = name => mocks[name] ?? require(name);
  loaded._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020,
  } }).outputText, filename);
  return { say: () => loaded.exports.say({ content: 'Next dialogue', args: [] }), writes, frames,
    frame: () => { now += 100; const [id, callback] = [...frames.entries()][0]; frames.delete(id); callback(); },
    commit: () => { view = structuredClone(calculation); }, changeDialog: () => { view.currentDialogKey = 'newer'; } };
}

test('pending dialogue cannot animate the visible old actor; mouth starts only after commit', t => {
  const f = fixture(t), perform = f.say();
  assert.deepEqual(f.writes, []);
  assert.equal(f.frames.size, 0);
  f.commit(); perform.startFunction();
  f.frame();
  assert.ok(f.writes.length > 0);
  assert.equal(f.frames.size, 1);
  perform.stopFunction();
  assert.equal(f.frames.size, 0, 'stopped dialogue cannot keep applying mouth frames to a replacement');
  assert.deepEqual(f.writes.at(-1), ['reset', 'actor']);
});

test('a stale mouth frame cannot write after another dialogue takes over', t => {
  const f = fixture(t), perform = f.say();
  f.commit(); perform.startFunction();
  const callback = [...f.frames.values()][0], count = f.writes.length;
  f.changeDialog(); callback();
  assert.equal(f.writes.length, count);
  perform.stopFunction();
  assert.equal(f.writes.length, count, 'stale cleanup cannot reset the newer dialogue mouth');
});

test('cancelled audio initialization cannot later start voice, mouth or blink callbacks', async t => {
  const calls = [], timers = new Map();
  let sequence = 0, resolveReady;
  const ready = new Promise(resolve => { resolveReady = resolve; });
  const original = { setTimeout: global.setTimeout, clearTimeout: global.clearTimeout, document: global.document };
  global.setTimeout = callback => { timers.set(++sequence, callback); return sequence; };
  global.clearTimeout = id => timers.delete(id);
  global.document = { getElementById: () => ({ play: () => { calls.push('play'); return Promise.resolve(); }, pause() {} }) };
  t.after(() => Object.assign(global, original));
  const state = { freeFigure: [], figureAssociatedAnimation: [{ targetId: 'actor' }] };
  const mocks = {
    '@/Core/util/logger': { logger: { debug() {}, warn() {} } },
    '@/Core/util/getSentenceArg': { getFigurePositionFromArgs: () => 'center', getNumberArgByKey: () => null,
      getStringArgByKey: (_, key) => key === 'figureId' ? 'actor' : 'voice.ogg' },
    '@/Core/Modules/stage/stageStateManager': { stageStateManager: { getViewStageState: () => state, setStage() {} } },
    '@/Core/WebGAL': { WebGAL: { gameplay: { performController: { unmountPerform() {} },
      pixiStage: { resetMouthY() {}, performMouthSyncAnimation() {} } } } },
    '@/Core/gameScripts/vocal/vocalAnimation': { audioContextWrapper: {}, ensureAudioContextReady: () => ready,
      resetMaxAudioLevel() {}, performBlinkAnimation: () => calls.push('blink'), performMouthAnimation: () => calls.push('mouth') },
  };
  const filename = path.resolve(__dirname, '../src/Core/gameScripts/vocal/index.ts');
  const loaded = new Module(filename, module);
  loaded.require = name => mocks[name] ?? require(name);
  loaded._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020,
  } }).outputText, filename);
  const perform = loaded.exports.playVocal({ args: [] });
  assert.equal(timers.size, 0, 'voice preparation must not schedule playback before commit');
  perform.startFunction();
  const pending = [...timers.values()][0]();
  perform.stopFunction();
  resolveReady(false); await pending;
  assert.deepEqual(calls, []);
  assert.equal(timers.size, 0);
});
