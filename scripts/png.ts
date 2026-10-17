// Comparing screenshots by what they show: Chromium can encode the same
// picture as different PNG bytes from one run to the next, and smooth the
// edges of a few pixels a little differently.

import zlib from 'node:zlib';

/**
 * The pixels of a PNG as Chromium writes them (8 bits, RGB or RGBA, not
 * interlaced), with its size: the same picture can come out as different
 * bytes. Null for any other kind of PNG.
 */
export function pixels(png: Buffer): Buffer | null {
  let width = 0;
  let channels = 0;
  const data: Buffer[] = [];
  for (let pos = 8; pos + 8 <= png.length; ) {
    const length = png.readUInt32BE(pos);
    const type = png.toString('latin1', pos + 4, pos + 8);
    const body = png.subarray(pos + 8, pos + 8 + length);
    if (type === 'IHDR') {
      if (body[8] !== 8 || (body[9] !== 2 && body[9] !== 6) || body[12] !== 0) return null;
      width = body.readUInt32BE(0);
      channels = body[9] === 6 ? 4 : 3;
    } else if (type === 'IDAT') {
      data.push(body);
    }
    pos += 12 + length;
  }
  const raw = zlib.inflateSync(Buffer.concat(data));
  const stride = width * channels;
  const height = raw.length / (stride + 1);
  const out = Buffer.alloc(8 + height * stride);
  out.writeUInt32BE(width, 0);
  out.writeUInt32BE(height, 4);
  // Undo each row's filter (PNG spec, section 9).
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1);
    const row = out.subarray(8 + y * stride, 8 + (y + 1) * stride);
    const prev = y > 0 ? out.subarray(8 + (y - 1) * stride) : null;
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? row[x - channels]! : 0;
      const b = prev ? prev[x]! : 0;
      const c = prev && x >= channels ? prev[x - channels]! : 0;
      let predicted = 0;
      if (filter === 1) predicted = a;
      else if (filter === 2) predicted = b;
      else if (filter === 3) predicted = (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c;
        const [pa, pb, pc] = [Math.abs(p - a), Math.abs(p - b), Math.abs(p - c)];
        predicted = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      row[x] = (line[x]! + predicted) & 0xff;
    }
  }
  return out;
}

/** A pixel off by more than this, on any channel, is a change; less is smoothing. */
const CHANGED = 48;
/** Smoothing that touches more than this share of the picture is a change too (a shade, say). */
const SMOOTHING_SHARE = 0.005;

export function samePicture(a: Buffer, b: Buffer): boolean {
  if (a.equals(b)) return true;
  const [pa, pb] = [pixels(a), pixels(b)];
  if (pa === null || pb === null || pa.length !== pb.length || !pa.subarray(0, 8).equals(pb.subarray(0, 8))) return false;
  const channels = (pa.length - 8) / (pa.readUInt32BE(0) * pa.readUInt32BE(4));
  let smoothed = 0;
  for (let i = 8; i < pa.length; i += channels) {
    let delta = 0;
    for (let c = 0; c < channels; c++) delta = Math.max(delta, Math.abs(pa[i + c]! - pb[i + c]!));
    if (delta > CHANGED) return false;
    if (delta > 8) smoothed++;
  }
  return smoothed <= SMOOTHING_SHARE * ((pa.length - 8) / channels);
}
