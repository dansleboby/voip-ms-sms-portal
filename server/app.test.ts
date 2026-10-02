import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp, type Services } from './app.js';
import { loadConfig } from './config.js';
import { FakeVoipMs } from './test/fake-client.js';

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);

let app: FastifyInstance;
let services: Services;
let client: FakeVoipMs;
let dataDir: string;
let cookie = '';

async function start(env: Record<string, string> = {}) {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-test-'));
  client = new FakeVoipMs();
  const config = loadConfig({ APP_PASSWORD: 'hunter2', DATA_DIR: dataDir, WEB_DIR: path.join(dataDir, 'none'), ...env });
  ({ app, services } = await buildApp(config, { clientFactory: () => client, logger: false }));
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

  it('reports the session state', async () => {
    const res = await app.inject({ url: '/api/session' });
    expect(res.json()).toMatchObject({ authenticated: false, setupCompleted: false, credentialsSource: null, pollActiveSeconds: 10 });
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
    expect(res.json()).toEqual({ imported: 2, skipped: 0 });
    expect(services.repo.listContacts()).toEqual([
      expect.objectContaining({ name: 'Garage Bélanger', phones: ['4505550111'] }),
      expect.objectContaining({ name: 'Marie Tremblay', phones: ['4385550142'] }),
    ]);
  });
});
