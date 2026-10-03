import crypto from 'node:crypto';

/**
 * Web Push without a third-party library: the payload is encrypted for the
 * browser (RFC 8291, "aes128gcm" content coding from RFC 8188) and the
 * request is signed with the server's VAPID key (RFC 8292). Push services
 * (Google, Mozilla, Apple, Microsoft) only ever see ciphertext.
 */

/** P-256 key pair, base64url: raw uncompressed public key (65 bytes) and private scalar (32 bytes). */
export interface VapidKeys {
  publicKey: string;
  privateKey: string;
}

export interface PushTarget {
  endpoint: string;
  /** Browser's P-256 public key, base64url (uncompressed point). */
  p256dh: string;
  /** 16-byte authentication secret, base64url. */
  auth: string;
}

export interface PushOptions {
  vapid: VapidKeys;
  /** "mailto:" or "https:" contact the push service can reach about this sender. */
  subject: string;
  /** Seconds the push service keeps the message for an offline device. */
  ttl?: number;
  urgency?: 'very-low' | 'low' | 'normal' | 'high';
  /** Replaces a not-yet-delivered message with the same topic (at most 32 base64url characters). */
  topic?: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

const RECORD_SIZE = 4096;
/** Push services accept 4096 bytes of body; the header and tag take 103 of them. */
export const MAX_PAYLOAD_BYTES = 3993;

export function generateVapidKeys(): VapidKeys {
  const { privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const jwk = privateKey.export({ format: 'jwk' });
  const publicKey = Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x!, 'base64url'), Buffer.from(jwk.y!, 'base64url')]);
  return { publicKey: publicKey.toString('base64url'), privateKey: jwk.d! };
}

/** True for a well-formed P-256 public key in uncompressed form (also rejects points off the curve). */
export function isValidPublicKey(key: Buffer): boolean {
  if (key.length !== 65 || key[0] !== 4) return false;
  try {
    const ecdh = crypto.createECDH('prime256v1');
    ecdh.generateKeys();
    ecdh.computeSecret(key);
    return true;
  } catch {
    return false;
  }
}

function signingKey(keys: VapidKeys): crypto.KeyObject {
  const pub = Buffer.from(keys.publicKey, 'base64url');
  return crypto.createPrivateKey({
    key: {
      kty: 'EC',
      crv: 'P-256',
      d: keys.privateKey,
      x: pub.subarray(1, 33).toString('base64url'),
      y: pub.subarray(33, 65).toString('base64url'),
    },
    format: 'jwk',
  });
}

const base64json = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');

/** `Authorization` header value: a short-lived ES256 JWT for the push service's origin (RFC 8292). */
export function vapidAuthorization(endpoint: string, keys: VapidKeys, subject: string, now = Date.now()): string {
  const header = base64json({ typ: 'JWT', alg: 'ES256' });
  const claims = base64json({ aud: new URL(endpoint).origin, exp: Math.floor(now / 1000) + 12 * 3600, sub: subject });
  const unsigned = `${header}.${claims}`;
  const signature = crypto.sign('sha256', Buffer.from(unsigned), { key: signingKey(keys), dsaEncoding: 'ieee-p1363' });
  return `vapid t=${unsigned}.${signature.toString('base64url')}, k=${keys.publicKey}`;
}

/**
 * Encrypts one push message (RFC 8291 §3). `salt` and `senderPrivateKey`
 * are random for every message; they are parameters only to check the
 * result against the RFC's test vector.
 */
export function encryptPayload(
  plaintext: Buffer,
  target: Pick<PushTarget, 'p256dh' | 'auth'>,
  fixed: { salt?: Buffer; senderPrivateKey?: Buffer } = {},
): Buffer {
  if (plaintext.length > MAX_PAYLOAD_BYTES) throw new Error('Push payload too large');
  const uaPublic = Buffer.from(target.p256dh, 'base64url');
  const authSecret = Buffer.from(target.auth, 'base64url');
  const ecdh = crypto.createECDH('prime256v1');
  if (fixed.senderPrivateKey) ecdh.setPrivateKey(fixed.senderPrivateKey);
  else ecdh.generateKeys();
  const asPublic = ecdh.getPublicKey();
  const ecdhSecret = ecdh.computeSecret(uaPublic);

  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic]);
  const ikm = Buffer.from(crypto.hkdfSync('sha256', ecdhSecret, authSecret, keyInfo, 32));
  const salt = fixed.salt ?? crypto.randomBytes(16);
  const cek = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
  const nonce = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));

  const cipher = crypto.createCipheriv('aes-128-gcm', cek, nonce);
  // A single record: the 0x02 delimiter marks it as the last one.
  const ciphertext = Buffer.concat([cipher.update(Buffer.concat([plaintext, Buffer.from([2])])), cipher.final(), cipher.getAuthTag()]);

  const header = Buffer.alloc(21);
  salt.copy(header, 0);
  header.writeUInt32BE(RECORD_SIZE, 16);
  header.writeUInt8(asPublic.length, 20);
  return Buffer.concat([header, asPublic, ciphertext]);
}

/** Delivers one message to a push service. Resolves with the HTTP status (201 when accepted). */
export async function sendPush(target: PushTarget, payload: string, options: PushOptions): Promise<number> {
  const body = encryptPayload(Buffer.from(payload, 'utf8'), target);
  const headers: Record<string, string> = {
    Authorization: vapidAuthorization(target.endpoint, options.vapid, options.subject),
    'Content-Encoding': 'aes128gcm',
    'Content-Type': 'application/octet-stream',
    TTL: String(options.ttl ?? 24 * 3600),
    Urgency: options.urgency ?? 'normal',
  };
  if (options.topic) headers.Topic = options.topic;
  const res = await (options.fetch ?? fetch)(target.endpoint, {
    method: 'POST',
    headers,
    body,
    signal: AbortSignal.timeout(options.timeoutMs ?? 15_000),
  });
  await res.arrayBuffer().catch(() => undefined);
  return res.status;
}
