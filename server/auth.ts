import crypto from 'node:crypto';
import type { Repo } from './db.js';
import type { PortalMode, Role } from '../shared/types.js';

/**
 * Who is signed in. The owner signs in with APP_PASSWORD, the only way in
 * the simple mode; in the Team mode, users sign in with their email and
 * their own password (server/passwords.ts).
 *
 * Each sign-in is a row of the sessions table, so that it can be listed and
 * ended from elsewhere. The cookie holds the session's id, signed with a
 * secret and a digest of APP_PASSWORD: changing APP_PASSWORD signs everyone
 * out, and the table alone (which keeps only a hash of each id) signs
 * nobody in.
 */

export const SESSION_COOKIE = 'vsp_session';
const SECRET_KEY = 'session.secret';
/** '1' once the owner turned the Team mode on (it does not turn off). */
export const TEAM_KEY = 'team.enabled';
/** A session's last activity is written at most this often. */
const TOUCH_MS = 60_000;

export interface SessionUser {
  /** The session's id as stored (a hash of the cookie's). */
  sessionId: string;
  /** Null for the owner. */
  userId: number | null;
  email: string | null;
  name: string | null;
  role: Role;
}

function digest(value: string): Buffer {
  return crypto.createHash('sha256').update(value, 'utf8').digest();
}

/** The id stored for a session id carried by a cookie. */
export function storedSessionId(cookieId: string): string {
  return digest(cookieId).toString('base64url');
}

export class Auth {
  private readonly secret: Buffer;
  private readonly passwordDigest: Buffer;

  constructor(
    private readonly repo: Repo,
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

  mode(): PortalMode {
    return this.repo.getSetting(TEAM_KEY) === '1' ? 'team' : 'simple';
  }

  /** APP_PASSWORD: the owner's. */
  checkPassword(candidate: string): boolean {
    return crypto.timingSafeEqual(digest(candidate), this.passwordDigest);
  }

  private sign(id: string): string {
    return crypto.createHmac('sha256', this.secret).update(id).update(this.passwordDigest).digest('base64url');
  }

  /** Signs someone in (null: the owner); returns the cookie's value. */
  open(userId: number | null, userAgent: string | null, now = Date.now()): string {
    this.repo.pruneSessions(now - this.maxAgeSeconds * 1000);
    const id = crypto.randomBytes(24).toString('base64url');
    this.repo.createSession(storedSessionId(id), userId, userAgent ? userAgent.slice(0, 300) : null, now);
    return `${id}.${this.sign(id)}`;
  }

  /** Who a cookie signs in, if anyone. */
  verify(token: string | undefined, now = Date.now()): SessionUser | null {
    if (!token) return null;
    const dot = token.indexOf('.');
    if (dot <= 0) return null;
    const id = token.slice(0, dot);
    const expected = Buffer.from(this.sign(id));
    const actual = Buffer.from(token.slice(dot + 1));
    if (expected.length !== actual.length || !crypto.timingSafeEqual(expected, actual)) return null;
    const sessionId = storedSessionId(id);
    const session = this.repo.getSession(sessionId);
    if (!session) return null;
    if (now - session.created_at > this.maxAgeSeconds * 1000) {
      this.repo.deleteSession(sessionId);
      return null;
    }
    let user: SessionUser = { sessionId, userId: null, email: null, name: null, role: 'owner' };
    if (session.user_id !== null) {
      const row = this.repo.getUserRow(session.user_id);
      // Users only exist in the Team mode, and a disabled one is out.
      if (!row || row.disabled_at !== null || this.mode() !== 'team') return null;
      user = { sessionId, userId: row.id, email: row.email, name: row.name, role: row.role };
    }
    if (now - session.last_seen_at > TOUCH_MS) this.repo.touchSession(sessionId, now);
    return user;
  }

  close(sessionId: string): void {
    this.repo.deleteSession(sessionId);
  }
}
