import { AudioLoopPoints, loopPosition, readOggLoopPoints } from './oggLoop';

let sharedContext: AudioContext | undefined;
const audioContext = () => (sharedContext ??= new AudioContext());
interface PreparedBgm {
  points: AudioLoopPoints | null;
  buffer?: AudioBuffer;
  bytes: number;
}
// Reuse completed decodes across element remounts/switches without unbounded PCM memory.
const preparedCache = new Map<string, PreparedBgm>();
const remember = (url: string, entry: PreparedBgm) => {
  if (entry.bytes > 64 * 1024 * 1024) return;
  preparedCache.delete(url);
  preparedCache.set(url, entry);
  let bytes = [...preparedCache.values()].reduce((sum, item) => sum + item.bytes, 0);
  while (preparedCache.size > 8 || bytes > 64 * 1024 * 1024) {
    const oldest = preparedCache.keys().next().value as string;
    bytes -= preparedCache.get(oldest)!.bytes;
    preparedCache.delete(oldest);
  }
};

/** Per-element adapter: existing volume/fade/play/pause callers keep working. */
export function attachLoopingBgm(element: HTMLAudioElement) {
  const nativePlay = element.play.bind(element);
  const nativePause = element.pause.bind(element);
  const descriptor = (name: string) => Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, name)!;
  const time = descriptor('currentTime'),
    paused = descriptor('paused'),
    duration = descriptor('duration');
  let url = '',
    generation = 0,
    disposed = false;
  let prepared = false,
    buffer: AudioBuffer | undefined,
    points: AudioLoopPoints | null = null;
  let source: AudioBufferSourceNode | undefined, gain: GainNode | undefined;
  let offset = 0,
    startedAt = 0;
  let pending: Promise<void> | undefined, abort: AbortController | undefined;
  const position = () =>
    points && source ? loopPosition(offset + audioContext().currentTime - startedAt, points) : offset;
  const stop = () => {
    if (source) {
      offset = position();
      source.onended = null;
      source.stop();
      source.disconnect();
      source = undefined;
    }
  };
  const updateVolume = () => {
    if (gain) gain.gain.setValueAtTime(element.muted ? 0 : element.volume, audioContext().currentTime);
  };
  const start = () => {
    if (!buffer || !points || source) return;
    const context = audioContext();
    gain ??= context.createGain();
    gain.disconnect();
    gain.connect(context.destination);
    updateVolume();
    source = context.createBufferSource();
    source.buffer = buffer;
    source.loop = true;
    source.loopStart = points.start;
    source.loopEnd = points.end;
    source.connect(gain);
    offset = loopPosition(offset, points);
    startedAt = context.currentTime;
    source.start(0, offset);
    element.dispatchEvent(new Event('play'));
    element.dispatchEvent(new Event('playing'));
  };
  const reset = () => {
    generation++;
    abort?.abort();
    abort = undefined;
    pending = undefined;
    stop();
    nativePause();
    gain?.disconnect();
    gain = undefined;
    buffer = undefined;
    points = null;
    prepared = false;
    offset = 0;
    url = element.getAttribute('src') ? element.src : '';
  };
  element.play = () => {
    if (disposed) return Promise.reject(new DOMException('Disposed BGM', 'AbortError'));
    const currentUrl = element.getAttribute('src') ? element.src : '';
    if (url !== currentUrl) reset();
    if (!url || !/\.(?:ogg|opus|oga)(?:[?#]|$)/i.test(url) || typeof AudioContext === 'undefined') return nativePlay();
    // Resume inside the user gesture, before any network/decode await.
    const context = audioContext();
    const resume = context.resume();
    if (pending) {
      resume.catch(() => {});
      return pending;
    }
    const token = generation;
    const isCurrent = () => !disposed && token === generation;
    const task = async () => {
      await resume;
      if (!isCurrent()) throw new DOMException('BGM changed', 'AbortError');
      if (!prepared) {
        const cached = preparedCache.get(url);
        if (cached) {
          remember(url, cached);
          points = cached.points;
          buffer = cached.buffer;
          prepared = true;
        }
      }
      if (!prepared) {
        abort = new AbortController();
        // One ordinary full request lets the browser use its HTTP/disk cache.
        // No Range probe: it can interfere with native media's partial-response cache.
        const response = await fetch(url, { signal: abort.signal });
        if (!response.ok || response.status === 206) throw new Error('Incomplete BGM HTTP ' + response.status);
        const data = await response.arrayBuffer();
        const parsed = readOggLoopPoints(data);
        if (!isCurrent()) throw new DOMException('BGM changed', 'AbortError');
        if (parsed) {
          const decoded = await context.decodeAudioData(data);
          if (!isCurrent()) throw new DOMException('BGM changed', 'AbortError');
          if (parsed.end <= decoded.duration + 1 / decoded.sampleRate) {
            points = { start: parsed.start, end: Math.min(parsed.end, decoded.duration) };
            buffer = decoded;
          } else throw new Error('BGM loop end exceeds decoded duration');
        }
        remember(url, { points, buffer, bytes: buffer ? buffer.length * buffer.numberOfChannels * 4 : 0 });
        prepared = true;
      }
      if (!isCurrent()) throw new DOMException('BGM changed', 'AbortError');
      if (points) start();
      else await nativePlay();
    };
    const result = task().catch(async (error) => {
      if (!isCurrent() || error?.name === 'AbortError' || error?.name === 'NotAllowedError') throw error;
      console.warn('[WebGAL BGM] Loop metadata unavailable; using normal playback.', error);
      prepared = true;
      points = null;
      buffer = undefined;
      await nativePlay();
    });
    pending = result;
    void result
      .finally(() => {
        if (pending === result) pending = undefined;
      })
      .catch(() => {});
    return result;
  };
  element.pause = () => {
    generation++;
    abort?.abort();
    pending = undefined;
    const playing = !!source;
    stop();
    nativePause();
    if (playing) element.dispatchEvent(new Event('pause'));
  };
  Object.defineProperties(element, {
    currentTime: {
      configurable: true,
      get: () => (points ? position() : time.get!.call(element)),
      set: (value: number) => {
        if (!points) {
          time.set!.call(element, value);
          return;
        }
        if (!Number.isFinite(value) || value < 0) throw new TypeError('Invalid BGM time');
        const playing = !!source;
        stop();
        offset = loopPosition(value, points);
        if (playing) start();
        element.dispatchEvent(new Event('seeked'));
      },
    },
    paused: { configurable: true, get: () => (points ? !source : paused.get!.call(element)) },
    duration: { configurable: true, get: () => (buffer ? buffer.duration : duration.get!.call(element)) },
  });
  element.addEventListener('volumechange', updateVolume);
  return {
    reset,
    dispose() {
      disposed = true;
      reset();
      element.removeEventListener('volumechange', updateVolume);
      for (const key of ['play', 'pause', 'currentTime', 'paused', 'duration']) Reflect.deleteProperty(element, key);
    },
  };
}
