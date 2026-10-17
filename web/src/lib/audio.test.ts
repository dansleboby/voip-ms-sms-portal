import { describe, expect, it } from 'vitest';
import { decodeAmr, encodeWav, formatDuration, isAmr, waveform, WAVEFORM_BARS } from './audio';

/** An AMR file of `frames` 20 ms frames: NB at 12.2 kbit/s (32-byte frames) or WB at 23.85 kbit/s (61-byte frames). */
function amrFile(kind: 'nb' | 'wb', frames: number): Uint8Array {
  const header = new TextEncoder().encode(kind === 'nb' ? '#!AMR\n' : '#!AMR-WB\n');
  const [size, mode] = kind === 'nb' ? [32, 7] : [61, 8];
  const out = new Uint8Array(header.length + frames * size);
  out.set(header);
  for (let f = 0; f < frames; f++) {
    const at = header.length + f * size;
    out[at] = (mode << 3) | 0x04;
    for (let i = 1; i < size; i++) out[at + i] = (f * 31 + i * 7) & 0xff;
  }
  return out;
}

describe('isAmr', () => {
  it('knows AMR by its header, not by the type it came with', () => {
    expect(isAmr(amrFile('nb', 1))).toBe(true);
    expect(isAmr(amrFile('wb', 1))).toBe(true);
    expect(isAmr(new TextEncoder().encode('RIFF....WAVE'))).toBe(false);
    expect(isAmr(new Uint8Array())).toBe(false);
  });
});

describe('decodeAmr', () => {
  it('decodes AMR-NB to 8 kHz and AMR-WB to 16 kHz, 20 ms a frame', async () => {
    const nb = await decodeAmr(amrFile('nb', 50));
    expect(nb.sampleRate).toBe(8000);
    expect(nb.samples.length).toBe(50 * 160);
    const wb = await decodeAmr(amrFile('wb', 25));
    expect(wb.sampleRate).toBe(16000);
    expect(wb.samples.length).toBe(25 * 320);
  });

  it('turns down a file that is not AMR', async () => {
    await expect(decodeAmr(new TextEncoder().encode('not audio at all'))).rejects.toThrow();
  });
});

describe('encodeWav', () => {
  it('writes a mono 16-bit PCM WAV, clipping what is out of range', () => {
    const wav = new DataView(encodeWav(new Float32Array([0, 0.5, -1, 2]), 8000));
    const text = (at: number, length: number) => String.fromCharCode(...new Uint8Array(wav.buffer, at, length));
    expect(text(0, 4)).toBe('RIFF');
    expect(text(8, 8)).toBe('WAVEfmt ');
    expect(wav.getUint16(20, true)).toBe(1);
    expect(wav.getUint16(22, true)).toBe(1);
    expect(wav.getUint32(24, true)).toBe(8000);
    expect(wav.getUint16(34, true)).toBe(16);
    expect(text(36, 4)).toBe('data');
    expect(wav.getUint32(40, true)).toBe(8);
    expect(wav.byteLength).toBe(52);
    expect([0, 1, 2, 3].map((i) => wav.getInt16(44 + i * 2, true))).toEqual([0, 16383, -32767, 32767]);
  });
});

describe('waveform', () => {
  it('gives one bar a slice, the loudest at 1, silences as short bars', () => {
    const samples = new Float32Array(8000);
    samples.fill(0.5, 0, 2000);
    samples.fill(0.1, 2000, 4000);
    const bars = waveform(samples, 4);
    expect(bars).toHaveLength(4);
    expect(bars[0]).toBe(1);
    expect(bars[1]).toBeGreaterThan(0.08);
    expect(bars[1]).toBeLessThan(1);
    expect(bars.slice(2)).toEqual([0.08, 0.08]);
  });

  it('copes with silence and with fewer samples than bars', () => {
    expect(waveform(new Float32Array(100))).toEqual(Array(WAVEFORM_BARS).fill(0.08));
    expect(waveform(new Float32Array([0.3, 0.6]), 4)).toHaveLength(4);
  });
});

describe('formatDuration', () => {
  it('reads as minutes and seconds', () => {
    expect(formatDuration(0)).toBe('0:00');
    expect(formatDuration(7.4)).toBe('0:07');
    expect(formatDuration(83)).toBe('1:23');
  });
});
