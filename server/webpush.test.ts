import crypto from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { encryptPayload, generateVapidKeys, isValidPublicKey, sendPush, vapidAuthorization } from './webpush.js';
import { browserKeys, decryptPayload } from './test/webpush-helpers.js';

/** RFC 8291 §5 and Appendix A. */
const RFC = {
  plaintext: 'When I grow up, I want to be a watermelon',
  asPrivate: 'yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw',
  uaPrivate: 'q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94',
  uaPublic: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
  auth: 'BTBZMqHH6r4Tts7J_aSIgg',
  salt: 'DGv6ra1nlYgDCS1FRnbzlw',
  result:
    'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27ml' +
    'mlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPT' +
    'pK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN',
};

describe('encryptPayload', () => {
  it('matches the RFC 8291 example byte for byte', () => {
    const body = encryptPayload(
      Buffer.from(RFC.plaintext),
      { p256dh: RFC.uaPublic, auth: RFC.auth },
      { salt: Buffer.from(RFC.salt, 'base64url'), senderPrivateKey: Buffer.from(RFC.asPrivate, 'base64url') },
    );
    expect(body.toString('base64url')).toBe(RFC.result);
  });

  it('produces messages the browser can decrypt, different every time', () => {
    const ua = browserKeys();
    const text = JSON.stringify({ title: 'Marie Tremblay', body: 'Allô 😊 à tantôt' });
    const a = encryptPayload(Buffer.from(text), ua);
    const b = encryptPayload(Buffer.from(text), ua);
    expect(a.equals(b)).toBe(false);
    expect(decryptPayload(a, ua.private, ua.authSecret)).toBe(text);
    expect(decryptPayload(Buffer.from(RFC.result, 'base64url'), Buffer.from(RFC.uaPrivate, 'base64url'), Buffer.from(RFC.auth, 'base64url'))).toBe(
      RFC.plaintext,
    );
  });

  it('refuses payloads push services would reject', () => {
    const ua = browserKeys();
    expect(() => encryptPayload(Buffer.alloc(4000), ua)).toThrow();
  });
});

describe('VAPID', () => {
  it('signs a JWT for the push service origin that verifies with the public key', () => {
    const keys = generateVapidKeys();
    expect(Buffer.from(keys.publicKey, 'base64url')).toHaveLength(65);
    expect(Buffer.from(keys.privateKey, 'base64url')).toHaveLength(32);
    const now = Date.UTC(2026, 9, 2);
    const header = vapidAuthorization('https://fcm.googleapis.com/fcm/send/abc:def', keys, 'mailto:me@example.com', now);
    const match = /^vapid t=([\w-]+)\.([\w-]+)\.([\w-]+), k=([\w-]+)$/.exec(header);
    expect(match).not.toBeNull();
    const [, h, c, sig, k] = match!;
    expect(k).toBe(keys.publicKey);
    expect(JSON.parse(Buffer.from(h!, 'base64url').toString())).toEqual({ typ: 'JWT', alg: 'ES256' });
    expect(JSON.parse(Buffer.from(c!, 'base64url').toString())).toEqual({
      aud: 'https://fcm.googleapis.com',
      exp: now / 1000 + 12 * 3600,
      sub: 'mailto:me@example.com',
    });
    const pub = Buffer.from(keys.publicKey, 'base64url');
    const publicKey = crypto.createPublicKey({
      key: { kty: 'EC', crv: 'P-256', x: pub.subarray(1, 33).toString('base64url'), y: pub.subarray(33).toString('base64url') },
      format: 'jwk',
    });
    const signature = Buffer.from(sig!, 'base64url');
    expect(signature).toHaveLength(64);
    expect(crypto.verify('sha256', Buffer.from(`${h}.${c}`), { key: publicKey, dsaEncoding: 'ieee-p1363' }, signature)).toBe(true);
  });

  it('validates browser public keys', () => {
    expect(isValidPublicKey(Buffer.from(RFC.uaPublic, 'base64url'))).toBe(true);
    const offCurve = Buffer.from(RFC.uaPublic, 'base64url');
    offCurve[64] ^= 1;
    expect(isValidPublicKey(offCurve)).toBe(false);
    expect(isValidPublicKey(Buffer.alloc(65))).toBe(false);
  });
});

describe('sendPush', () => {
  it('posts the encrypted message with the Web Push headers', async () => {
    const ua = browserKeys();
    let seen: { url: string; init: RequestInit } | null = null;
    const fakeFetch = (async (url: string, init: RequestInit) => {
      seen = { url, init };
      return new Response(null, { status: 201 });
    }) as unknown as typeof fetch;
    const status = await sendPush({ endpoint: 'https://push.example.net/s/1', ...ua }, '{"title":"Hi"}', {
      vapid: generateVapidKeys(),
      subject: 'mailto:me@example.com',
      urgency: 'high',
      topic: 'c12',
      fetch: fakeFetch,
    });
    expect(status).toBe(201);
    const headers = seen!.init.headers as Record<string, string>;
    expect(seen!.url).toBe('https://push.example.net/s/1');
    expect(headers).toMatchObject({ 'Content-Encoding': 'aes128gcm', TTL: '86400', Urgency: 'high', Topic: 'c12' });
    expect(headers.Authorization).toMatch(/^vapid t=/);
    expect(decryptPayload(seen!.init.body as Buffer, ua.private, ua.authSecret)).toBe('{"title":"Hi"}');
  });
});
