import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Services } from '../app.js';
import { VoipMsError, type VoipMsApi } from '../voipms/client.js';
import type { ConnectionTestDto, DidDto, SetupStatusDto } from '../../shared/types.js';

const CredentialsBody = z.object({
  username: z.string().trim().min(3).max(200),
  password: z.string().min(1).max(200),
});

const ImportBody = z.object({ days: z.number().int().min(0).max(3650) });

/** getIP works from any address (it only checks credentials); getBalance needs a whitelisted IP. */
async function testConnection(client: VoipMsApi): Promise<ConnectionTestDto> {
  let ip: string | null = null;
  try {
    ip = await client.getIP();
  } catch (err) {
    return { ip: null, status: err instanceof VoipMsError ? err.code : 'internal_error', balance: null };
  }
  try {
    const balance = await client.getBalance();
    return { ip, status: 'success', balance: Number.isFinite(balance) ? balance : null };
  } catch (err) {
    return { ip, status: err instanceof VoipMsError ? err.code : 'internal_error', balance: null };
  }
}

export function registerSetupRoutes(app: FastifyInstance, s: Services): void {
  app.get('/api/setup/status', async (): Promise<SetupStatusDto> => ({
    completed: s.isSetupCompleted(),
    credentialsSource: s.credentials.source(),
    username: s.credentials.get()?.username ?? null,
  }));

  /** Validates and stores credentials entered in the wizard, then reports whether the IP is allowed. */
  app.post('/api/setup/credentials', async (req, reply) => {
    if (s.credentials.source() === 'env') return reply.code(409).send({ error: 'credentials_from_env' });
    const creds = CredentialsBody.parse(req.body);
    const result = await testConnection(s.clientFor(creds));
    if (result.ip === null) return reply.code(400).send({ error: result.status });
    s.credentials.save(creds);
    s.resetClient();
    return result;
  });

  app.post('/api/setup/test', async (_req, reply): Promise<ConnectionTestDto | void> => {
    const client = s.client();
    if (!client) return reply.code(409).send({ error: 'not_configured' });
    return testConnection(client);
  });

  /** Refreshes the numbers from VoIP.ms and returns them with local labels/colors. */
  app.get('/api/setup/dids', async (_req, reply): Promise<DidDto[] | void> => {
    const client = s.client();
    if (!client) return reply.code(409).send({ error: 'not_configured' });
    const dids = await client.getDids();
    s.repo.transaction(() => {
      for (const d of dids) s.repo.upsertDid(d);
    });
    s.events.broadcast({ type: 'dids' });
    return s.repo.listDids();
  });

  /** Starts importing the last `days` of history in the background; progress comes through sync status. */
  app.post('/api/setup/import', async (req, reply) => {
    const { days } = ImportBody.parse(req.body);
    if (!s.client()) return reply.code(409).send({ error: 'not_configured' });
    if (days > 0) {
      s.sync.importHistory(days).catch((err: unknown) => req.log.error({ err }, 'History import failed'));
    }
    return reply.code(202).send({ ok: true });
  });

  app.post('/api/setup/complete', async (_req, reply) => {
    if (!s.client()) return reply.code(409).send({ error: 'not_configured' });
    s.setSetupCompleted(true);
    s.sync.trigger(0);
    return { ok: true };
  });
}
