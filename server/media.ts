import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { AttachmentRow, Repo } from './db.js';
import type { Logger } from './logger.js';

const EXTENSIONS: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/heic': 'heic',
  'image/heif': 'heif',
  'image/bmp': 'bmp',
  'image/svg+xml': 'svg',
  'video/mp4': 'mp4',
  'video/3gpp': '3gp',
  'video/quicktime': 'mov',
  'video/webm': 'webm',
  'audio/mpeg': 'mp3',
  'audio/mp4': 'm4a',
  'audio/aac': 'aac',
  'audio/amr': 'amr',
  'audio/ogg': 'ogg',
  'audio/wav': 'wav',
  'text/vcard': 'vcf',
  'text/x-vcard': 'vcf',
  'text/plain': 'txt',
  'application/pdf': 'pdf',
};

const MIME_BY_EXTENSION: Record<string, string> = Object.fromEntries(
  Object.entries(EXTENSIONS).map(([mime, ext]) => [ext, mime]),
);
MIME_BY_EXTENSION.jpeg = 'image/jpeg';

/** Types a browser may render inline from our origin without any script execution risk. */
const INLINE_SAFE = /^(image\/(jpeg|png|gif|webp|bmp|heic|heif|avif)|video\/[\w.+-]+|audio\/[\w.+-]+)$/;

export function isInlineSafe(mime: string | null): boolean {
  return mime !== null && INLINE_SAFE.test(mime);
}

function cleanMime(contentType: string | null | undefined): string | null {
  const mime = contentType?.split(';')[0]?.trim().toLowerCase();
  return mime ? mime : null;
}

function mimeFromUrl(url: string): string | null {
  const ext = /\.([a-z0-9]{2,5})(?:$|[?#])/i.exec(url)?.[1]?.toLowerCase();
  return ext ? (MIME_BY_EXTENSION[ext] ?? null) : null;
}

const MAX_DOWNLOAD_BYTES = 25 * 1024 * 1024;
/**
 * VoIP.ms media links can answer 404 for a while (seen live: over 40 minutes)
 * before the file appears, so downloads keep trying for about 6 hours, from
 * 30 s up to 2 h apart. A failed one can still be retried from the UI.
 */
export const MAX_DOWNLOAD_ATTEMPTS = 10;
const RETRY_BASE_MS = 30_000;
const RETRY_MAX_MS = 2 * 60 * 60 * 1000;

/**
 * Stores attachment files under DATA_DIR/media and downloads the ones
 * received from VoIP.ms. Their media links are public and possibly
 * short-lived, so every file is kept locally.
 */
export class MediaStore {
  private working = false;
  private again = false;

  constructor(
    readonly dir: string,
    private readonly repo: Repo,
    private readonly options: {
      log: Logger;
      fetch?: typeof fetch;
      /** Called once an attachment of this message changed state. */
      onAttachmentChange?: (messageId: number) => void;
    },
  ) {}

  async init(): Promise<void> {
    await fs.mkdir(this.dir, { recursive: true });
  }

  filePath(fileName: string): string {
    if (fileName !== path.basename(fileName)) throw new Error('Invalid media file name');
    return path.join(this.dir, fileName);
  }

  async save(buffer: Buffer, mime: string | null): Promise<{ fileName: string; size: number; mime: string }> {
    const type = mime ?? 'application/octet-stream';
    const fileName = `${crypto.randomUUID()}.${EXTENSIONS[type] ?? 'bin'}`;
    await fs.writeFile(this.filePath(fileName), buffer);
    return { fileName, size: buffer.length, mime: type };
  }

  async read(row: AttachmentRow): Promise<Buffer> {
    if (!row.file_name) throw new Error(`Attachment ${row.id} has no file`);
    return fs.readFile(this.filePath(row.file_name));
  }

  /** The format sendMMS accepts for inline media. */
  async toDataUri(row: AttachmentRow): Promise<string> {
    const data = await this.read(row);
    return `data:${row.mime ?? 'application/octet-stream'};base64,${data.toString('base64')}`;
  }

  /** Processes pending downloads in the background; safe to call often. */
  kick(): void {
    if (this.working) {
      this.again = true;
      return;
    }
    this.working = true;
    void this.drain().finally(() => {
      this.working = false;
      if (this.again) {
        this.again = false;
        this.kick();
      }
    });
  }

  /** One pass over the due rows; failures are retried with backoff on a later kick (each poll kicks). */
  private async drain(): Promise<void> {
    let cursor = 0;
    for (;;) {
      const batch = this.repo.pendingAttachments(Date.now(), cursor);
      if (batch.length === 0) return;
      for (const row of batch) {
        cursor = row.id;
        await this.downloadOne(row);
      }
    }
  }

  private async downloadOne(row: AttachmentRow): Promise<void> {
    const attempts = row.attempts + 1;
    try {
      if (!row.remote_url) throw new Error('No remote URL');
      const { buffer, mime } = await this.fetchRemote(row.remote_url);
      const saved = await this.save(buffer, mime);
      this.repo.updateAttachment(row.id, { ...saved, status: 'ready', attempts });
    } catch (err) {
      const failed = attempts >= MAX_DOWNLOAD_ATTEMPTS;
      this.options.log.warn({ err, attachment: row.id, attempts }, 'Media download failed');
      this.repo.updateAttachment(row.id, {
        attempts,
        status: failed ? 'failed' : 'pending',
        nextAttemptAt: Date.now() + Math.min(RETRY_BASE_MS * 2 ** (attempts - 1), RETRY_MAX_MS),
      });
      if (!failed) return;
    }
    this.options.onAttachmentChange?.(row.message_id);
  }

  private async fetchRemote(url: string): Promise<{ buffer: Buffer; mime: string | null }> {
    if (url.startsWith('data:')) {
      const m = /^data:([^;,]+)?(;base64)?,(.*)$/s.exec(url);
      if (!m) throw new Error('Malformed data URI');
      const buffer = m[2] ? Buffer.from(m[3]!, 'base64') : Buffer.from(decodeURIComponent(m[3]!), 'utf8');
      return { buffer, mime: cleanMime(m[1]) };
    }
    const res = await (this.options.fetch ?? fetch)(url, { signal: AbortSignal.timeout(60_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const buffer = Buffer.from(await res.arrayBuffer());
    if (buffer.length > MAX_DOWNLOAD_BYTES) throw new Error('Media too large');
    let mime = cleanMime(res.headers.get('content-type'));
    if (!mime || mime === 'application/octet-stream' || mime === 'binary/octet-stream') mime = mimeFromUrl(url) ?? mime;
    return { buffer, mime };
  }
}
