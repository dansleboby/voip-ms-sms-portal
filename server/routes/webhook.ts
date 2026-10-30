import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Services } from '../app.js';
import type { WebhookStatusDto } from '../../shared/types.js';

const EnableBody = z.object({
  /** Numbers whose callback to another address may be replaced. */
  replace: z.array(z.string().regex(/^\d{10}$/)).max(1000).optional(),
});
const CallbackParams = z.object({ token: z.string().max(100) });

export function registerWebhookRoutes(app: FastifyInstance, s: Services): void {
  app.get('/api/webhook', { config: { admin: true } }, async (): Promise<WebhookStatusDto> => s.webhook.status());

  app.post('/api/webhook/enable', { config: { admin: true } }, async (req): Promise<WebhookStatusDto> => {
    const { replace = [] } = EnableBody.parse(req.body ?? {});
    const status = await s.webhook.enable(req.headers.origin ?? null, replace);
    // Checks change pace, and tabs learn the new state with the next status.
    s.sync.trigger();
    return status;
  });

  app.post('/api/webhook/disable', { config: { admin: true } }, async (): Promise<WebhookStatusDto> => {
    const status = await s.webhook.disable();
    s.sync.trigger();
    return status;
  });

  /**
   * VoIP.ms's call for a text one of the numbers received. Public: the secret
   * is in the address. "ok" tells VoIP.ms not to call again for that text.
   */
  app.get('/api/voipms/callback/:token', { config: { rateLimit: { max: 120, timeWindow: '1 minute' } } }, async (req, reply) => {
    const { token } = CallbackParams.parse(req.params);
    if (!s.accounts.receive(token)) return reply.code(404).send({ error: 'not_found' });
    return reply.type('text/plain; charset=utf-8').send('ok');
  });
}
