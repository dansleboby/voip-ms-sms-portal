import fs from 'node:fs';
import http from 'node:http';
import type net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Client, waitFor } from './backends.js';
import { FakeVoipMsServer } from './fake-voipms.js';
import { checkNow, php, startPhp, type PhpBackend } from './php-server.js';
import { browserKeys, decryptPayload } from './webpush-helpers.js';
import type { ConversationDto } from '../shared/types.js';

/**
 * Push notifications from the PHP server, to a push service that is a local
 * HTTP server here, read the way a browser would (server/app.test.ts did
 * this for the Node server).
 *
 * The API only takes https push endpoints, as browsers give them. Each test
 * subscribes that way, then points the stored subscription at the local
 * push service, which delivery reaches over plain HTTP: the rule that real
 * subscriptions follow stays as it is.
 */

const DID = '4506575294';
const MARIE = '4383980707';

/** Stands in for the push services of browsers: keeps what it is sent, answers `status`. */
class FakePushService {
  received: { path: string; headers: http.IncomingHttpHeaders; body: Buffer }[] = [];
  status = 201;
  url = '';
  private server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    this.received.push({ path: req.url ?? '', headers: req.headers, body: Buffer.concat(chunks) });
    res.writeHead(this.status).end();
  });

  async start() {
    await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', resolve));
    this.url = `http://127.0.0.1:${(this.server.address() as net.AddressInfo).port}`;
  }

  stop() {
    this.server.closeAllConnections();
    return new Promise((resolve) => this.server.close(resolve));
  }
}

describe('PHP server: push notifications', () => {
  const voipms = new FakeVoipMsServer();
  const service = new FakePushService();
  const ua = browserKeys();
  let dataDir: string;
  let backend: PhpBackend;
  let client: Client;

  const env = { VOIPMS_API_USERNAME: 'me@example.com', VOIPMS_API_PASSWORD: 'api-secret' };
  type Subscription = { endpoint: string; device: string | null; lang: string };
  const subscriptions = async () =>
    (await php<Subscription[]>(backend, 'return $app->repo->listPushSubscriptions();')).map(({ endpoint, device, lang }) => ({ endpoint, device, lang }));

  /** Subscribes a browser as the web client does, then points its subscription at the local push service; returns its endpoint there. */
  async function subscribe(name: string, keys: { p256dh: string; auth: string }, extra: object = {}): Promise<string> {
    const endpoint = `https://push.example.net/send/${name}`;
    const res = await client.post('/api/push/subscriptions', { endpoint, expirationTime: null, keys: { p256dh: keys.p256dh, auth: keys.auth }, ...extra });
    expect(res.json).toEqual({ ok: true });
    const local = `${service.url}/send/${name}`;
    await php(backend, `$app->repo->run('UPDATE push_subscriptions SET endpoint = ? WHERE endpoint = ?', ['${local}', '${endpoint}']);`);
    return local;
  }
  /** What each notification said, as the browser that subscribed with `ua` reads it. */
  const read = () => service.received.map((p) => JSON.parse(decryptPayload(p.body, ua.private, ua.authSecret)));
  const conversationId = async (phone: string) =>
    ((await client.get(`/api/conversations/lookup?did=${DID}&phone=${phone}`)).json as { conversation: ConversationDto }).conversation.id;
  const poll = (tab: string, device: string, visible: '0' | '1') => client.get(`/api/events/poll?device=${device}&tab=${tab}&visible=${visible}`);

  beforeAll(async () => {
    await voipms.start();
    await service.start();
    // Both numbers text: notifications then say which one received the text.
    voipms.dids.find((d) => d.did === '5143604702')!.sms_enabled = 1;
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'push-php-'));
    backend = await startPhp(voipms.url, { ...env, DATA_DIR: dataDir });
    client = new Client(backend.url);
    await client.login();
    await client.get('/api/setup/dids');
    await client.post('/api/setup/complete');
    // The first check only sets a baseline: texts after it are new.
    await waitFor(async () => (await client.get('/api/sync/status')).json.lastSyncAt);
  }, 30_000);

  afterAll(async () => {
    await backend?.stop();
    await service.stop();
    await voipms.stop();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    await php(backend, '$app->repo->deleteAllPushSubscriptions();');
    service.received = [];
    service.status = 201;
  });

  it('needs a session and keeps who subscribed', async () => {
    expect((await new Client(backend.url).get('/api/push/key')).status).toBe(401);
    // The contract tests check what is refused.
    await client.post('/api/push/subscriptions', {
      endpoint: 'https://push.example.net/send/abc123',
      keys: { p256dh: ua.p256dh, auth: ua.auth },
      device: 'device-0001',
      lang: 'en',
    });
    expect(await subscriptions()).toEqual([{ endpoint: 'https://push.example.net/send/abc123', device: 'device-0001', lang: 'en' }]);
  });

  it('sends one encrypted notification per conversation for new incoming texts', async () => {
    const endpoint = await subscribe('abc123', ua, { device: 'device-0001', lang: 'fr' });
    expect((await client.post('/api/contacts', { name: 'Marie Tremblay', phones: [MARIE] })).status).toBe(201);
    voipms.push({ direction: 'in', contact: MARIE, message: 'Premier' });
    voipms.push({ direction: 'in', contact: MARIE, message: 'Tu viens au chalet?' });
    voipms.push({ direction: 'in', contact: '5145551234', message: '', media: `${voipms.url}/media/a.jpg` });
    voipms.push({ direction: 'out', contact: '5145551234', message: 'Envoyé du cell' });
    await checkNow(client);
    await waitFor(async () => service.received.length === 2);
    expect(service.received).toHaveLength(2);
    expect(`${service.url}${service.received[0]!.path}`).toBe(endpoint);
    expect(service.received[0]!.headers).toMatchObject({ 'content-encoding': 'aes128gcm', urgency: 'high' });
    expect(service.received[0]!.headers.authorization).toMatch(/^vapid t=.+, k=/);
    const [marie, other] = read();
    const conversation = await conversationId(MARIE);
    // Each carries the unread count when it left (SMS are fetched before MMS): the icon ends at 3.
    expect(marie).toMatchObject({ title: 'Marie Tremblay (2)', tag: `conversation-${conversation}`, url: `/c/${conversation}`, unread: 2 });
    // Two numbers are shown, so the notification says which one received the text.
    expect(marie.body).toBe('Tu viens au chalet?\n— (450) 657-5294');
    expect(other).toMatchObject({ title: '(514) 555-1234', body: '📎 Pièce jointe\n— (450) 657-5294', unread: 3 });

    // History imports and outgoing texts never notify.
    service.received = [];
    voipms.push({ direction: 'in', contact: '5145559999', message: 'Vieux', at: Date.now() - 10 * 86_400_000 });
    await client.post('/api/setup/import', { days: 30 });
    await waitFor(async () => (await poll('tab-00000009', 'device-0009', '0'), (await client.get('/api/sync/status')).json.importing === null));
    expect(await conversationId('5145559999')).toBeGreaterThan(0);
    expect(service.received).toHaveLength(0);
  }, 30_000);

  it('shows the latest text of a burst, whatever order VoIP.ms lists them in', async () => {
    await subscribe('abc123', ua);
    // VoIP.ms lists the newest first: the last one stored is the oldest.
    voipms.push({ direction: 'in', contact: '4385550111', message: 'Le plus ancien', at: Date.now() - 20_000 });
    voipms.push({ direction: 'in', contact: '4385550111', message: 'Le plus récent', at: Date.now() - 1000 });
    // Its dates stop at the second: a long text split in two arrives with one date.
    const second = Date.now() - 5000;
    voipms.push({ direction: 'in', contact: '4385550122', message: 'Le début d’un long texte', at: second });
    voipms.push({ direction: 'in', contact: '4385550122', message: 'et sa fin', at: second });
    await checkNow(client);
    await waitFor(async () => service.received.length === 2);
    const byTitle = Object.fromEntries(read().map((n) => [n.title, n.body]));
    expect(byTitle['(438) 555-0111 (2)']).toMatch(/^Le plus récent/);
    expect(byTitle['(438) 555-0122 (2)']).toMatch(/^et sa fin/);
  });

  it('skips the device where the app is on screen, until its tab is hidden', async () => {
    const endpoint = await subscribe('abc123', ua, { device: 'device-0001' });
    const other = browserKeys();
    const elsewhere = await subscribe('other', other, { device: 'device-0002' });
    // The tab says it is on screen with each poll.
    await poll('tab-00000001', 'device-0001', '1');

    voipms.push({ direction: 'in', contact: MARIE, message: 'Salut' });
    await checkNow(client);
    await waitFor(async () => service.received.length === 1);
    expect(service.received.map((p) => `${service.url}${p.path}`)).toEqual([elsewhere]);

    // Once the tab is hidden, the device gets notifications again.
    expect((await client.post('/api/presence', { tab: 'tab-00000001', visible: false })).json).toEqual({ ok: true });
    service.received = [];
    voipms.push({ direction: 'in', contact: MARIE, message: 'Encore' });
    await checkNow(client);
    await waitFor(async () => service.received.length === 2);
    expect(service.received.map((p) => `${service.url}${p.path}`).sort()).toEqual([endpoint, elsewhere].sort());
  });

  it('also stops skipping it when the tab polls as hidden', async () => {
    const endpoint = await subscribe('abc123', ua, { device: 'device-0003' });
    const other = browserKeys();
    const elsewhere = await subscribe('other', other, { device: 'device-0004' });
    await poll('tab-00000003', 'device-0003', '1');

    voipms.push({ direction: 'in', contact: MARIE, message: 'Salut' });
    await checkNow(client);
    await waitFor(async () => service.received.length === 1);
    expect(service.received.map((p) => `${service.url}${p.path}`)).toEqual([elsewhere]);

    await poll('tab-00000003', 'device-0003', '0');
    service.received = [];
    voipms.push({ direction: 'in', contact: MARIE, message: 'Encore' });
    await checkNow(client);
    await waitFor(async () => service.received.length === 2);
    expect(service.received.map((p) => `${service.url}${p.path}`).sort()).toEqual([endpoint, elsewhere].sort());
  });

  it('forgets subscriptions the push service says are gone', async () => {
    await subscribe('abc123', ua);
    service.status = 410;
    voipms.push({ direction: 'in', contact: MARIE, message: 'Allô?' });
    await checkNow(client);
    await waitFor(async () => service.received.length === 1);
    expect(await subscriptions()).toEqual([]);
  });

  it('sends a test notification and reports refusals', async () => {
    const endpoint = await subscribe('abc123', ua, { lang: 'en' });
    expect((await client.post('/api/push/test', { endpoint })).json).toEqual({ ok: true });
    expect(read()[0]).toMatchObject({ title: 'Notifications are on', url: '/settings' });
    service.status = 403;
    expect(await client.post('/api/push/test', { endpoint })).toMatchObject({ status: 502, json: { error: 'push_failed', status: 403 } });
    expect(await client.post('/api/push/test', { endpoint: 'https://x.example/1' })).toMatchObject({ status: 404, json: { error: 'not_subscribed' } });
  });

  it('moves a renewed subscription over and unsubscribes', async () => {
    const subscription = { endpoint: 'https://push.example.net/send/abc123', keys: { p256dh: ua.p256dh, auth: ua.auth } };
    await client.post('/api/push/subscriptions', { ...subscription, device: 'device-0001', lang: 'en' });
    // The service worker sends the browser's new subscription, saying which one it replaces.
    const renewed = browserKeys();
    const moved = await client.post('/api/push/subscriptions', {
      endpoint: 'https://push.example.net/send/new',
      keys: { p256dh: renewed.p256dh, auth: renewed.auth },
      replaces: subscription.endpoint,
    });
    expect(moved.json).toEqual({ ok: true });
    expect(await subscriptions()).toEqual([{ endpoint: 'https://push.example.net/send/new', device: 'device-0001', lang: 'en' }]);
    expect((await client.post('/api/push/unsubscribe', { endpoint: 'https://push.example.net/send/new' })).json).toEqual({ ok: true });
    expect(await subscriptions()).toEqual([]);
  });

  it('tells each user of the Team mode about the numbers given to them, with their own unread count', async () => {
    const OTHER = '5143604702';
    expect((await client.post('/api/team', { email: 'julie@example.com', password: 'correct horse' })).status).toBe(201);
    const created = await client.post('/api/users', { email: 'marc@example.com', password: 'marc password', role: 'user', numbers: [{ did: OTHER, canSend: false }] });
    expect(created.status).toBe(201);
    const marc = new Client(backend.url);
    expect((await marc.post('/api/auth/login', { email: 'marc@example.com', password: 'marc password' })).status).toBe(200);
    const owner = await subscribe('owner', ua);
    const keys = browserKeys();
    const res = await marc.post('/api/push/subscriptions', { endpoint: 'https://push.example.net/send/marc', keys: { p256dh: keys.p256dh, auth: keys.auth } });
    expect(res.json).toEqual({ ok: true });
    const theirs = `${service.url}/send/marc`;
    await php(backend, `$app->repo->run('UPDATE push_subscriptions SET endpoint = ? WHERE endpoint = ?', ['${theirs}', 'https://push.example.net/send/marc']);`);

    voipms.push({ direction: 'in', contact: MARIE, message: 'Pour le propriétaire' });
    voipms.push({ direction: 'in', did: OTHER, contact: '5145550188', message: 'Pour Marc aussi' });
    await checkNow(client);
    await waitFor(async () => service.received.length === 3);
    const to = (endpoint: string) => service.received.filter((p) => `${service.url}${p.path}` === endpoint);
    expect(to(owner)).toHaveLength(2);
    const [forMarc] = to(theirs).map((p) => JSON.parse(decryptPayload(p.body, keys.private, keys.authSecret)));
    // One number: no need to say which.
    expect(forMarc).toMatchObject({ title: '(514) 555-0188', body: 'Pour Marc aussi', unread: 1 });

    // A disabled user's browsers stop getting them.
    expect((await client.request('PATCH', `/api/users/${created.json.id}`, { disabled: true })).status).toBe(200);
    expect((await subscriptions()).map((s) => s.endpoint)).toEqual([owner]);
  }, 30_000);

  it('drops every subscription when APP_PASSWORD changes, and keeps its keys', async () => {
    await subscribe('abc123', ua);
    const key = (await client.get('/api/push/key')).json.publicKey as string;
    const restart = async (password: string) => {
      await backend.stop();
      backend = await startPhp(voipms.url, { ...env, DATA_DIR: dataDir, APP_PASSWORD: password });
      client = new Client(backend.url);
      await client.login(password);
    };
    await restart('hunter2');
    expect((await client.get('/api/push/key')).json.publicKey).toBe(key);
    expect(await subscriptions()).toHaveLength(1);
    await restart('changed');
    expect((await client.get('/api/push/key')).json.publicKey).toBe(key);
    expect(await subscriptions()).toEqual([]);
  }, 30_000);
});
