import crypto from 'node:crypto';
import { promisify } from 'node:util';

/**
 * Users' passwords, hashed with PBKDF2-SHA256: both servers have it built in
 * (PHP's hash_pbkdf2), so a database moved between them keeps its users.
 * Stored as "pbkdf2-sha256$<iterations>$<salt>$<hash>", base64url.
 */

const pbkdf2 = promisify(crypto.pbkdf2);
const SCHEME = 'pbkdf2-sha256';
/** OWASP's 2023 figure for PBKDF2-SHA256: about half a second on a modest host, at sign-in only. */
export const PASSWORD_ITERATIONS = 600_000;
const KEY_BYTES = 32;

export async function hashPassword(password: string, iterations = PASSWORD_ITERATIONS): Promise<string> {
  const salt = crypto.randomBytes(16);
  const hash = await pbkdf2(password, salt, iterations, KEY_BYTES, 'sha256');
  return `${SCHEME}$${iterations}$${salt.toString('base64url')}$${hash.toString('base64url')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, rounds, salt, hash] = stored.split('$');
  const iterations = Number(rounds);
  if (scheme !== SCHEME || !Number.isInteger(iterations) || iterations < 1 || !salt || !hash) return false;
  const expected = Buffer.from(hash, 'base64url');
  const actual = await pbkdf2(password, Buffer.from(salt, 'base64url'), iterations, expected.length, 'sha256');
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}
