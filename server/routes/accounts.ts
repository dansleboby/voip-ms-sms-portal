import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Services } from '../app.js';
import { testConnection } from './setup.js';
import type { AccountDto, ConnectionTestDto } from '../../shared/types.js';

const Label = z.string().trim().max(60).nullable();
const AddBody = z.object({
  label: Label.optional(),
  username: z.string().trim().min(3).max(200),
  password: z.string().min(1).max(200),
});
const PatchBody = z.object({ label: Label });
const IdParams = z.object({ id: z.coerce.number().int().positive() });

/**
 * The VoIP.ms accounts the portal uses. The first one comes from the setup
 * wizard; the others are added here (an agency keeps one per client).
 */
export function registerAccountRoutes(app: FastifyInstance, s: Services): void {
  app.get('/api/accounts', async (): Promise<AccountDto[]> => s.accounts.list());

  /** Checks the credentials, keeps them encrypted like the first account's, and fetches the account's numbers. */
  app.post('/api/accounts', async (req, reply): Promise<{ account: AccountDto; connection: ConnectionTestDto } | void> => {
    const body = AddBody.parse(req.body);
    const username = body.username.toLowerCase();
    if (s.accounts.list().some((a) => a.username?.toLowerCase() === username)) return reply.code(409).send({ error: 'account_exists' });
    const credentials = { username: body.username, password: body.password };
    const connection = await testConnection(s.clientFor(credentials));
    if (connection.ip === null) return reply.code(400).send({ error: connection.status });
    const { id } = s.accounts.add(body.label ?? null, credentials);
    // Its numbers, when VoIP.ms already lets this server in; otherwise with a later refresh.
    if (connection.status === 'success') await s.accounts.refreshDids().catch((err: unknown) => req.log.warn({ err }, 'Numbers not refreshed'));
    return reply.code(201).send({ account: s.accounts.list().find((a) => a.id === id)!, connection });
  });

  app.patch('/api/accounts/:id', async (req, reply): Promise<AccountDto | void> => {
    const { id } = IdParams.parse(req.params);
    const { label } = PatchBody.parse(req.body);
    if (!s.repo.updateAccount(id, label)) return reply.code(404).send({ error: 'not_found' });
    return s.accounts.list().find((a) => a.id === id)!;
  });
}
