import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { TEAM_KEY } from '../auth.js';
import type { Services } from '../app.js';
import { hashPassword, verifyPassword } from '../passwords.js';
import type { SessionInfoDto, UserDto } from '../../shared/types.js';

/** Long enough to resist guessing at the sign-in rate limit; nothing more is asked. */
export const MIN_PASSWORD_LENGTH = 8;

const Email = z
  .string()
  .trim()
  .max(254)
  .regex(/^[^@\s]+@[^@\s]+\.[^@\s]+$/)
  .transform((e) => e.toLowerCase());
/** An empty name is no name, as in PHP. */
const Name = z
  .string()
  .trim()
  .max(80)
  .transform((n) => n || null)
  .nullable();
const Password = z.string().min(MIN_PASSWORD_LENGTH).max(1000);
const Numbers = z.array(z.object({ did: z.string().regex(/^\d{10}$/), canSend: z.boolean() })).max(1000);

const TeamBody = z.object({ email: Email, name: Name.optional(), password: Password });
const UserBody = z.object({
  email: Email,
  name: Name.optional(),
  password: Password,
  role: z.enum(['admin', 'user']),
  numbers: Numbers.optional(),
});
const UserPatch = z.object({
  name: Name.optional(),
  role: z.enum(['admin', 'user']).optional(),
  password: Password.optional(),
  disabled: z.boolean().optional(),
  numbers: Numbers.optional(),
});
const MePatch = z.object({ name: Name.optional(), password: z.object({ current: z.string().max(1000), next: Password }).optional() });
const IdParams = z.object({ id: z.coerce.number().int().positive() });
const SessionParams = z.object({ id: z.string().max(64) });

/** What a session list shows of a session's id: enough to tell them apart, not to sign in. */
const PUBLIC_ID_LENGTH = 16;

/**
 * The Team mode: the owner turns it on by creating the first admin, admins
 * manage the users and the numbers each one texts from, and everyone sees
 * and ends their own sessions.
 */
export function registerUserRoutes(app: FastifyInstance, s: Services): void {
  const teamOnly = (reply: FastifyReply) => {
    if (s.auth.mode() !== 'team') {
      void reply.code(409).send({ error: 'team_mode_off' });
      return false;
    }
    return true;
  };

  /** Numbers that exist in the portal, or a 400. */
  const checkNumbers = (numbers: { did: string; canSend: boolean }[] | undefined, reply: FastifyReply) => {
    const unknown = (numbers ?? []).filter((n) => !s.repo.getDid(n.did)).map((n) => n.did);
    if (unknown.length) {
      void reply.code(400).send({ error: 'unknown_did', dids: unknown });
      return false;
    }
    return true;
  };

  /** Turns the Team mode on, for good, with the first admin. Only the owner can. */
  app.post('/api/team', async (req, reply): Promise<UserDto | void> => {
    if (req.user?.role !== 'owner') return reply.code(403).send({ error: 'forbidden' });
    if (s.auth.mode() === 'team') return reply.code(409).send({ error: 'team_mode_on' });
    const body = TeamBody.parse(req.body);
    const id = s.repo.createUser({ email: body.email, name: body.name ?? null, passwordHash: await hashPassword(body.password), role: 'admin' });
    s.repo.setSetting(TEAM_KEY, '1');
    return reply.code(201).send(s.repo.getUser(id)!);
  });

  app.get('/api/users', { config: { admin: true } }, async (_req, reply): Promise<UserDto[] | void> => {
    if (!teamOnly(reply)) return;
    return s.repo.listUsers();
  });

  app.post('/api/users', { config: { admin: true } }, async (req, reply): Promise<UserDto | void> => {
    if (!teamOnly(reply)) return;
    const body = UserBody.parse(req.body);
    if (s.repo.findUserByEmail(body.email)) return reply.code(409).send({ error: 'email_taken' });
    if (!checkNumbers(body.numbers, reply)) return;
    const id = s.repo.createUser({ email: body.email, name: body.name ?? null, passwordHash: await hashPassword(body.password), role: body.role });
    if (body.numbers) s.repo.setUserNumbers(id, body.numbers);
    return reply.code(201).send(s.repo.getUser(id)!);
  });

  app.patch('/api/users/:id', { config: { admin: true } }, async (req, reply): Promise<UserDto | void> => {
    if (!teamOnly(reply)) return;
    const { id } = IdParams.parse(req.params);
    const patch = UserPatch.parse(req.body);
    if (!s.repo.getUserRow(id)) return reply.code(404).send({ error: 'not_found' });
    // An admin cannot lock themselves out; the owner (APP_PASSWORD) always can get back in anyway.
    if (id === req.user!.userId && (patch.disabled || patch.role === 'user')) return reply.code(409).send({ error: 'cannot_change_self' });
    if (!checkNumbers(patch.numbers, reply)) return;
    s.repo.updateUser(id, {
      name: patch.name,
      role: patch.role,
      disabled: patch.disabled,
      passwordHash: patch.password === undefined ? undefined : await hashPassword(patch.password),
    });
    if (patch.numbers) s.repo.setUserNumbers(id, patch.numbers);
    // A new password, or no access at all: their other browsers are signed out.
    if (patch.password !== undefined || patch.disabled) s.repo.deleteUserSessions(id, id === req.user!.userId ? req.user!.sessionId : null);
    return s.repo.getUser(id)!;
  });

  app.delete('/api/users/:id', { config: { admin: true } }, async (req, reply) => {
    if (!teamOnly(reply)) return;
    const { id } = IdParams.parse(req.params);
    if (id === req.user!.userId) return reply.code(409).send({ error: 'cannot_change_self' });
    if (!s.repo.deleteUser(id)) return reply.code(404).send({ error: 'not_found' });
    return { ok: true };
  });

  /** A user's own name and password. The owner's password is APP_PASSWORD, set on the server. */
  app.patch('/api/me', async (req, reply): Promise<UserDto | void> => {
    const userId = req.user!.userId;
    if (userId === null) return reply.code(409).send({ error: 'owner_has_no_account' });
    const patch = MePatch.parse(req.body);
    let passwordHash: string | undefined;
    if (patch.password) {
      if (!(await verifyPassword(patch.password.current, s.repo.getUserRow(userId)!.password_hash))) {
        return reply.code(400).send({ error: 'wrong_password' });
      }
      passwordHash = await hashPassword(patch.password.next);
    }
    s.repo.updateUser(userId, { name: patch.name, passwordHash });
    if (passwordHash) s.repo.deleteUserSessions(userId, req.user!.sessionId);
    return s.repo.getUser(userId)!;
  });

  app.get('/api/sessions', async (req): Promise<SessionInfoDto[]> =>
    s.repo.listSessions(req.user!.userId).map((row) => ({
      id: row.id.slice(0, PUBLIC_ID_LENGTH),
      createdAt: row.created_at,
      lastSeenAt: row.last_seen_at,
      userAgent: row.user_agent,
      current: row.id === req.user!.sessionId,
    })),
  );

  /** Signs one of the user's own browsers out. */
  app.delete('/api/sessions/:id', async (req: FastifyRequest, reply) => {
    const { id } = SessionParams.parse(req.params);
    const session = s.repo.listSessions(req.user!.userId).find((row) => row.id.slice(0, PUBLIC_ID_LENGTH) === id);
    if (!session) return reply.code(404).send({ error: 'not_found' });
    s.auth.close(session.id);
    return { ok: true };
  });
}
