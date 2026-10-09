export interface AudioLoopPoints {
  start: number;
  end: number;
}

/** Read decoded-PCM sample positions, not Ogg granules (Opus pre-skip is already removed). */
export function readOggLoopPoints(data: ArrayBuffer): AudioLoopPoints | null {
  const bytes = new Uint8Array(data);
  const text = new TextDecoder();
  let offset = 0,
    sampleRate = 0;
  let parts: number[] = [];
  const tags = new Map<string, string>();
  while (offset + 27 <= bytes.length) {
    if (text.decode(bytes.subarray(offset, offset + 4)) !== 'OggS') return null;
    const count = bytes[offset + 26];
    if (offset + 27 + count > bytes.length) return null;
    let body = offset + 27 + count;
    for (let i = 0; i < count; i++) {
      const size = bytes[offset + 27 + i];
      if (body + size > bytes.length) return null;
      for (let j = body; j < body + size; j++) parts.push(bytes[j]);
      body += size;
      if (size === 255) continue;
      const packet = new Uint8Array(parts);
      parts = [];
      const magic = text.decode(packet.subarray(0, 8));
      if (magic === 'OpusHead') sampleRate = 48000;
      if (packet[0] === 1 && text.decode(packet.subarray(1, 7)) === 'vorbis' && packet.length >= 16) {
        sampleRate = new DataView(packet.buffer).getUint32(12, true);
      }
      const opusTags = magic === 'OpusTags';
      const vorbisTags = packet[0] === 3 && text.decode(packet.subarray(1, 7)) === 'vorbis';
      if (!opusTags && !vorbisTags) continue;
      const comments = new DataView(packet.buffer);
      let pos = opusTags ? 8 : 7;
      const readSize = () => {
        if (pos + 4 > packet.length) throw new RangeError('Truncated Ogg comments');
        const value = comments.getUint32(pos, true);
        pos += 4;
        return value;
      };
      try {
        const vendorLength = readSize();
        pos += vendorLength;
        const entries = readSize();
        if (entries > packet.length / 4) return null;
        for (let entry = 0; entry < entries; entry++) {
          const size = readSize();
          if (pos + size > packet.length) return null;
          const tag = text.decode(packet.subarray(pos, pos + size));
          pos += size;
          const separator = tag.indexOf('=');
          if (separator >= 0)
            tags.set(tag.slice(0, separator).toUpperCase().replace(/_/g, ''), tag.slice(separator + 1));
        }
      } catch {
        return null;
      }
      const numeric = (key: string) => {
        const value = tags.get(key);
        return value !== undefined && /^\d+$/.test(value) ? Number(value) : NaN;
      };
      const rate = tags.has('LOOPSAMPLERATE') ? numeric('LOOPSAMPLERATE') : sampleRate;
      const start = numeric('LOOPSTART');
      const end = tags.has('LOOPEND') ? numeric('LOOPEND') : start + numeric('LOOPLENGTH');
      if (
        !Number.isFinite(rate) ||
        rate <= 0 ||
        !Number.isSafeInteger(start) ||
        !Number.isSafeInteger(end) ||
        end <= start
      )
        return null;
      return { start: start / rate, end: end / rate };
    }
    offset = body;
  }
  return null;
}

/** Map elapsed playback back into the loop, leaving the first intro untouched. */
export function loopPosition(position: number, points: AudioLoopPoints): number {
  return position < points.end
    ? Math.max(0, position)
    : points.start + ((position - points.end) % (points.end - points.start));
}
