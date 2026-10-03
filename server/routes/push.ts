import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Services } from '../app.js';
import { PushError } from '../push.js';
import { isValidPublicKey } from '../webpush.js';

const Base64Url = z.string().regex(/^[\w-]+={0,2}$/).max(200);
const Endpoint = z
  .string()
  .max(2048)
  .url()
  .refine((url) => url.startsWith('https://'), 'The push endpoint must use https');

/** PushSubscription.toJSON() from the browser, plus who it belongs to. */
const SubscriptionBody = z.object({
  endpoint: Endpoint,
  keys: z.object({
    p256dh: Base64Url.refine((key) => isValidPublicKey(Buffer.from(key, 'base64url')), 'Invalid p256dh key'),
    auth: Base64Url.refine((key) => Buffer.from(key, 'base64url').length === 16, 'Invalid auth secret'),
  }),
  device: z.string().regex(/^[\w-]{8,64}$/).optional(),
  lang: z.enum(['fr', 'en']).optional(),
  /** Sent by the service worker when the browser renewed the subscription. */
  replaces: z.string().max(2048).optional(),
});

const EndpointBody = z.object({ endpoint: z.string().max(2048) });

export function registerPushRoutes(app: FastifyInstance, s: Services): void {
  app.get('/api/push/key', async () => ({ publicKey: s.push.publicKey }));

  app.post('/api/push/subscriptions', async (req) => {
    const body = SubscriptionBody.parse(req.body);
    const previous = body.replaces ? s.repo.getPushSubscription(body.replaces) : null;
    const current = s.repo.getPushSubscription(body.endpoint);
    s.repo.transaction(() => {
      if (previous && body.replaces !== body.endpoint) s.repo.deletePushSubscription(previous.endpoint);
      s.repo.savePushSubscription({
        endpoint: body.endpoint,
        p256dh: body.keys.p256dh.replace(/=+$/, ''),
        auth: body.keys.auth.replace(/=+$/, ''),
        device: body.device ?? previous?.device ?? current?.device ?? null,
        lang: body.lang ?? previous?.lang ?? current?.lang ?? 'fr',
      });
    });
    return { ok: true };
  });

  app.post('/api/push/unsubscribe', async (req) => {
    const { endpoint } = EndpointBody.parse(req.body);
    return { ok: s.repo.deletePushSubscription(endpoint) };
  });

  app.post('/api/push/test', async (req, reply) => {
    const { endpoint } = EndpointBody.parse(req.body);
    try {
      await s.push.sendTest(endpoint);
      return { ok: true };
    } catch (err) {
      if (err instanceof PushError) {
        return reply.code(err.code === 'not_subscribed' ? 404 : 502).send({ error: err.code, status: err.status });
      }
      req.log.warn({ err }, 'Test push failed');
      return reply.code(502).send({ error: 'push_failed' });
    }
  });
}
