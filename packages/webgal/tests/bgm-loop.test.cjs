const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const ts = require('typescript');
const cache = {};
function load(name) {
  if (cache[name]) return cache[name];
  const filename = path.resolve(__dirname, '../src/Stage/AudioContainer', name + '.ts');
  const code = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2021 },
  }).outputText;
  const exports = cache[name] = {};
  new Function('require', 'exports', code)(id => load(id.replace('./', '')), exports);
  return exports;
}
const { readOggLoopPoints, loopPosition } = load('oggLoop');
function page(packet) {
  const lacing = [];
  for (let size = packet.length; size >= 255; size -= 255) lacing.push(255);
  lacing.push(packet.length % 255);
  const header = Buffer.alloc(27); header.write('OggS'); header[26] = lacing.length;
  return Buffer.concat([header, Buffer.from(lacing), packet]);
}
function fixture(tags, codec = 'opus') {
  const number = value => { const b = Buffer.alloc(4); b.writeUInt32LE(value); return b; };
  const head = Buffer.alloc(codec === 'opus' ? 19 : 30);
  if (codec === 'opus') head.write('OpusHead');
  else { head[0] = 1; head.write('vorbis', 1); head.writeUInt32LE(44100, 12); }
  const packet = Buffer.concat([Buffer.from(codec === 'opus' ? 'OpusTags' : '\x03vorbis'),
    number(0), number(tags.length), ...tags.flatMap(tag => [number(Buffer.byteLength(tag)), Buffer.from(tag)])]);
  const bytes = Buffer.concat([page(head), page(packet)]);
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
}
test('Opus loop tags use decoded PCM at 48kHz, never the original 44.1kHz or pre-skip', () => {
  assert.deepEqual(readOggLoopPoints(fixture(['LOOPSTART=233514', 'LOOPEND=3139460', 'LOOPSAMPLERATE=48000'])),
    { start: 233514 / 48000, end: 3139460 / 48000 });
});
test('Vorbis sample rate, case-insensitive aliases, and LOOPLENGTH', () => {
  assert.deepEqual(readOggLoopPoints(fixture(['loop_start=220500', 'loop_length=441000'], 'vorbis')), { start: 5, end: 15 });
});
test('zero start is valid; no tags, malformed ranges and truncated headers fall back', () => {
  assert.deepEqual(readOggLoopPoints(fixture(['LOOPSTART=0', 'LOOPEND=48000'])), { start: 0, end: 1 });
  for (const tags of [[], ['LOOPSTART=100', 'LOOPEND=99'], ['LOOPSTART=-1', 'LOOPEND=100'],
    ['LOOPSTART=1', 'LOOPEND=Infinity'], ['LOOPSTART=0', 'LOOPEND=100', 'LOOPSAMPLERATE=0']]) {
    assert.equal(readOggLoopPoints(fixture(tags)), null);
  }
  const bytes = fixture(['LOOPSTART=0', 'LOOPEND=100']);
  for (const length of [0, 3, 27, bytes.byteLength - 1]) assert.equal(readOggLoopPoints(bytes.slice(0, length)), null);
});
test('intro plays once; exact end and subsequent cycles return to the loop start', () => {
  const loop = { start: 5, end: 65 };
  assert.equal(loopPosition(0, loop), 0);
  assert.equal(loopPosition(4.9, loop), 4.9);
  assert.equal(loopPosition(65, loop), 5);
  assert.equal(loopPosition(68, loop), 8);
  assert.equal(loopPosition(125, loop), 5);
});

class Media extends EventTarget {
  src = 'http://localhost/music.opus'; muted = false; _time = 0; _volume = 1; _paused = true;
  nativePlays = 0;
  getAttribute(name) { return name === 'src' ? this.src : null; }
  get currentTime() { return this._time; } set currentTime(value) { this._time = value; }
  get paused() { return this._paused; }
  get duration() { return 70; }
  get volume() { return this._volume; }
  set volume(value) { this._volume = value; this.dispatchEvent(new Event('volumechange')); }
  play() { this._paused = false; this.nativePlays++; return Promise.resolve(); }
  pause() { this._paused = true; }
}
class Context {
  static current;
  currentTime = 0; destination = {}; sources = []; gains = [];
  constructor() { Context.current = this; }
  resume() { return Promise.resolve(); }
  decodeAudioData() { return Promise.resolve({ duration: 70, sampleRate: 48000, length: 70 * 48000, numberOfChannels: 2 }); }
  createGain() {
    const node = { gain: { value: 1, setValueAtTime(value) { this.value = value; } }, connect() {}, disconnect() {} };
    this.gains.push(node); return node;
  }
  createBufferSource() {
    const node = { connect() {}, disconnect() {}, stop() { this.stopped = true; }, start(_, offset) { this.offset = offset; } };
    this.sources.push(node); return node;
  }
}
test('tagged BGM uses audio-clock looping, pause/resume, volume and seeking; disposal stops it', async t => {
  const originals = { HTMLMediaElement: global.HTMLMediaElement, AudioContext: global.AudioContext, fetch: global.fetch };
  Object.assign(global, { HTMLMediaElement: Media, AudioContext: Context,
    fetch: async () => ({ ok: true, status: 200, arrayBuffer: async () => fixture(['LOOPSTART=240000', 'LOOPEND=3120000']) }) });
  t.after(() => Object.assign(global, originals));
  const { attachLoopingBgm } = load('BgmLoopController');
  const media = new Media(), control = attachLoopingBgm(media);
  control.reset();
  await media.play();
  const context = Context.current;
  assert.equal(media.nativePlays, 0);
  assert.equal(context.sources.at(-1).loopStart, 5);
  assert.equal(context.sources.at(-1).loopEnd, 65);
  assert.equal(context.sources.at(-1).offset, 0);
  context.currentTime = 68;
  assert.equal(media.currentTime, 8);
  media.pause(); assert.equal(media.paused, true); assert.equal(media.currentTime, 8);
  context.currentTime = 100;
  await media.play(); assert.equal(context.sources.at(-1).offset, 8);
  media.volume = .25; assert.equal(context.gains.at(-1).gain.value, .25);
  media.currentTime = 2; assert.equal(context.sources.at(-1).offset, 2);
  const current = context.sources.at(-1);
  control.dispose(); assert.equal(current.stopped, true);
  assert.equal(Object.hasOwn(media, 'play'), false);
  assert.equal(Object.hasOwn(media, 'currentTime'), false);
});
test('untagged Ogg and MP3 retain native playback', async t => {
  const originals = { HTMLMediaElement: global.HTMLMediaElement, AudioContext: global.AudioContext, fetch: global.fetch };
  Object.assign(global, { HTMLMediaElement: Media, AudioContext: Context,
    fetch: async () => ({ ok: true, status: 200, arrayBuffer: async () => fixture([]) }) });
  t.after(() => Object.assign(global, originals));
  const { attachLoopingBgm } = load('BgmLoopController');
  for (const extension of ['ogg', 'mp3']) {
    const media = new Media(); media.src = 'http://localhost/a.' + extension;
    const control = attachLoopingBgm(media); control.reset(); await media.play();
    assert.equal(media.nativePlays, 1); assert.equal(media.paused, false);
    media.pause(); assert.equal(media.paused, true); control.dispose();
  }
});
test('switching or pausing while loading cannot start an obsolete source', async t => {
  const originals = { HTMLMediaElement: global.HTMLMediaElement, AudioContext: global.AudioContext, fetch: global.fetch };
  let release;
  Object.assign(global, { HTMLMediaElement: Media, AudioContext: Context,
    fetch: () => new Promise(resolve => { release = resolve; }) });
  t.after(() => Object.assign(global, originals));
  const { attachLoopingBgm } = load('BgmLoopController');
  for (const action of ['pause', 'reset', 'dispose']) {
    const media = new Media(); media.src = 'http://localhost/cancel-' + action + '.opus';
    const control = attachLoopingBgm(media); control.reset();
    const playing = media.play(); await new Promise(resolve => setImmediate(resolve));
    if (action === 'pause') media.pause(); else control[action]();
    release({ ok: true, status: 200, arrayBuffer: async () => fixture(['LOOPSTART=0', 'LOOPEND=48000']) });
    await assert.rejects(playing, { name: 'AbortError' });
    assert.equal(media.nativePlays, 0); control.dispose();
  }
});
test('one full cache-friendly request; switching back/remounting reuses decoded audio', async t => {
  const originals = { HTMLMediaElement: global.HTMLMediaElement, AudioContext: global.AudioContext, fetch: global.fetch };
  const requests = [];
  Object.assign(global, { HTMLMediaElement: Media, AudioContext: Context,
    fetch: async (url, options) => {
      requests.push(options);
      return { ok: true, status: 200, arrayBuffer: async () => fixture(['LOOPSTART=240000', 'LOOPEND=3120000']) };
    } });
  t.after(() => Object.assign(global, originals));
  const { attachLoopingBgm } = load('BgmLoopController');
  const media = new Media(); media.src = 'http://localhost/cache-test.opus';
  const control = attachLoopingBgm(media); control.reset();
  await media.play();
  assert.equal(requests.length, 1);
  assert.equal(requests[0].headers, undefined);
  assert.equal(requests[0].cache, undefined);
  assert.equal(media.nativePlays, 0);
  control.dispose();
  const again = new Media(); again.src = media.src;
  const second = attachLoopingBgm(again); second.reset(); await again.play();
  assert.equal(requests.length, 1);
  assert.equal(again.nativePlays, 0);
  second.dispose();
});
