import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildApp, type Services } from './app.js';
import { loadConfig } from './config.js';
import { FakeVoipMs } from './test/fake-client.js';
import { readVersion } from './version.js';
import { browserKeys, decryptPayload } from './test/webpush-helpers.js';
import type { EventsPollDto } from '../shared/types.js';

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);

let app: FastifyInstance;
let services: Services;
let client: FakeVoipMs;
let dataDir: string;
let cookie = '';
/** Requests made to push services, and the status they answer. */
let pushed: { url: string; headers: Record<string, string>; body: Buffer }[] = [];
let pushStatus = 201;

const pushFetch = (async (url: string, init: RequestInit) => {
  pushed.push({ url, headers: init.headers as Record<string, string>, body: init.body as Buffer });
  return new Response(null, { status: pushStatus });
}) as unknown as typeof fetch;

/** Media servers stay offline in tests; answers come late, like a real network. */
const mediaFetch = (async (_url: string, init?: RequestInit) => {
  await new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, 200);
    init?.signal?.addEventListener('abort', () => {
      clearTimeout(timer);
      reject(init.signal!.reason);
    });
  });
  return new Response('not found', { status: 404 });
}) as unknown as typeof fetch;

async function start(env: Record<string, string> = {}, dir?: string) {
  dataDir = dir ?? fs.mkdtempSync(path.join(os.tmpdir(), 'portal-test-'));
  client = new FakeVoipMs();
  pushed = [];
  pushStatus = 201;
  const config = loadConfig({ APP_PASSWORD: 'hunter2', DATA_DIR: dataDir, WEB_DIR: path.join(dataDir, 'none'), ...env });
  ({ app, services } = await buildApp(config, { clientFactory: () => client, logger: false, pushFetch, mediaFetch }));
}

async function login() {
  const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { password: 'hunter2' } });
  expect(res.statusCode).toBe(200);
  cookie = String(res.headers['set-cookie']).split(';')[0]!;
}

function multipart(fields: Record<string, string>, files: { name: string; type: string; data: Buffer }[] = []) {
  const boundary = '----test' + Math.random().toString(16).slice(2);
  const chunks: Buffer[] = [];
  for (const [k, v] of Object.entries(fields)) {
    chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
  }
  for (const f of files) {
    chunks.push(
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="files"; filename="${f.name}"\r\nContent-Type: ${f.type}\r\n\r\n`),
      f.data,
      Buffer.from('\r\n'),
    );
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return { payload: Buffer.concat(chunks), headers: { 'content-type': `multipart/form-data; boundary=${boundary}`, cookie } };
}

const waitFor = async (check: () => boolean) => {
  for (let i = 0; i < 100 && !check(); i++) await new Promise((r) => setTimeout(r, 10));
};

afterEach(async () => {
  await app.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
  cookie = '';
});

describe('authentication', () => {
  beforeEach(() => start());

  it('requires the password for the API', async () => {
    expect((await app.inject({ url: '/api/conversations' })).statusCode).toBe(401);
    const wrong = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { password: 'nope' } });
    expect(wrong.statusCode).toBe(401);
    await login();
    expect((await app.inject({ url: '/api/conversations', headers: { cookie } })).statusCode).toBe(200);
  });

  it('reports the version of package.json, even when not started by npm', async () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, '..', 'package.json'), 'utf8')) as { version: string };
    expect((await app.inject({ url: '/api/session' })).json().version).toBe(pkg.version);
    expect(readVersion(os.tmpdir())).toBe('unknown');
  });

  it('shuts down promptly while a tab keeps the live updates stream open', async () => {
    await login();
    await app.listen({ port: 0, host: '127.0.0.1' });
    const { port } = app.server.address() as import('node:net').AddressInfo;
    const http = await import('node:http');
    const streamClosed = new Promise<void>((resolve, reject) => {
      http
        .get({ port, host: '127.0.0.1', path: '/api/events', headers: { cookie } }, (res) => {
          res.resume();
          res.on('end', resolve);
        })
        .on('error', reject);
    });
    await waitFor(() => services.events.clientCount === 1);
    const closed = app.close().then(() => 'closed');
    const timeout = new Promise((r) => setTimeout(() => r('timeout'), 3000));
    expect(await Promise.race([closed, timeout])).toBe('closed');
    await streamClosed;
    // afterEach closes it again: make that a no-op on a fresh instance.
    await start();
  });

  it('reports the session state', async () => {
    const res = await app.inject({ url: '/api/session' });
    expect(res.json()).toMatchObject({
      authenticated: false,
      setupCompleted: false,
      credentialsSource: null,
      pollActiveSeconds: 10,
      liveUpdates: 'stream',
    });
  });

  it('blocks cross-site writes', async () => {
    await login();
    const res = await app.inject({
      method: 'POST',
      url: '/api/sync/now',
      headers: { cookie, origin: 'https://evil.example', host: 'portal.local' },
    });
    expect(res.statusCode).toBe(403);
  });

  it('trusts PUBLIC_URL behind a proxy that rewrites Host and drops the protocol', async () => {
    await app.close();
    await start({ PUBLIC_URL: 'https://sms.example.com/' });
    const login = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { origin: 'https://sms.example.com', host: '127.0.0.1:3100' },
      payload: { password: 'hunter2' },
    });
    expect(login.statusCode).toBe(200);
    expect(String(login.headers['set-cookie'])).toMatch(/; Secure/);
    const evil = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { origin: 'https://evil.example', host: '127.0.0.1:3100' },
      payload: { password: 'hunter2' },
    });
    expect(evil.statusCode).toBe(403);
    expect(() => loadConfig({ APP_PASSWORD: 'x', PUBLIC_URL: 'sms.example.com' })).toThrow(/PUBLIC_URL/);
  });

  it('cannot be bypassed with an encoded or absolute-form path', async () => {
    expect((await app.inject({ url: '/%61pi/setup/status' })).statusCode).toBe(401);
    expect((await app.inject({ url: '/api/%63onversations' })).statusCode).toBe(401);
    const write = await app.inject({
      method: 'POST',
      url: '/%61pi/contacts',
      payload: { name: 'x', phones: ['4383980707'] },
    });
    expect(write.statusCode).toBe(401);
    expect(services.repo.listContacts()).toEqual([]);
  });

  it('sends the user back to the wizard when stored credentials cannot be read', async () => {
    services.credentials.save({ username: 'a@b.c', password: 'x' });
    services.setSetupCompleted(true);
    await login();
    expect((await app.inject({ url: '/api/session', headers: { cookie } })).json().setupCompleted).toBe(true);
    services.repo.setSetting('voipms.credentials', '{"iv":"AAAA","tag":"AAAA","data":"AAAA"}');
    expect((await app.inject({ url: '/api/session', headers: { cookie } })).json().setupCompleted).toBe(false);
  });

  it('refuses to start without APP_PASSWORD', () => {
    expect(() => loadConfig({})).toThrow(/APP_PASSWORD/);
  });

  it('removes quotes that --env-file keeps around values', () => {
    const config = loadConfig({
      APP_PASSWORD: '"s3cret"',
      VOIPMS_API_USERNAME: '"me@example.com"',
      VOIPMS_API_PASSWORD: "'api-pass'",
      PUBLIC_URL: ' "https://sms.example.com" ',
      POLL_INTERVAL_IDLE: '"20"',
    });
    expect(config).toMatchObject({
      appPassword: 's3cret',
      voipmsEnv: { username: 'me@example.com', password: 'api-pass' },
      publicOrigin: 'https://sms.example.com',
      pollIdleMs: 20_000,
    });
    expect(config.warnings).toHaveLength(5);
    expect(config.warnings[0]).toMatch(/^APP_PASSWORD was wrapped in quotes/);
    // Quotes inside a value, or unmatched, are part of it.
    const kept = loadConfig({ APP_PASSWORD: 'pa"ss"', VOIPMS_API_USERNAME: '"me@example.com', VOIPMS_API_PASSWORD: 'x' });
    expect(kept.appPassword).toBe('pa"ss"');
    expect(kept.voipmsEnv?.username).toBe('"me@example.com');
    expect(kept.warnings).toEqual([]);
  });

  it('checks VAPID_SUBJECT', () => {
    expect(loadConfig({ APP_PASSWORD: 'x', VAPID_SUBJECT: '' }).vapidSubject).toMatch(/^https:\/\//);
    expect(loadConfig({ APP_PASSWORD: 'x', VAPID_SUBJECT: 'mailto:me@example.com' }).vapidSubject).toBe('mailto:me@example.com');
    expect(() => loadConfig({ APP_PASSWORD: 'x', VAPID_SUBJECT: 'me@example.com' })).toThrow(/VAPID_SUBJECT/);
  });

  it('checks LIVE_UPDATES', () => {
    expect(loadConfig({ APP_PASSWORD: 'x' }).liveUpdates).toBe('stream');
    expect(loadConfig({ APP_PASSWORD: 'x', LIVE_UPDATES: ' Poll ' }).liveUpdates).toBe('poll');
    expect(() => loadConfig({ APP_PASSWORD: 'x', LIVE_UPDATES: 'sse' })).toThrow(/LIVE_UPDATES/);
  });
});

describe('setup wizard', () => {
  beforeEach(async () => {
    await start();
    await login();
  });

  it('validates and stores credentials, encrypted', async () => {
    client.failNext.getBalance = 'ip_not_enabled';
    const res = await app.inject({
      method: 'POST',
      url: '/api/setup/credentials',
      headers: { cookie },
      payload: { username: 'me@example.com', password: 'api-secret' },
    });
    expect(res.json()).toEqual({ ip: '198.51.100.7', status: 'ip_not_enabled', balance: null });
    expect(services.credentials.get()).toEqual({ username: 'me@example.com', password: 'api-secret' });
    expect(services.repo.getSetting('voipms.credentials')).not.toContain('api-secret');

    const test = await app.inject({ method: 'POST', url: '/api/setup/test', headers: { cookie } });
    expect(test.json()).toMatchObject({ status: 'success', balance: 24.1175 });
  });

  it('rejects wrong credentials without saving them', async () => {
    client.failNext.getIP = 'invalid_credentials';
    const res = await app.inject({
      method: 'POST',
      url: '/api/setup/credentials',
      headers: { cookie },
      payload: { username: 'me@example.com', password: 'bad' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: 'invalid_credentials' });
    expect(services.credentials.get()).toBeNull();
  });

  it('lists numbers and completes', async () => {
    services.credentials.save({ username: 'a@b.c', password: 'x' });
    services.resetClient();
    const dids = await app.inject({ url: '/api/setup/dids', headers: { cookie } });
    expect(dids.json().map((d: { did: string }) => d.did)).toEqual(['4506575294', '5143604702']);
    await app.inject({ method: 'POST', url: '/api/setup/complete', headers: { cookie } });
    expect((await app.inject({ url: '/api/session', headers: { cookie } })).json().setupCompleted).toBe(true);
  });

  it('shows a number once SMS is turned on for it in VoIP.ms, then leaves it as the user sets it', async () => {
    client.dids[1]!.smsEnabled = false;
    services.credentials.save({ username: 'a@b.c', password: 'x' });
    services.resetClient();
    const refresh = async () => {
      await app.inject({ url: '/api/setup/dids', headers: { cookie } });
      return services.repo.getDid('5143604702')!.visible;
    };
    expect(await refresh()).toBe(false);
    client.dids[1]!.smsEnabled = true;
    expect(await refresh()).toBe(true);
    await app.inject({ method: 'PATCH', url: '/api/dids/5143604702', headers: { cookie }, payload: { visible: false } });
    expect(await refresh()).toBe(false);
  });

  it('turns SMS on only where VoIP.ms offers it', async () => {
    client.dids.push({ did: '8335550142', description: 'Sans frais', smsAvailable: false, smsEnabled: false, mmsAvailable: false });
    services.credentials.save({ username: 'a@b.c', password: 'x' });
    services.resetClient();
    await app.inject({ url: '/api/setup/dids', headers: { cookie } });
    const tollFree = await app.inject({ method: 'POST', url: '/api/dids/8335550142/enable-sms', headers: { cookie } });
    expect(tollFree.statusCode).toBe(409);
    expect(tollFree.json()).toEqual({ error: 'sms_not_available' });
    expect(services.repo.getDid('8335550142')).toMatchObject({ smsEnabled: false, smsAvailable: false, visible: false });
  });
});

describe('messaging', () => {
  beforeEach(async () => {
    await start({ VOIPMS_API_USERNAME: 'me@example.com', VOIPMS_API_PASSWORD: 'x' });
    await login();
    await app.inject({ url: '/api/setup/dids', headers: { cookie } });
    await app.inject({ method: 'POST', url: '/api/setup/complete', headers: { cookie } });
  });

  async function send(fields: Record<string, string>, files: { name: string; type: string; data: Buffer }[] = []) {
    const res = await app.inject({ method: 'POST', url: '/api/messages', ...multipart(fields, files) });
    return res;
  }

  it('sends an SMS and records VoIP.ms id', async () => {
    const res = await send({ did: '4506575294', to: '438-398-0707', body: 'Allô!' });
    expect(res.statusCode).toBe(202);
    const { message, conversation } = res.json();
    expect(message).toMatchObject({ status: 'sending', kind: 'sms', direction: 'out' });
    expect(conversation).toMatchObject({ did: '4506575294', phone: '4383980707' });
    await waitFor(() => services.repo.getMessage(message.id)?.status === 'sent');
    expect(services.repo.getMessage(message.id)).toMatchObject({ status: 'sent' });
    expect(client.sent).toEqual([{ kind: 'sms', did: '4506575294', dst: '4383980707', message: 'Allô!', media: [] }]);
  });

  it('sends long accented texts as MMS', async () => {
    const body = 'é'.repeat(10) + 'a'.repeat(150);
    const { message } = (await send({ did: '4506575294', to: '4383980707', body })).json();
    expect(message.kind).toBe('mms');
    await waitFor(() => client.sent.length === 1);
    expect(client.sent[0]!.kind).toBe('mms');
  });

  it('sends attachments as data URIs and serves them back safely', async () => {
    const res = await send({ did: '4506575294', to: '4383980707', body: '' }, [{ name: 'dot.png', type: 'image/png', data: PNG }]);
    const { message } = res.json();
    expect(message.attachments).toEqual([expect.objectContaining({ mime: 'image/png', status: 'ready' })]);
    await waitFor(() => client.sent.length === 1);
    expect(client.sent[0]!.media[0]).toBe(`data:image/png;base64,${PNG.toString('base64')}`);

    const media = await app.inject({ url: message.attachments[0].url, headers: { cookie } });
    expect(media.statusCode).toBe(200);
    expect(media.headers['content-type']).toBe('image/png');
    expect(media.headers['content-security-policy']).toContain('sandbox');
    expect(media.rawPayload.equals(PNG)).toBe(true);
  });

  it('refuses risky attachment types', async () => {
    const res = await send({ did: '4506575294', to: '4383980707', body: 'x' }, [
      { name: 'evil.html', type: 'text/html', data: Buffer.from('<script>alert(1)</script>') },
    ]);
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: 'unsupported_attachment' });
  });

  it('validates the destination and the DID', async () => {
    expect((await send({ did: '4506575294', to: '123', body: 'x' })).json()).toEqual({ error: 'invalid_destination' });
    expect((await send({ did: '9999999999', to: '4383980707', body: 'x' })).json()).toEqual({ error: 'unknown_did' });
  });

  it('deletes at VoIP.ms in the background, trying again after a failure that may pass', async () => {
    const [gone, kept] = ['À effacer', 'À garder', 'Refusé'].map((body) => client.push({ direction: 'in', body, contact: '4383980707' }));
    await services.sync.syncRecent();
    const conversation = services.repo.listConversations()[0]!;
    const local = (body: string) => services.repo.listMessages(conversation.id).find((m) => m.body === body)!;
    const del = (id: number) => app.inject({ method: 'DELETE', url: `/api/messages/${id}?voipms=1`, headers: { cookie } });

    client.failNext.deleteMessage = 'network_error';
    expect((await del(local('À effacer').id)).json()).toEqual({ ok: true });
    await vi.waitFor(() => expect(client.failNext.deleteMessage).toBeUndefined());
    expect(services.repo.pendingRemoteDeletes(10)).toHaveLength(1);
    // A minute later, or on the next deletion:
    services.deletions.kick();
    await vi.waitFor(() => expect(client.deleted).toEqual([{ kind: 'sms', id: gone!.id }]));
    expect(services.repo.pendingRemoteDeletes(10)).toEqual([]);

    // A refusal is final: the message stays deleted here.
    client.failNext.deleteMessage = 'invalid_sms';
    await del(local('Refusé').id);
    await vi.waitFor(() => expect(services.repo.pendingRemoteDeletes(10)).toEqual([]));
    expect(client.deleted).toHaveLength(1);
    expect(services.repo.listMessages(conversation.id).map((m) => m.body)).toEqual([kept!.body]);
  });

  it('does not delete a message still being sent', async () => {
    await send({ did: '4506575294', to: '4383980707', body: 'Premier' });
    const conversation = services.repo.listConversations()[0]!;
    const id = services.repo.insertMessage({
      conversationId: conversation.id,
      kind: 'sms',
      remoteId: null,
      direction: 'out',
      body: 'En route',
      sentAt: Date.now(),
      status: 'sending',
    });
    const res = await app.inject({ method: 'DELETE', url: `/api/messages/${id}`, headers: { cookie } });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: 'still_sending' });
    // Deleting the conversation leaves it too.
    await app.inject({ method: 'DELETE', url: `/api/conversations/${conversation.id}`, headers: { cookie } });
    expect(services.repo.listMessages(conversation.id).map((m) => m.body)).toEqual(['En route']);
  });

  it('marks failed sends and retries them', async () => {
    client.failNext.sendSms = 'limit_reached';
    const { message } = (await send({ did: '4506575294', to: '4383980707', body: 'Hello' })).json();
    await waitFor(() => services.repo.getMessage(message.id)?.status === 'failed');
    expect(services.repo.getMessage(message.id)).toMatchObject({ status: 'failed', error: 'limit_reached' });
    const retry = await app.inject({ method: 'POST', url: `/api/messages/${message.id}/retry`, headers: { cookie } });
    expect(retry.statusCode).toBe(200);
    await waitFor(() => services.repo.getMessage(message.id)?.status === 'sent');
    expect(services.repo.getMessage(message.id)!.status).toBe('sent');
  });

  it('checks the history before re-sending after an ambiguous failure', async () => {
    client.failNext.sendSms = 'http_error';
    const { message } = (await send({ did: '4506575294', to: '4383980707', body: 'Maybe sent' })).json();
    await waitFor(() => services.repo.getMessage(message.id)?.status === 'failed');
    // VoIP.ms had accepted it after all.
    client.push({ kind: 'sms', direction: 'out', body: 'Maybe sent' });
    const retry = await app.inject({ method: 'POST', url: `/api/messages/${message.id}/retry`, headers: { cookie } });
    expect(retry.json()).toMatchObject({ id: message.id, status: 'sent' });
    expect(client.sent).toEqual([]);
    expect(services.repo.listMessages(message.conversationId)).toHaveLength(1);
  });

  it('marks sends interrupted by a restart as failed', async () => {
    const conversationId = services.repo.getOrCreateConversation('4506575294', '4383980707');
    const id = services.repo.insertMessage({
      conversationId,
      kind: 'sms',
      remoteId: null,
      direction: 'out',
      body: 'cut off',
      sentAt: Date.now(),
      status: 'sending',
    });
    const config = services.config;
    await app.close();
    ({ app, services } = await buildApp(config, { clientFactory: () => client, logger: false }));
    expect(services.repo.getMessage(id)).toMatchObject({ status: 'failed', error: 'interrupted' });
  });

  it('reports too many attachments distinctly', async () => {
    const file = { name: 'a.png', type: 'image/png', data: PNG };
    const res = await send({ did: '4506575294', to: '4383980707', body: '' }, [file, file, file, file]);
    expect(res.statusCode).toBe(413);
    expect(res.json()).toEqual({ error: 'too_many_attachments' });
  });

  it('finds conversations by number typed with the country code', async () => {
    await send({ did: '4506575294', to: '4383980707', body: 'Hi' });
    const found = (await app.inject({ url: `/api/conversations?q=${encodeURIComponent('+1 438-398')}`, headers: { cookie } })).json();
    expect(found).toHaveLength(1);
  });

  it('does not show a sent message twice once the poll sees it', async () => {
    const { message } = (await send({ did: '4506575294', to: '4383980707', body: 'Once' })).json();
    await waitFor(() => client.sent.length === 1);
    await waitFor(() => services.repo.getMessage(message.id)?.status === 'sent');
    const remoteId = services.repo.getMessageRow(message.id)!.remote_id!;
    client.push({ kind: 'sms', id: remoteId, direction: 'out', body: 'Once', carrierStatus: 'Delivered' });
    await services.sync.syncRecent();
    const list = services.repo.listMessages(message.conversationId);
    expect(list).toHaveLength(1);
    expect(list[0]!.carrierStatus).toBe('Delivered');
  });

  it('marks conversations read and filters by search', async () => {
    await services.sync.syncRecent();
    client.push({ direction: 'in', body: 'Rendez-vous chez le dentiste', contact: '5145551234' });
    services.repo.setSetting('sync.lastSuccessAt', String(Date.now()));
    await services.sync.syncRecent();
    const list = (await app.inject({ url: '/api/conversations', headers: { cookie } })).json();
    const conv = list.find((c: { phone: string }) => c.phone === '5145551234');
    expect(conv.unreadCount).toBe(1);
    await app.inject({ method: 'POST', url: `/api/conversations/${conv.id}/read`, headers: { cookie } });
    expect(services.repo.getConversation(conv.id)!.unreadCount).toBe(0);
    const found = (await app.inject({ url: '/api/conversations?q=dentiste', headers: { cookie } })).json();
    expect(found.map((c: { id: number }) => c.id)).toEqual([conv.id]);
  });

  it('searches without regard to accents or case, in messages and contact names', async () => {
    await services.sync.syncRecent();
    client.push({ direction: 'in', body: 'Ça coûte 40 $ pour la vidange, à tantôt', contact: '5145551234' });
    client.push({ direction: 'in', body: 'Bonjour', contact: '4505550111' });
    services.repo.setSetting('sync.lastSuccessAt', String(Date.now()));
    await services.sync.syncRecent();
    services.repo.saveContact({ name: 'Garage Bélanger', phones: ['4505550111'] });
    const search = async (q: string) =>
      (await app.inject({ url: `/api/conversations?q=${encodeURIComponent(q)}`, headers: { cookie } }))
        .json()
        .map((c: { phone: string }) => c.phone);
    expect(await search('cout')).toEqual(['5145551234']);
    expect(await search('A TANTOT')).toEqual(['5145551234']);
    expect(await search('Coûte')).toEqual(['5145551234']);
    expect(await search('belanger')).toEqual(['4505550111']);
    expect(await search('BÉLANGER')).toEqual(['4505550111']);
    expect(await search('40 %')).toEqual([]);
  });

  it('archives conversations until a new message arrives', async () => {
    await services.sync.syncRecent();
    client.push({ direction: 'in', body: 'Premier', contact: '5145551234' });
    services.repo.setSetting('sync.lastSuccessAt', String(Date.now() - 60_000));
    await services.sync.syncRecent();
    const conv = services.repo.listConversations()[0]!;
    expect(services.repo.listDids().find((d) => d.did === conv.did)!.unreadCount).toBe(1);

    const res = await app.inject({ method: 'PATCH', url: `/api/conversations/${conv.id}`, headers: { cookie }, payload: { archived: true } });
    expect(res.json()).toMatchObject({ id: conv.id, archived: true });
    const list = async (query = '') => (await app.inject({ url: `/api/conversations${query}`, headers: { cookie } })).json();
    expect(await list()).toEqual([]);
    expect((await list('?archived=1')).map((c: { id: number }) => c.id)).toEqual([conv.id]);
    // Search looks into archived conversations too, unless told otherwise.
    expect(await list('?q=premier')).toHaveLength(1);
    expect(await list('?q=premier&archived=0')).toHaveLength(0);
    // Archived conversations do not count in the badges.
    expect(services.repo.listDids().find((d) => d.did === conv.did)!.unreadCount).toBe(0);

    client.push({ direction: 'in', body: 'Deuxième', contact: '5145551234' });
    await services.sync.syncRecent();
    expect(services.repo.getConversation(conv.id)!.archived).toBe(false);

    await app.inject({ method: 'PATCH', url: `/api/conversations/${conv.id}`, headers: { cookie }, payload: { archived: true } });
    await send({ did: conv.did, to: conv.phone, body: 'Réponse' });
    expect(services.repo.getConversation(conv.id)!.archived).toBe(false);

    const missing = await app.inject({ method: 'PATCH', url: '/api/conversations/999', headers: { cookie }, payload: { archived: true } });
    expect(missing.statusCode).toBe(404);
  });

  it('keeps conversations archived when older history is imported', async () => {
    await services.sync.syncRecent();
    client.push({ direction: 'in', body: 'Récent', contact: '5145551234' });
    services.repo.setSetting('sync.lastSuccessAt', String(Date.now() - 60_000));
    await services.sync.syncRecent();
    const conv = services.repo.listConversations()[0]!;
    services.repo.setArchived(conv.id, true);
    const old = new Date(Date.now() - 40 * 86_400_000);
    client.push({ direction: 'in', body: 'Vieux', contact: '5145551234', date: old.toISOString().slice(0, 19).replace('T', ' ') });
    await services.sync.importHistory(60);
    expect(services.repo.listMessages(conv.id)).toHaveLength(2);
    expect(services.repo.getConversation(conv.id)!.archived).toBe(true);
  });
});

describe('live updates by polling', () => {
  beforeEach(async () => {
    await start({ VOIPMS_API_USERNAME: 'me@example.com', VOIPMS_API_PASSWORD: 'x', LIVE_UPDATES: 'poll' });
    await login();
    await app.inject({ url: '/api/setup/dids', headers: { cookie } });
    await app.inject({ method: 'POST', url: '/api/setup/complete', headers: { cookie } });
  });

  const poll = async (query: Record<string, string> = {}): Promise<EventsPollDto> => {
    const res = await app.inject({ url: `/api/events/poll?${new URLSearchParams({ tab: 'tab-00000001', ...query })}`, headers: { cookie } });
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    return res.json();
  };

  it('is what the session asks for, and needs to be signed in', async () => {
    expect((await app.inject({ url: '/api/session' })).json().liveUpdates).toBe('poll');
    expect((await app.inject({ url: '/api/events/poll' })).statusCode).toBe(401);
    expect((await app.inject({ url: '/api/events/poll?tab=x', headers: { cookie } })).statusCode).toBe(400);
  });

  it('serves the events the stream sends, from where the tab left off', async () => {
    // A polling tab counts as open: VoIP.ms is checked at the faster pace.
    const first = await poll();
    expect(first.events).toEqual([{ type: 'sync', status: expect.objectContaining({ mode: 'active' }) }]);
    await app.inject({ method: 'PATCH', url: '/api/dids/4506575294', headers: { cookie }, payload: { label: 'Bureau' } });
    const next = await poll({ after: first.cursor });
    expect(next).toMatchObject({ events: [{ type: 'dids' }, { type: 'reload' }], reset: false });
    expect(await poll({ after: next.cursor })).toMatchObject({ events: [], reset: false });
    // A cursor from before a restart: the tab reloads everything, and learns the sync state again.
    expect(await poll({ after: 'gone.3' })).toMatchObject({ events: [{ type: 'sync' }], reset: true });
  });
});

describe('contacts', () => {
  beforeEach(async () => {
    await start();
    await login();
  });

  it('creates, refuses duplicates unless forced, and deletes', async () => {
    const a = await app.inject({ method: 'POST', url: '/api/contacts', headers: { cookie }, payload: { name: 'Gab', phones: ['438 398-0707'] } });
    expect(a.statusCode).toBe(201);
    expect(a.json()).toMatchObject({ name: 'Gab', phones: ['4383980707'] });

    const dup = await app.inject({ method: 'POST', url: '/api/contacts', headers: { cookie }, payload: { name: 'Other', phones: ['4383980707'] } });
    expect(dup.statusCode).toBe(409);
    const forced = await app.inject({
      method: 'POST',
      url: '/api/contacts',
      headers: { cookie },
      payload: { name: 'Other', phones: ['4383980707'], force: true },
    });
    expect(forced.statusCode).toBe(201);
    // The first contact lost its only number and is gone.
    expect(services.repo.listContacts().map((c) => c.name)).toEqual(['Other']);

    const del = await app.inject({ method: 'DELETE', url: `/api/contacts/${forced.json().id}`, headers: { cookie } });
    expect(del.statusCode).toBe(200);
    expect(services.repo.listContacts()).toEqual([]);
  });

  it('imports vCards', async () => {
    const vcard = [
      'BEGIN:VCARD',
      'VERSION:3.0',
      'FN:Marie Tremblay',
      'TEL;TYPE=CELL:+1 438-555-0142',
      'TEL;TYPE=WORK:+33 1 23 45 67 89',
      'END:VCARD',
      'BEGIN:VCARD',
      'VERSION:2.1',
      'N;CHARSET=UTF-8;ENCODING=QUOTED-PRINTABLE:B=C3=A9langer;Garage;;;',
      'TEL:(450) 555-0111',
      'END:VCARD',
      'BEGIN:VCARD',
      'FN:No phone',
      'END:VCARD',
    ].join('\r\n');
    const res = await app.inject({ method: 'POST', url: '/api/contacts/import', headers: { cookie }, payload: { vcard } });
    // With the new contacts' ids, for Undo.
    const ids = services.repo.listContacts().map((c) => c.id);
    expect(res.json()).toEqual({ imported: 2, skipped: 0, ids: expect.arrayContaining(ids) });
    expect(services.repo.listContacts()).toEqual([
      expect.objectContaining({ name: 'Garage Bélanger', phones: ['4505550111'] }),
      expect.objectContaining({ name: 'Marie Tremblay', phones: ['4385550142'] }),
    ]);
  });
});

describe('push notifications', () => {
  const ua = browserKeys();
  const endpoint = 'https://push.example.net/send/abc123';
  const subscription = { endpoint, expirationTime: null, keys: { p256dh: ua.p256dh, auth: ua.auth } };

  beforeEach(async () => {
    await start({ VOIPMS_API_USERNAME: 'me@example.com', VOIPMS_API_PASSWORD: 'x' });
    await login();
    await app.inject({ url: '/api/setup/dids', headers: { cookie } });
    await app.inject({ method: 'POST', url: '/api/setup/complete', headers: { cookie } });
    await services.sync.syncRecent();
    services.repo.setSetting('sync.lastSuccessAt', String(Date.now() - 60_000));
  });

  const subscribe = (body: object) => app.inject({ method: 'POST', url: '/api/push/subscriptions', headers: { cookie }, payload: body });
  const received = () => pushed.map((p) => JSON.parse(decryptPayload(p.body, ua.private, ua.authSecret)));

  it('needs a session and validates subscriptions', async () => {
    expect((await app.inject({ url: '/api/push/key' })).statusCode).toBe(401);
    const key = (await app.inject({ url: '/api/push/key', headers: { cookie } })).json().publicKey;
    expect(Buffer.from(key, 'base64url')).toHaveLength(65);
    expect((await subscribe({ ...subscription, endpoint: 'http://push.example.net/x' })).statusCode).toBe(400);
    expect((await subscribe({ ...subscription, keys: { ...subscription.keys, p256dh: 'AAAA' } })).statusCode).toBe(400);
    expect((await subscribe({ ...subscription, keys: { ...subscription.keys, auth: 'AAAA' } })).statusCode).toBe(400);
    expect((await subscribe({ ...subscription, device: 'device-0001', lang: 'en' })).statusCode).toBe(200);
    expect(services.repo.listPushSubscriptions()).toMatchObject([{ endpoint, device: 'device-0001', lang: 'en' }]);
  });

  it('sends one encrypted notification per conversation for new incoming texts', async () => {
    await subscribe({ ...subscription, device: 'device-0001', lang: 'fr' });
    services.repo.saveContact({ name: 'Marie Tremblay', phones: ['4383980707'] });
    client.push({ direction: 'in', body: 'Premier', contact: '4383980707' });
    client.push({ direction: 'in', body: 'Tu viens au chalet?', contact: '4383980707' });
    client.push({ direction: 'in', body: '', contact: '5145551234', media: ['https://voip.ms/media/x/a.jpg'] });
    client.push({ direction: 'out', body: 'Envoyé du cell', contact: '5145551234' });
    await services.sync.syncRecent();
    await waitFor(() => pushed.length === 2);
    expect(pushed).toHaveLength(2);
    expect(pushed[0]!.url).toBe(endpoint);
    expect(pushed[0]!.headers).toMatchObject({ 'Content-Encoding': 'aes128gcm', Urgency: 'high' });
    expect(pushed[0]!.headers.Authorization).toMatch(/^vapid t=.+, k=/);
    const [marie, other] = received();
    const conversation = services.repo.findConversation('4506575294', '4383980707');
    // Each carries the unread count when it left (SMS are fetched before MMS): the icon ends at 3.
    expect(marie).toMatchObject({ title: 'Marie Tremblay (2)', tag: `conversation-${conversation}`, url: `/c/${conversation}`, unread: 2 });
    // Two numbers are shown, so the notification says which one received the text.
    expect(marie.body).toBe('Tu viens au chalet?\n— (450) 657-5294');
    expect(other).toMatchObject({ title: '(514) 555-1234', body: '📎 Pièce jointe\n— (450) 657-5294', unread: 3 });

    // History imports and outgoing texts never notify.
    pushed = [];
    await services.sync.importHistory(30);
    expect(pushed).toHaveLength(0);
  });

  it('shows the latest text of a burst, whatever order VoIP.ms lists them in', async () => {
    await subscribe(subscription);
    const now = Date.now();
    const at = (ms: number) => new Date(ms).toLocaleString('sv-SE', { timeZone: 'America/New_York' });
    client.push({ direction: 'in', body: 'Le plus récent', contact: '4383980707', date: at(now - 1000) });
    client.push({ direction: 'in', body: 'Le plus ancien', contact: '4383980707', date: at(now - 20_000) });
    await services.sync.syncRecent();
    await waitFor(() => pushed.length === 1);
    expect(received()[0]).toMatchObject({ body: expect.stringMatching(/^Le plus récent/) });
  });

  it('skips the device where the app is on screen', async () => {
    await subscribe({ ...subscription, device: 'device-0001' });
    const other = browserKeys();
    await subscribe({ endpoint: 'https://push.example.net/send/other', keys: { p256dh: other.p256dh, auth: other.auth }, device: 'device-0002' });
    const tab = { device: 'device-0001', tab: 'tab-00000001', visible: true };
    const fakeResponse = { writeHead() {}, write() {}, on() {}, end() {} } as unknown as import('node:http').ServerResponse;
    services.events.attach(fakeResponse, tab);

    client.push({ direction: 'in', body: 'Salut', contact: '4383980707' });
    await services.sync.syncRecent();
    await waitFor(() => pushed.length === 1);
    expect(pushed.map((p) => p.url)).toEqual(['https://push.example.net/send/other']);

    // Once the tab is hidden, the device gets notifications again.
    const res = await app.inject({ method: 'POST', url: '/api/presence', headers: { cookie }, payload: { tab: tab.tab, visible: false } });
    expect(res.json()).toEqual({ ok: true });
    pushed = [];
    client.push({ direction: 'in', body: 'Encore', contact: '4383980707' });
    await services.sync.syncRecent();
    await waitFor(() => pushed.length === 2);
    expect(pushed.map((p) => p.url).sort()).toEqual([endpoint, 'https://push.example.net/send/other']);
  });

  it('also skips it when the tab polls for live updates', async () => {
    await subscribe({ ...subscription, device: 'device-0001' });
    const other = browserKeys();
    await subscribe({ endpoint: 'https://push.example.net/send/other', keys: { p256dh: other.p256dh, auth: other.auth }, device: 'device-0002' });
    const poll = (visible: '0' | '1') =>
      app.inject({ url: `/api/events/poll?device=device-0001&tab=tab-00000001&visible=${visible}`, headers: { cookie } });
    await poll('1');

    client.push({ direction: 'in', body: 'Salut', contact: '4383980707' });
    await services.sync.syncRecent();
    await waitFor(() => pushed.length === 1);
    expect(pushed.map((p) => p.url)).toEqual(['https://push.example.net/send/other']);

    await poll('0');
    pushed = [];
    client.push({ direction: 'in', body: 'Encore', contact: '4383980707' });
    await services.sync.syncRecent();
    await waitFor(() => pushed.length === 2);
    expect(pushed.map((p) => p.url).sort()).toEqual([endpoint, 'https://push.example.net/send/other']);
  });

  it('forgets subscriptions the push service says are gone', async () => {
    await subscribe(subscription);
    pushStatus = 410;
    client.push({ direction: 'in', body: 'Allô?', contact: '4383980707' });
    await services.sync.syncRecent();
    await waitFor(() => services.repo.listPushSubscriptions().length === 0);
    expect(services.repo.listPushSubscriptions()).toEqual([]);
  });

  it('sends a test notification and reports refusals', async () => {
    await subscribe({ ...subscription, lang: 'en' });
    const ok = await app.inject({ method: 'POST', url: '/api/push/test', headers: { cookie }, payload: { endpoint } });
    expect(ok.json()).toEqual({ ok: true });
    expect(received()[0]).toMatchObject({ title: 'Notifications are on', url: '/settings' });
    pushStatus = 403;
    const refused = await app.inject({ method: 'POST', url: '/api/push/test', headers: { cookie }, payload: { endpoint } });
    expect(refused.statusCode).toBe(502);
    expect(refused.json()).toEqual({ error: 'push_failed', status: 403 });
    const unknown = await app.inject({ method: 'POST', url: '/api/push/test', headers: { cookie }, payload: { endpoint: 'https://x.example/1' } });
    expect(unknown.statusCode).toBe(404);
  });

  it('moves a renewed subscription over and unsubscribes', async () => {
    await subscribe({ ...subscription, device: 'device-0001', lang: 'en' });
    const renewed = browserKeys();
    await subscribe({ endpoint: 'https://push.example.net/send/new', keys: { p256dh: renewed.p256dh, auth: renewed.auth }, replaces: endpoint });
    expect(services.repo.listPushSubscriptions()).toMatchObject([
      { endpoint: 'https://push.example.net/send/new', device: 'device-0001', lang: 'en' },
    ]);
    await app.inject({ method: 'POST', url: '/api/push/unsubscribe', headers: { cookie }, payload: { endpoint: 'https://push.example.net/send/new' } });
    expect(services.repo.listPushSubscriptions()).toEqual([]);
  });

  it('drops every subscription when APP_PASSWORD changes, and keeps its keys', async () => {
    await subscribe(subscription);
    const key = services.push.publicKey;
    await app.close();
    await start({ VOIPMS_API_USERNAME: 'me@example.com', VOIPMS_API_PASSWORD: 'x' }, dataDir);
    expect(services.repo.listPushSubscriptions()).toHaveLength(1);
    expect(services.push.publicKey).toBe(key);
    await app.close();
    await start({ APP_PASSWORD: 'changed', VOIPMS_API_USERNAME: 'me@example.com', VOIPMS_API_PASSWORD: 'x' }, dataDir);
    expect(services.repo.listPushSubscriptions()).toEqual([]);
  });
});

describe('texts announced by VoIP.ms', () => {
  beforeEach(async () => {
    await start({ VOIPMS_API_USERNAME: 'me@example.com', VOIPMS_API_PASSWORD: 'x', PUBLIC_URL: 'https://sms.example.com' });
    await login();
    await app.inject({ url: '/api/setup/dids', headers: { cookie } });
    await app.inject({ method: 'POST', url: '/api/setup/complete', headers: { cookie } });
    services.sync.start();
    // The first check only sets a baseline: texts after it are new.
    await vi.waitFor(() => expect(services.repo.getSetting('sync.lastSuccessAt')).not.toBeNull());
  });

  const inject = (method: 'GET' | 'POST', url: string, payload?: object) => app.inject({ method, url, payload, headers: { cookie } });

  it('checks VoIP.ms as soon as it calls, then only as a safety net', async () => {
    client.dids[1]!.callback = { url: 'https://crm.example/sms', retry: false };
    const enabled = (await inject('POST', '/api/webhook/enable', { replace: ['5143604702'] })).json();
    expect(enabled).toMatchObject({ enabled: true, complete: true });
    expect(client.dids.map((d) => d.callback)).toEqual([
      { url: enabled.url, retry: true },
      { url: enabled.url, retry: true },
    ]);
    const queries = client.queries.length;

    const text = client.push({ direction: 'in', body: 'Allô par webhook' });
    const call = await app.inject({ url: new URL(enabled.url).pathname });
    expect(call.statusCode).toBe(200);
    expect(call.body).toBe('ok');
    await vi.waitFor(() => expect(services.repo.findMessageByRemote('sms', text.id)).not.toBeNull());
    expect(client.queries.length).toBeGreaterThan(queries);
    // A notification and an unread badge, as for a text found by a scheduled check.
    expect(services.repo.listConversations({})[0]).toMatchObject({ unreadCount: 1 });

    // No more checks every few seconds: the next one is the safety net, a quarter of an hour away.
    const after = client.queries.length;
    await new Promise((r) => setTimeout(r, 300));
    expect(client.queries.length).toBe(after);

    const off = (await inject('POST', '/api/webhook/disable')).json();
    expect(off).toMatchObject({ enabled: false });
    expect(client.dids.map((d) => d.callback)).toEqual([null, { url: 'https://crm.example/sms', retry: false }]);
  });

  it('reports the numbers VoIP.ms refused to change, and keeps checking at the usual pace', async () => {
    client.failNext.setCallback = 'sms_wait_message';
    const enabled = (await inject('POST', '/api/webhook/enable')).json();
    expect(enabled.numbers).toEqual([
      { did: '4506575294', state: 'none', otherUrl: null, error: 'sms_wait_message' },
      { did: '5143604702', state: 'ours', otherUrl: null, error: null },
    ]);
    expect(enabled.complete).toBe(false);
    expect(services.webhook.complete()).toBe(false);
    // Asked again a minute later, the number follows.
    expect((await inject('POST', '/api/webhook/enable')).json()).toMatchObject({ complete: true });
  });

  it('ignores calls with a wrong secret', async () => {
    await inject('POST', '/api/webhook/enable');
    expect((await app.inject({ url: '/api/voipms/callback/guess' })).statusCode).toBe(404);
    expect(services.repo.getSetting('webhook.lastCallAt')).toBeNull();
  });
});

describe('several VoIP.ms accounts', () => {
  /** The second account, as VoIP.ms would show it: its own number and history. */
  let other: FakeVoipMs;
  const OTHER_DID = '4185550142';

  beforeEach(async () => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-test-'));
    client = new FakeVoipMs();
    other = new FakeVoipMs();
    other.dids = [{ did: OTHER_DID, description: 'Québec, QC', smsAvailable: true, smsEnabled: true, mmsAvailable: true, callback: null }];
    const config = loadConfig({
      APP_PASSWORD: 'hunter2',
      DATA_DIR: dataDir,
      WEB_DIR: path.join(dataDir, 'none'),
      VOIPMS_API_USERNAME: 'me@example.com',
      VOIPMS_API_PASSWORD: 'x',
      PUBLIC_URL: 'https://sms.example.com',
    });
    ({ app, services } = await buildApp(config, { clientFactory: (creds) => (creds.username === 'b@example.com' ? other : client), logger: false, pushFetch, mediaFetch }));
    await login();
    await app.inject({ url: '/api/setup/dids', headers: { cookie } });
    await app.inject({ method: 'POST', url: '/api/setup/complete', headers: { cookie } });
  });

  const inject = (method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: object) => app.inject({ method, url, payload, headers: { cookie } });
  const addOther = () => inject('POST', '/api/accounts', { label: 'Boulangerie', username: 'b@example.com', password: 'secret' });

  it('adds an account with its own numbers, once', async () => {
    expect((await inject('GET', '/api/accounts')).json()).toEqual([{ id: 1, label: null, username: 'me@example.com', credentialsSource: 'env', numbers: 2 }]);
    const added = await addOther();
    expect(added.statusCode).toBe(201);
    expect(added.json()).toMatchObject({
      account: { id: 2, label: 'Boulangerie', username: 'b@example.com', credentialsSource: 'db', numbers: 1 },
      connection: { status: 'success' },
    });
    expect((await addOther()).json()).toEqual({ error: 'account_exists' });
    expect((await inject('POST', '/api/accounts', { username: 'ME@example.com', password: 'x' })).json()).toEqual({ error: 'account_exists' });
    expect((await inject('GET', '/api/dids')).json().map((d: DidDto) => [d.did, d.accountId])).toEqual([
      ['4506575294', 1],
      ['5143604702', 1],
      [OTHER_DID, 2],
    ]);
    expect((await inject('PATCH', '/api/accounts/2', { label: 'Boulangerie Fortin' })).json()).toMatchObject({ id: 2, label: 'Boulangerie Fortin' });
    expect((await inject('PATCH', '/api/accounts/9', { label: 'x' })).statusCode).toBe(404);
    // Its credentials are kept encrypted, like the first account's.
    expect(services.credentials.get(2)).toEqual({ username: 'b@example.com', password: 'secret' });
    expect(services.repo.getSetting('account.2.voipms.credentials')).not.toContain('secret');
  });

  it('checks each account for its own numbers only', async () => {
    await addOther();
    await services.sync.syncRecent();
    // The same VoIP.ms id as a text of the first account: stored apart all the same.
    other.push({ id: '1000', did: OTHER_DID, contact: '4185550177', direction: 'in', body: 'Les pains sont prêts?' });
    // A number of the first account showing up in the second one's history stays the first one's.
    other.push({ did: '4506575294', contact: '4185550188', direction: 'in', body: 'Pas pour ce compte' });
    client.push({ id: '1000', direction: 'in', body: 'Pour le premier compte' });
    await services.sync.syncRecent();
    const conversations = services.repo.listConversations({});
    expect(conversations.map((c) => [c.did, c.phone]).sort()).toEqual([
      ['4185550142', '4185550177'],
      ['4506575294', '4383980707'],
    ]);
    expect(other.queries.length).toBeGreaterThan(0);
  });

  it('sends and deletes through the account a number belongs to', async () => {
    await addOther();
    const sent = await app.inject({ method: 'POST', url: '/api/messages', ...multipart({ did: OTHER_DID, to: '4185550177', body: 'Merci!' }) });
    expect(sent.statusCode).toBe(202);
    await waitFor(() => other.sent.length === 1);
    expect(other.sent).toEqual([{ kind: 'sms', did: OTHER_DID, dst: '4185550177', message: 'Merci!', media: [] }]);
    expect(client.sent).toEqual([]);
    await waitFor(() => services.repo.getMessage(sent.json().message.id)?.status === 'sent');

    const { conversation } = sent.json();
    expect((await inject('DELETE', `/api/conversations/${conversation.id}?voipms=1`)).statusCode).toBe(200);
    await waitFor(() => other.deleted.length === 1);
    expect(other.deleted).toHaveLength(1);
    expect(client.deleted).toEqual([]);
  });

  it('checks the account whose secret VoIP.ms calls with', async () => {
    await addOther();
    services.sync.start();
    await vi.waitFor(() => expect(services.repo.getSetting('account.2.sync.lastSuccessAt')).not.toBeNull());
    const second = services.accounts.get(2)!;
    const status = await second.webhook.enable('https://sms.example.com', []);
    expect(status).toMatchObject({ enabled: true, complete: true });
    // Each account has its own secret, so its own address.
    expect(status.url).not.toBe((await services.accounts.primary().webhook.enable('https://sms.example.com', [])).url);

    const text = other.push({ did: OTHER_DID, contact: '4185550177', direction: 'in', body: 'Annoncé par VoIP.ms' });
    const queries = client.queries.length;
    expect((await app.inject({ url: new URL(status.url!).pathname })).body).toBe('ok');
    // Stored under the account: two accounts' VoIP.ms ids can never clash.
    await vi.waitFor(() => expect(services.repo.findMessageByRemote('sms', `2:${text.id}`)).not.toBeNull());
    // The first account was not checked for it.
    expect(client.queries.length).toBe(queries);
  });
});
