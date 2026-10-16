import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { phpAvailable } from './backends.js';
import { browserKeys, decryptPayload } from '../server/test/webpush-helpers.js';

/** What a browser and a push service would do with the PHP version's notifications. */
describe.runIf(phpAvailable || process.env.REQUIRE_PHP)('PHP web push', () => {
  const run = (...args: string[]) =>
    JSON.parse(execFileSync('php', [path.join(import.meta.dirname, 'php/webpush.php'), ...args], { encoding: 'utf8' })) as {
      body: string;
      vapid: { publicKey: string; privateKey: string };
      authorization: string;
    };

  it('encrypts payloads the browser can read', () => {
    const ua = browserKeys();
    const text = JSON.stringify({ title: 'Marie Tremblay', body: 'Allô 😊 à tantôt' });
    const { body } = run(ua.p256dh, ua.auth, text, 'https://push.example.net/send/abc');
    expect(decryptPayload(Buffer.from(body, 'base64url'), ua.private, ua.authSecret)).toBe(text);
  });

  it('signs a VAPID token the push service can check', () => {
    const ua = browserKeys();
    const { vapid, authorization } = run(ua.p256dh, ua.auth, 'x', 'https://fcm.googleapis.com:443/fcm/send/abc');
    const [, token, key] = /^vapid t=([\w-]+\.[\w-]+\.[\w-]+), k=([\w-]+)$/.exec(authorization)!;
    expect(key).toBe(vapid.publicKey);
    const [header, claims, signature] = token!.split('.');
    expect(JSON.parse(Buffer.from(header!, 'base64url').toString())).toEqual({ typ: 'JWT', alg: 'ES256' });
    const payload = JSON.parse(Buffer.from(claims!, 'base64url').toString());
    // The push service's origin, without the default port, as URL.origin gives it.
    expect(payload).toMatchObject({ aud: 'https://fcm.googleapis.com', sub: 'mailto:me@example.com' });
    expect(payload.exp - Date.now() / 1000).toBeGreaterThan(11 * 3600);
    const pub = Buffer.from(vapid.publicKey, 'base64url');
    const publicKey = crypto.createPublicKey({
      key: { kty: 'EC', crv: 'P-256', x: pub.subarray(1, 33).toString('base64url'), y: pub.subarray(33).toString('base64url') },
      format: 'jwk',
    });
    const valid = crypto.verify('sha256', Buffer.from(`${header}.${claims}`), { key: publicKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(signature!, 'base64url'));
    expect(valid).toBe(true);
  });
});
