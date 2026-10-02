import { MAX_ATTACHMENT_BYTES } from '../../../shared/message';

/**
 * VoIP.ms caps each MMS file at 1.2 MB and recompresses pictures anyway, so
 * photos are resized and re-encoded in the browser before upload. The target
 * leaves headroom for base64 inflation on VoIP.ms's side.
 */
const TARGET_BYTES = 900_000;
const MAX_DIMENSION = 1920;
const RESIZABLE = /^image\/(jpeg|png|webp|bmp|heic|heif|avif)$/;

export class AttachmentTooLarge extends Error {}

async function decode(file: File): Promise<ImageBitmap | HTMLImageElement> {
  if ('createImageBitmap' in window) {
    try {
      return await createImageBitmap(file, { imageOrientation: 'from-image' });
    } catch {
      // Fall through (e.g. HEIC outside Safari).
    }
  }
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    return img;
  } finally {
    URL.revokeObjectURL(url);
  }
}

function toBlob(canvas: HTMLCanvasElement, quality: number): Promise<Blob> {
  return new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Encoding failed'))), 'image/jpeg', quality),
  );
}

/** Returns a file VoIP.ms will accept, resizing photos when needed. */
export async function prepareAttachment(file: File): Promise<File> {
  const type = file.type || 'application/octet-stream';
  if (!RESIZABLE.test(type)) {
    if (file.size > MAX_ATTACHMENT_BYTES) throw new AttachmentTooLarge(file.name);
    return file;
  }
  if (file.size <= TARGET_BYTES && type !== 'image/heic' && type !== 'image/heif') return file;

  let image: ImageBitmap | HTMLImageElement;
  try {
    image = await decode(file);
  } catch {
    if (file.size > MAX_ATTACHMENT_BYTES) throw new AttachmentTooLarge(file.name);
    return file;
  }
  const width = 'naturalWidth' in image ? image.naturalWidth : image.width;
  const height = 'naturalHeight' in image ? image.naturalHeight : image.height;

  let scale = Math.min(1, MAX_DIMENSION / Math.max(width, height));
  let quality = 0.85;
  for (let attempt = 0; attempt < 8; attempt++) {
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(width * scale));
    canvas.height = Math.max(1, Math.round(height * scale));
    const ctx = canvas.getContext('2d')!;
    // JPEG has no transparency: paint transparent PNGs on white instead of black.
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
    const blob = await toBlob(canvas, quality);
    if (blob.size <= TARGET_BYTES) {
      const name = file.name.replace(/\.[^.]+$/, '') + '.jpg';
      return new File([blob], name, { type: 'image/jpeg', lastModified: file.lastModified });
    }
    if (quality > 0.6) quality -= 0.1;
    else scale *= 0.8;
  }
  throw new AttachmentTooLarge(file.name);
}
