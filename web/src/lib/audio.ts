/**
 * What the voice message player needs from an audio attachment: something
 * the browser can play, its length, and the outline of its waveform.
 *
 * AMR, the format of most voice messages sent over MMS, plays in no desktop
 * browser. Such files are decoded here by opencore-amr compiled to
 * WebAssembly, loaded with the first one shown, and played as WAV.
 */

export interface PreparedAudio {
  /** What the <audio> element plays: the file itself, or its WAV version. */
  src: string;
  /** Seconds. */
  duration: number;
  /** Loudness of each slice of the recording, from 0 to 1. */
  peaks: number[];
}

export const WAVEFORM_BARS = 40;

const prepared = new Map<string, Promise<PreparedAudio>>();

/** Fetches and decodes an attachment once per session, however often it is shown. */
export function prepareAudio(url: string): Promise<PreparedAudio> {
  let result = prepared.get(url);
  if (!result) {
    result = load(url);
    prepared.set(url, result);
    // After a failure (offline, say), showing the message again tries again.
    result.catch(() => prepared.delete(url));
  }
  return result;
}

async function load(url: string): Promise<PreparedAudio> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  if (isAmr(bytes)) {
    const { samples, sampleRate } = await decodeAmr(bytes);
    const wav = new Blob([encodeWav(samples, sampleRate)], { type: 'audio/wav' });
    return { src: URL.createObjectURL(wav), duration: samples.length / sampleRate, peaks: waveform(samples) };
  }
  // The waveform needs the samples, and an offline context decodes without asking to play sound.
  const buffer = await new OfflineAudioContext(1, 1, 8000).decodeAudioData(bytes.buffer);
  return { src: url, duration: buffer.duration, peaks: waveform(buffer.getChannelData(0)) };
}

/** AMR-NB ("#!AMR\n") or AMR-WB ("#!AMR-WB\n"), whatever type the file came with. */
export function isAmr(bytes: Uint8Array): boolean {
  return bytes.length > 6 && String.fromCharCode(...bytes.subarray(0, 5)) === '#!AMR';
}

export async function decodeAmr(bytes: Uint8Array): Promise<{ samples: Float32Array; sampleRate: number }> {
  const { default: decode } = await import('@audio/decode-amr');
  const { channelData, sampleRate } = await decode(bytes);
  const samples = channelData[0];
  if (!samples?.length) throw new Error('Unreadable AMR file');
  return { samples, sampleRate };
}

/** Mono 16-bit PCM WAV. */
export function encodeWav(samples: Float32Array, sampleRate: number): ArrayBuffer {
  const out = new DataView(new ArrayBuffer(44 + samples.length * 2));
  const text = (offset: number, s: string) => [...s].forEach((c, i) => out.setUint8(offset + i, c.charCodeAt(0)));
  text(0, 'RIFF');
  out.setUint32(4, 36 + samples.length * 2, true);
  text(8, 'WAVE');
  text(12, 'fmt ');
  out.setUint32(16, 16, true);
  out.setUint16(20, 1, true); // PCM
  out.setUint16(22, 1, true); // mono
  out.setUint32(24, sampleRate, true);
  out.setUint32(28, sampleRate * 2, true);
  out.setUint16(32, 2, true);
  out.setUint16(34, 16, true);
  text(36, 'data');
  out.setUint32(40, samples.length * 2, true);
  samples.forEach((s, i) => out.setInt16(44 + i * 2, Math.max(-1, Math.min(1, s)) * 0x7fff, true));
  return out.buffer;
}

/**
 * Loudness (RMS) of each of `bars` slices, scaled so the loudest is 1. A
 * floor keeps silences visible as short bars, and a curve lifts quiet
 * speech so the outline is not mostly flat.
 */
export function waveform(samples: Float32Array, bars = WAVEFORM_BARS): number[] {
  const size = samples.length / bars;
  const levels = Array.from({ length: bars }, (_, bar) => {
    const start = Math.floor(bar * size);
    const end = Math.max(start + 1, Math.floor((bar + 1) * size));
    let sum = 0;
    for (let i = start; i < end && i < samples.length; i++) sum += samples[i]! * samples[i]!;
    return Math.sqrt(sum / (end - start));
  });
  const loudest = Math.max(...levels);
  return levels.map((level) => (loudest > 0 ? Math.max(0.08, (level / loudest) ** 0.7) : 0.08));
}

/** "0:07", "1:23". */
export function formatDuration(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
