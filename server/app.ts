import fs from 'node:fs';
import path from 'node:path';
import Fastify, { LogController, type FastifyInstance, type FastifyRequest } from 'fastify';
import cookie from '@fastify/cookie';
import multipart from '@fastify/multipart';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import { ZodError } from 'zod';
import { Auth, SESSION_COOKIE, type SessionUser } from './auth.js';
import { ConfigError, type Config } from './config.js';
import { openDatabase, PRIMARY_ACCOUNT, Repo } from './db.js';
import { Accounts } from './accounts.js';
import { EventHub } from './events.js';
import type { Logger } from './logger.js';
import { MediaStore } from './media.js';
import { PushService } from './push.js';
import { CredentialStore } from './secrets.js';
import { RemoteDeletions } from './deletions.js';
import { MessageSender, SendError } from './send.js';
import { VoipMsClient, VoipMsError, type VoipMsApi, type VoipMsCredentials } from './voipms/client.js';
import { DEMO_CONTACTS, DemoVoipMs } from './voipms/demo.js';
import { registerAuthRoutes } from './routes/auth.js';
import { registerContactRoutes } from './routes/contacts.js';
import { registerMessagingRoutes } from './routes/messaging.js';
import { registerPushRoutes } from './routes/push.js';
import { registerUpdateRoutes } from './routes/update.js';
import { UpdateChecker } from './updates.js';
import { VERSION } from './version.js';
import { registerSetupRoutes } from './routes/setup.js';
import { registerWebhookRoutes } from './routes/webhook.js';
import { registerAccountRoutes } from './routes/accounts.js';
import { registerUserRoutes } from './routes/users.js';
import type { WebhookReceiver } from './webhook.js';
import { MAX_ATTACHMENTS, MAX_ATTACHMENT_BYTES } from '../shared/message.js';

const SETUP_COMPLETED_KEY = 'setup.completed';

declare module 'fastify' {
  interface FastifyRequest {
    /** Who signed the request in (the /api routes' onRequest hook sets it). */
    user: SessionUser | null;
  }
  interface FastifyContextConfig {
    /** Only the owner and admins may call the route; users get 403. */
    admin?: boolean;
  }
}

export interface Services {
  config: Config;
  repo: Repo;
  events: EventHub;
  media: MediaStore;
  credentials: CredentialStore;
  auth: Auth;
  /** The VoIP.ms accounts, each checked on its own. */
  accounts: Accounts;
  /** Their checks, started, triggered and reported together. */
  sync: Accounts;
  sender: MessageSender;
  deletions: RemoteDeletions;
  push: PushService;
  updates: UpdateChecker;
  /** The first account's, the one the setup wizard and Settings show. */
  webhook: WebhookReceiver;
  /** Client for the first account's credentials, or null. */
  client(): VoipMsApi | null;
  /** Client for arbitrary credentials (used to validate them in the wizard). */
  clientFor(credentials: VoipMsCredentials, accountId?: number): VoipMsApi;
  /** Drops the first account's cached client after its credentials change. */
  resetClient(): void;
  isSetupCompleted(): boolean;
  setSetupCompleted(done: boolean): void;
}

export interface BuildOptions {
  /** Replaces the real VoIP.ms client (tests). */
  clientFactory?: (credentials: VoipMsCredentials, accountId: number) => VoipMsApi;
  /** fetch used to download media (tests). */
  mediaFetch?: typeof fetch;
  /** fetch used to reach push services (tests). */
  pushFetch?: typeof fetch;
  /** fetch used to look for new releases (tests). */
  updateFetch?: typeof fetch;
  logger?: boolean;
}

export async function buildApp(config: Config, options: BuildOptions = {}): Promise<{ app: FastifyInstance; services: Services }> {
  try {
    fs.mkdirSync(config.dataDir, { recursive: true });
    fs.accessSync(config.dataDir, fs.constants.W_OK);
  } catch {
    const uid = process.getuid?.() ?? '?';
    throw new ConfigError(
      `Cannot write to the data folder ${config.dataDir} (running as uid ${uid}). ` +
        `Give it to this user (chown -R ${uid} <folder> on the host) or, with Docker, start the container as root (the default).`,
    );
  }

  const app = Fastify({
    logger: options.logger === false ? false : { level: config.logLevel },
    // Per-request logs would record search terms and phone numbers from URLs.
    logController: new LogController({ disableRequestLogging: true }),
    trustProxy: config.trustProxy,
    bodyLimit: 2 * 1024 * 1024,
  });
  const log: Logger = app.log;

  const db = openDatabase(path.join(config.dataDir, 'portal.db'));
  const repo = new Repo(db, { allowed: config.allowedDids, excluded: config.excludedDids });
  const interrupted = repo.failInterruptedSends();
  if (interrupted) log.warn({ count: interrupted }, 'Messages left sending by a restart were marked failed');
  const events = new EventHub();
  const auth = new Auth(repo, config.appPassword, config.sessionDays);
  const credentials = new CredentialStore(
    repo,
    config.appPassword,
    config.demo ? { username: 'demo@example.com', password: 'demo' } : config.voipmsEnv,
  );

  // The demo has one sample account per id, kept for the life of the server.
  const demoClients = new Map<number, DemoVoipMs>();
  const clientFor = (creds: VoipMsCredentials, accountId = PRIMARY_ACCOUNT): VoipMsApi => {
    if (config.demo) {
      if (!demoClients.has(accountId)) demoClients.set(accountId, new DemoVoipMs(config.voipmsTimezone, accountId));
      return demoClients.get(accountId)!;
    }
    return options.clientFactory?.(creds, accountId) ?? new VoipMsClient(creds);
  };
  const isSetupCompleted = () => repo.getSetting(SETUP_COMPLETED_KEY) === '1';

  const media = new MediaStore(path.join(config.dataDir, 'media'), repo, {
    log,
    fetch: options.mediaFetch,
    onAttachmentChange: (messageId) => {
      const message = repo.getMessage(messageId);
      const conversation = message ? repo.getConversation(message.conversationId) : null;
      if (message && conversation) events.broadcast({ type: 'message', message, conversation });
    },
  });
  await media.init();

  const push = new PushService({
    repo,
    events,
    log,
    subject: config.vapidSubject,
    ownerFingerprint: credentials.fingerprint('push-subscriptions'),
    fetch: options.pushFetch,
  });

  const accounts = new Accounts({
    repo,
    events,
    media,
    credentials,
    clientFor,
    isSetupCompleted,
    timeZone: config.voipmsTimezone,
    pollActiveMs: config.pollActiveMs,
    pollIdleMs: config.pollIdleMs,
    publicOrigin: config.publicOrigin,
    log,
    onIncoming: (items) => push.notifyIncoming(items),
  });
  const sender = new MessageSender({ repo, events, media, accountForDid: (did) => accounts.forDid(did), log });
  const deletions = new RemoteDeletions({ repo, clientForDid: (did) => accounts.forDid(did)?.client() ?? null, log });
  // Deletions at VoIP.ms left over from before a restart.
  deletions.kick();
  events.onClientCountChange((count) => accounts.setActive(count > 0));

  if (config.demo && repo.listContacts().length === 0) {
    for (const c of DEMO_CONTACTS) repo.saveContact(c);
  }

  const services: Services = {
    config,
    repo,
    events,
    media,
    credentials,
    auth,
    accounts,
    sync: accounts,
    sender,
    deletions,
    push,
    webhook: accounts.primary().webhook,
    updates: new UpdateChecker({
      repo,
      version: VERSION,
      enabled: config.updateCheck,
      manifestUrl: config.updateManifestUrl,
      install: config.install,
      fetch: options.updateFetch,
    }),
    client: () => accounts.primary().client(),
    clientFor,
    resetClient: () => accounts.primary().resetClient(),
    isSetupCompleted,
    setSetupCompleted: (done) => repo.setSetting(SETUP_COMPLETED_KEY, done ? '1' : '0'),
  };

  await app.register(cookie);
  await app.register(multipart, {
    limits: { files: MAX_ATTACHMENTS, fileSize: MAX_ATTACHMENT_BYTES, fields: 10, fieldSize: 64 * 1024 },
  });
  await app.register(rateLimit, { global: false });

  app.addHook('onSend', async (_req, reply, payload) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Referrer-Policy', 'no-referrer');
    reply.header('X-Frame-Options', 'DENY');
    if (!reply.hasHeader('Content-Security-Policy')) {
      reply.header(
        'Content-Security-Policy',
        "default-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; style-src 'self' 'unsafe-inline'; " +
          "script-src 'self' 'wasm-unsafe-eval'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
      );
    }
    return payload;
  });

  const publicRoutes = new Set(['/api/health', '/api/session', '/api/auth/login', '/api/auth/logout', '/api/voipms/callback/:token']);
  app.decorateRequest('user', null);
  app.addHook('onRequest', async (req, reply) => {
    // Decide on the route the router matched, never on the raw URL: "/%61pi/..." or an
    // absolute-form request line would otherwise reach /api handlers unauthenticated.
    const route = req.routeOptions.url;
    if (!route?.startsWith('/api/')) return;
    if (req.method !== 'GET' && req.method !== 'HEAD' && !sameOrigin(req, config.publicOrigin)) {
      return reply.code(403).send({ error: 'bad_origin' });
    }
    req.user = auth.verify(req.cookies[SESSION_COOKIE]);
    if (publicRoutes.has(route)) return;
    if (!req.user) return reply.code(401).send({ error: 'unauthorized' });
    if (req.routeOptions.config.admin && req.user.role === 'user') return reply.code(403).send({ error: 'forbidden' });
  });

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof ZodError) return reply.code(400).send({ error: 'invalid_request', message: err.issues[0]?.message });
    if (err instanceof SendError) return reply.code(err.statusCode).send({ error: err.code });
    if (err instanceof VoipMsError) return reply.code(502).send({ error: err.code, message: err.message });
    const status = (err as { statusCode?: number }).statusCode;
    const code = (err as { code?: string }).code;
    if (code === 'FST_REQ_FILE_TOO_LARGE') return reply.code(413).send({ error: 'attachment_too_large' });
    if (code === 'FST_FILES_LIMIT') return reply.code(413).send({ error: 'too_many_attachments' });
    if (status === 413) return reply.code(413).send({ error: 'payload_too_large' });
    // The sign-in page tells this one apart.
    if (status === 429) return reply.code(429).send({ error: 'rate_limited' });
    if (status && status >= 400 && status < 500) {
      return reply.code(status).send({ error: (err as { code?: string }).code ?? 'bad_request', message: (err as Error).message });
    }
    req.log.error({ err }, 'Unhandled error');
    return reply.code(500).send({ error: 'internal_error' });
  });

  app.get('/api/health', async () => ({ ok: true }));

  registerAuthRoutes(app, services);
  registerSetupRoutes(app, services);
  registerWebhookRoutes(app, services);
  registerAccountRoutes(app, services);
  registerUserRoutes(app, services);
  registerMessagingRoutes(app, services);
  registerContactRoutes(app, services);
  registerPushRoutes(app, services);
  registerUpdateRoutes(app, services);

  if (fs.existsSync(path.join(config.webDir, 'index.html'))) {
    await app.register(fastifyStatic, {
      root: config.webDir,
      wildcard: false,
      index: false,
      setHeaders: (res, filePath) => {
        // Vite fingerprints everything under assets/.
        if (filePath.includes(`${path.sep}assets${path.sep}`)) res.header('Cache-Control', 'public, max-age=31536000, immutable');
      },
    });
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith('/api/') || req.method !== 'GET') return reply.code(404).send({ error: 'not_found' });
      return reply.header('Cache-Control', 'no-cache').sendFile('index.html');
    });
  } else {
    app.setNotFoundHandler((_req, reply) => reply.code(404).send({ error: 'not_found' }));
  }

  // Live update streams never end on their own, and Fastify waits for open
  // requests before onClose: end them first, or shutting down hangs.
  app.addHook('preClose', async () => {
    accounts.stop();
    events.close();
  });
  app.addHook('onClose', async () => {
    await Promise.all([media.stop(), deletions.stop()]);
    db.close();
  });

  return { app, services };
}

/** Rejects cross-site state-changing requests (on top of SameSite=Lax cookies). */
function sameOrigin(req: FastifyRequest, publicOrigin: string | null): boolean {
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    const url = new URL(origin);
    return url.origin === publicOrigin || url.host === req.headers.host;
  } catch {
    return false;
  }
}
