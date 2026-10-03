import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { SESSION_COOKIE } from '../auth.js';
import type { Services } from '../app.js';
import { VERSION } from '../app.js';
import type { SessionDto } from '../../shared/types.js';

const LoginBody = z.object({ password: z.string().max(1000) });

export function registerAuthRoutes(app: FastifyInstance, s: Services): void {
  app.get('/api/session', async (req): Promise<SessionDto> => ({
    authenticated: s.auth.verify(req.cookies[SESSION_COOKIE]),
    // Unreadable credentials (APP_PASSWORD changed) send the user back to the wizard.
    setupCompleted: s.isSetupCompleted() && s.credentials.get() !== null,
    credentialsSource: s.credentials.source(),
    demo: s.config.demo,
    version: VERSION,
    pollActiveSeconds: Math.round(s.config.pollActiveMs / 1000),
    pollIdleSeconds: Math.round(s.config.pollIdleMs / 1000),
  }));

  app.post(
    '/api/auth/login',
    { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const { password } = LoginBody.parse(req.body);
      if (!s.auth.checkPassword(password)) {
        req.log.warn({ ip: req.ip }, 'Failed login');
        return reply.code(401).send({ error: 'wrong_password' });
      }
      reply.setCookie(SESSION_COOKIE, s.auth.issue(), {
        path: '/',
        httpOnly: true,
        sameSite: 'lax',
        secure: req.protocol === 'https' || s.config.publicOrigin?.startsWith('https:') === true,
        maxAge: s.auth.maxAgeSeconds,
      });
      return { ok: true };
    },
  );

  app.post('/api/auth/logout', async (_req, reply) => {
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return { ok: true };
  });
}
