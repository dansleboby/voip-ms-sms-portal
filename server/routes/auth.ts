import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { SESSION_COOKIE } from '../auth.js';
import type { Services } from '../app.js';
import { hashPassword, verifyPassword } from '../passwords.js';
import { VERSION } from '../version.js';
import type { SessionDto } from '../../shared/types.js';

/** No email: the owner's APP_PASSWORD. With an email: a user of the Team mode. */
const LoginBody = z.object({ email: z.string().trim().max(254).optional(), password: z.string().max(1000) });

/** Compared against when nobody has the email given, so that the answer takes as long. */
const missingUserHash = hashPassword('');

export function signIn(s: Services, req: FastifyRequest, reply: FastifyReply, userId: number | null): void {
  reply.setCookie(SESSION_COOKIE, s.auth.open(userId, req.headers['user-agent'] ?? null), {
    path: '/',
    httpOnly: true,
    sameSite: 'lax',
    secure: req.protocol === 'https' || s.config.publicOrigin?.startsWith('https:') === true,
    maxAge: s.auth.maxAgeSeconds,
  });
}

export function registerAuthRoutes(app: FastifyInstance, s: Services): void {
  app.get('/api/session', async (req): Promise<SessionDto> => ({
    authenticated: req.user !== null,
    // Unreadable credentials (APP_PASSWORD changed) send the user back to the wizard.
    setupCompleted: s.isSetupCompleted() && s.credentials.get() !== null,
    credentialsSource: s.credentials.source(),
    demo: s.config.demo,
    version: VERSION,
    pollActiveSeconds: Math.round(s.config.pollActiveMs / 1000),
    pollIdleSeconds: Math.round(s.config.pollIdleMs / 1000),
    liveUpdates: s.config.liveUpdates,
    didsRestricted: s.config.allowedDids !== null || s.config.excludedDids.length > 0,
    mode: s.auth.mode(),
    user: req.user && { id: req.user.userId, email: req.user.email, name: req.user.name, role: req.user.role },
  }));

  app.post(
    '/api/auth/login',
    { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const { email, password } = LoginBody.parse(req.body);
      let userId: number | null = null;
      if (email) {
        const user = s.auth.mode() === 'team' ? s.repo.findUserByEmail(email.toLowerCase()) : null;
        const ok = await verifyPassword(password, user?.password_hash ?? (await missingUserHash));
        if (!user || !ok || user.disabled_at !== null) {
          req.log.warn({ ip: req.ip }, 'Failed login');
          return reply.code(401).send({ error: 'wrong_password' });
        }
        userId = user.id;
      } else if (!s.auth.checkPassword(password)) {
        req.log.warn({ ip: req.ip }, 'Failed login');
        return reply.code(401).send({ error: 'wrong_password' });
      }
      signIn(s, req, reply, userId);
      return { ok: true };
    },
  );

  app.post('/api/auth/logout', async (req, reply) => {
    if (req.user) s.auth.close(req.user.sessionId);
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return { ok: true };
  });
}
