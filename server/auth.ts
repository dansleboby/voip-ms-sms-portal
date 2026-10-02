import crypto from 'node:crypto';
import type { Repo } from './db.js';

/**
 * Single static password (APP_PASSWORD) and a signed, stateless session cookie.
 * The signature covers a fingerprint of the password, so changing
 * APP_PASSWORD signs everyone out.
 */

export const SESSION_COOKIE = 'vsp_session';
const SECRET_KEY = 'session.secret';

function digest(value: string): Buffer {
  return crypto.createHash('sha256').update(value, 'utf8').digest();
}

export class Auth {
  private readonly secret: Buffer;
  private readonly passwordDigest: Buffer;

  constructor(
    repo: Repo,
    appPassword: string,
    private readonly sessionDays: number,
  ) {
    let secret = repo.getSetting(SECRET_KEY);
    if (!secret) {
      secret = crypto.randomBytes(32).toString('base64');
      repo.setSetting(SECRET_KEY, secret);
    }
    this.secret = Buffer.from(secret, 'base64');
    this.passwordDigest = digest(appPassword);
  }

  get maxAgeSeconds(): number {
    return Math.round(this.sessionDays * 24 * 60 * 60);
  }

  checkPassword(candidate: string): boolean {
    return crypto.timingSafeEqual(digest(candidate), this.passwordDigest);
  }

  private sign(payload: string): string {
    return crypto.createHmac('sha256', this.secret).update(payload).update(this.passwordDigest).digest('base64url');
  }

  issue(now = Date.now()): string {
    const payload = String(now);
    return `${payload}.${this.sign(payload)}`;
  }

  verify(token: string | undefined, now = Date.now()): boolean {
    if (!token) return false;
    const dot = token.indexOf('.');
    if (dot <= 0) return false;
    const payload = token.slice(0, dot);
    const issuedAt = Number(payload);
    if (!Number.isFinite(issuedAt) || issuedAt > now + 60_000) return false;
    if (now - issuedAt > this.maxAgeSeconds * 1000) return false;
    const expected = Buffer.from(this.sign(payload));
    const actual = Buffer.from(token.slice(dot + 1));
    return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
  }
}
