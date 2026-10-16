import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { backendNames, Client, runCron, startBackend, waitFor, type Backend } from './backends.js';
import { browserKeys } from '../server/test/webpush-helpers.js';
import type { ContactDto, ConversationDto, DidDto, EventsPollDto, MessageDto, ServerEvent } from '../shared/types.js';

/**
 * The HTTP API, as the web client uses it, checked against both servers in
 * demo mode: whatever passes here works the same in Docker and on shared
 * PHP hosting.
 */

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);
const { version } = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, '..', 'package.json'), 'utf8')) as { version: string };

const MONTREAL = '5145550100';
const GATINEAU = '8195550123';
const MARIE = '4385550142';

describe.each(backendNames)('%s server', (name) => {
  let backend: Backend;
  let client: Client;
  let cursor: string | undefined;

  /** Polls like a tab does; returns the events since the previous poll. */
  async function poll(): Promise<ServerEvent[]> {
    const query = new URLSearchParams({ device: 'device-0001', tab: 'tab-00000001', visible: '1', ...(cursor ? { after: cursor } : {}) });
    const res = await client.get(`/api/events/poll?${query}`);
    expect(res.status).toBe(200);
    const body = res.json as EventsPollDto;
    cursor = body.cursor;
    return body.events;
  }

  function sendForm(fields: Record<string, string>, files: { type: string; data: Buffer }[] = []) {
    const form = new FormData();
    for (const [k, v] of Object.entries(fields)) form.set(k, v);
    for (const f of files) form.append('files[]', new Blob([f.data], { type: f.type }), 'file');
    return client.post('/api/messages', form);
  }

  beforeAll(async () => {
    backend = await startBackend(name);
    client = new Client(backend.url);
  }, 30_000);

  afterAll(async () => {
    await backend?.stop();
  });

  it('reports its state before sign-in, and asks for it', async () => {
    const session = await client.get('/api/session');
    expect(session.json).toMatchObject({ authenticated: false, setupCompleted: false, credentialsSource: 'env', demo: true, version, pollActiveSeconds: 3 });
    expect(['stream', 'poll']).toContain(session.json.liveUpdates);
    expect((await client.get('/api/conversations')).status).toBe(401);
    expect((await client.get('/api/events/poll')).status).toBe(401);
    expect((await client.post('/api/auth/login', { password: 'nope' })).json).toEqual({ error: 'wrong_password' });
  });

  it('cannot be reached through an encoded path', async () => {
    for (const url of ['/%61pi/setup/status', '/api/%63onversations']) {
      const res = await client.get(url);
      expect(res.status).toBeGreaterThanOrEqual(400);
    }
    const write = await client.post('/%61pi/contacts', { name: 'x', phones: ['4383980707'] });
    expect(write.status).toBeGreaterThanOrEqual(400);
  });

  it('signs in with a protected cookie, and refuses cross-site writes', async () => {
    const res = await client.login();
    const cookie = res.headers.get('set-cookie')!;
    expect(cookie).toMatch(/^vsp_session=\d+\.[\w-]+;/);
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Lax/i);
    expect((await client.get('/api/session')).json.authenticated).toBe(true);
    const evil = await client.post('/api/sync/now', undefined, { origin: 'https://evil.example' });
    expect(evil).toMatchObject({ status: 403, json: { error: 'bad_origin' } });
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
  });

  it('runs the setup wizard', async () => {
    expect((await client.get('/api/setup/status')).json).toEqual({ completed: false, credentialsSource: 'env', username: 'demo@example.com' });
    expect((await client.post('/api/setup/test')).json).toEqual({ ip: '203.0.113.10', status: 'success', balance: 42.5 });
    const dids = (await client.get('/api/setup/dids')).json as DidDto[];
    expect(dids.map((d) => [d.did, d.smsEnabled, d.visible])).toEqual([
      [MONTREAL, true, true],
      ['4505550199', true, true],
      [GATINEAU, false, false],
    ]);
    expect((await client.post('/api/setup/complete')).json).toEqual({ ok: true });
    expect((await client.get('/api/session')).json.setupCompleted).toBe(true);
    // The first check imports the demo account's history.
    const conversations = await waitFor(async () => {
      const list = (await client.get('/api/conversations')).json as ConversationDto[];
      return list.length === 4 && list;
    });
    expect(conversations.map((c) => c.contact?.name ?? c.phone).sort()).toEqual(['32665', 'Alex Martin', 'Garage Bélanger', 'Marie Tremblay']);
    // The baseline check marks nothing unread.
    expect(conversations.every((c) => c.unreadCount === 0)).toBe(true);
  });

  it('serves live updates to polling tabs', async () => {
    const first = await poll();
    expect(first[0]).toMatchObject({ type: 'sync', status: { mode: 'active', lastError: null } });
    const patched = await client.request('PATCH', `/api/dids/${MONTREAL}`, { label: 'Perso', color: '#188038' });
    expect(patched.json).toMatchObject({ did: MONTREAL, label: 'Perso', color: '#188038' });
    expect((await client.request('PATCH', `/api/dids/${MONTREAL}`, { color: 'red' })).status).toBe(400);
    expect((await client.request('PATCH', '/api/dids/5550000000', { label: 'x' })).status).toBe(404);
    const events = await waitFor(async () => {
      const batch = await poll();
      return batch.some((e) => e.type === 'dids') && batch;
    });
    expect(events.map((e) => e.type)).toEqual(expect.arrayContaining(['dids', 'reload']));
    expect(await poll()).toEqual([]);

    const stale = await client.get('/api/events/poll?tab=tab-00000001&after=gone.3');
    expect(stale.json).toMatchObject({ reset: true, events: [{ type: 'sync' }] });
    expect((await client.get('/api/events/poll?tab=x')).status).toBe(400);
    expect((await client.post('/api/presence', { tab: 'tab-00000001', visible: false })).json).toEqual({ ok: true });
  });

  it('finds conversations without regard to accents, case or country code', async () => {
    const search = async (q: string) => ((await client.get(`/api/conversations?q=${encodeURIComponent(q)}`)).json as ConversationDto[]).map((c) => c.phone);
    expect(await search('BELANGER')).toEqual(['4505550111']);
    expect(await search('vérification')).toEqual(['32665']);
    expect(await search('+1 438-555')).toEqual([MARIE]);
    const lookup = await client.get(`/api/conversations/lookup?did=${MONTREAL}&phone=1${MARIE}`);
    expect(lookup.json.conversation.phone).toBe(MARIE);
  });

  it('sends texts, and reports how they went through live updates', async () => {
    const res = await sendForm({ did: MONTREAL, to: `(438) 555-0142`, body: 'Ça marche? 😊' });
    expect(res.status).toBe(202);
    const { message, conversation } = res.json as { message: MessageDto; conversation: ConversationDto };
    expect(message).toMatchObject({ kind: 'sms', direction: 'out', body: 'Ça marche? 😊', attachments: [] });
    expect(['sending', 'sent']).toContain(message.status);
    expect(conversation.phone).toBe(MARIE);
    const sent = await waitFor(async () =>
      (await poll()).find((e) => e.type === 'message' && e.message.id === message.id && e.message.status === 'sent'),
    );
    expect(sent).toBeTruthy();

    const thread = (await client.get(`/api/conversations/${conversation.id}/messages?limit=2`)).json as MessageDto[];
    expect(thread.at(-1)).toMatchObject({ id: message.id, status: 'sent' });
    expect((await client.get(`/api/conversations/${conversation.id}/messages?limit=500`)).status).toBe(400);
  });

  it('sends pictures as MMS and serves them back safely', async () => {
    const res = await sendForm({ did: MONTREAL, to: MARIE, body: '' }, [
      { type: 'image/png', data: PNG },
      { type: 'image/png', data: PNG },
    ]);
    expect(res.status).toBe(202);
    const message = res.json.message as MessageDto;
    expect(message.kind).toBe('mms');
    expect(message.attachments).toHaveLength(2);
    const media = await fetch(backend.url + message.attachments[0]!.url!, { headers: { cookie: client.cookie } });
    expect(media.headers.get('content-type')).toBe('image/png');
    expect(media.headers.get('content-security-policy')).toMatch(/sandbox/);
    expect(media.headers.get('content-disposition')).toMatch(/^inline/);
    expect(Buffer.from(await media.arrayBuffer()).equals(PNG)).toBe(true);
    expect((await fetch(backend.url + message.attachments[0]!.url!)).status).toBe(401);
  });

  it('refuses what VoIP.ms would', async () => {
    expect((await sendForm({ did: MONTREAL, to: MARIE, body: 'x' }, [{ type: 'text/html', data: Buffer.from('<script>') }])).json).toEqual({
      error: 'unsupported_attachment',
    });
    const four = Array.from({ length: 4 }, () => ({ type: 'image/png', data: PNG }));
    expect(await sendForm({ did: MONTREAL, to: MARIE, body: '' }, four)).toMatchObject({ status: 413, json: { error: 'too_many_attachments' } });
    expect((await sendForm({ did: MONTREAL, to: '911', body: 'x' })).json).toEqual({ error: 'invalid_destination' });
    expect((await sendForm({ did: GATINEAU, to: MARIE, body: 'x' })).json).toEqual({ error: 'sms_not_enabled' });
    expect((await sendForm({ did: '5550000000', to: MARIE, body: 'x' })).json).toEqual({ error: 'unknown_did' });
    expect((await sendForm({ did: MONTREAL, to: MARIE, body: ' ' })).json).toEqual({ error: 'empty' });
    expect((await sendForm({ did: MONTREAL, to: MARIE, body: 'é'.repeat(1025) })).json).toEqual({ error: 'too_long' });
    expect(await client.post('/api/messages/999999/retry')).toMatchObject({ status: 404, json: { error: 'not_found' } });
  });

  it('archives conversations and marks them read', async () => {
    const [first] = (await client.get('/api/conversations')).json as ConversationDto[];
    const archived = await client.request('PATCH', `/api/conversations/${first!.id}`, { archived: true });
    expect(archived.json).toMatchObject({ id: first!.id, archived: true });
    expect(((await client.get('/api/conversations')).json as ConversationDto[]).map((c) => c.id)).not.toContain(first!.id);
    expect(((await client.get('/api/conversations?archived=1')).json as ConversationDto[]).map((c) => c.id)).toEqual([first!.id]);
    await client.request('PATCH', `/api/conversations/${first!.id}`, { archived: false });
    expect((await client.post(`/api/conversations/${first!.id}/read`)).json).toEqual({ ok: true });
    expect((await client.get('/api/conversations/999999')).status).toBe(404);
    expect((await client.get('/api/conversations/abc')).status).toBe(400);
  });

  it('keeps contacts, refusing a number already taken unless asked to move it', async () => {
    const created = await client.post('/api/contacts', { name: '  Jean Roy ', phones: ['+1 514 555 1234'], notes: 'Voisin' });
    expect(created).toMatchObject({ status: 201, json: { name: 'Jean Roy', phones: ['5145551234'], notes: 'Voisin' } });
    const id = (created.json as ContactDto).id;
    const taken = await client.post('/api/contacts', { name: 'Autre', phones: ['5145551234'] });
    expect(taken).toMatchObject({ status: 409, json: { error: 'phone_taken', phones: ['5145551234'] } });
    const moved = await client.post('/api/contacts', { name: 'Autre', phones: ['5145551234'], force: true });
    expect(moved.status).toBe(201);
    // Jean Roy had no other number: he is gone.
    expect(((await client.get('/api/contacts')).json as ContactDto[]).some((c) => c.id === id)).toBe(false);
    expect((await client.post('/api/contacts', { name: 'X', phones: ['123'] })).json).toEqual({ error: 'invalid_phone', phones: ['123'] });
    const updated = await client.request('PUT', `/api/contacts/${moved.json.id}`, { name: 'Autre nom', phones: ['5145551234', '32665'] });
    expect(updated.json).toMatchObject({ name: 'Autre nom', phones: ['5145551234', '32665'] });
    expect((await client.request('DELETE', `/api/contacts/${moved.json.id}`)).json).toEqual({ ok: true });
    expect((await client.request('DELETE', `/api/contacts/${moved.json.id}`)).status).toBe(404);

    const vcard = [
      'BEGIN:VCARD', 'FN:Nouvelle Personne', 'TEL:819-555-0177', 'END:VCARD',
      'BEGIN:VCARD', 'FN:Déjà là', `TEL:${MARIE}`, 'END:VCARD',
    ].join('\r\n');
    expect((await client.post('/api/contacts/import', { vcard })).json).toEqual({ imported: 1, skipped: 1 });
  });

  it('takes push subscriptions', async () => {
    const key = (await client.get('/api/push/key')).json.publicKey as string;
    expect(Buffer.from(key, 'base64url')).toHaveLength(65);
    const ua = browserKeys();
    const subscription = { endpoint: 'https://push.example.net/send/abc', keys: { p256dh: ua.p256dh, auth: ua.auth } };
    const subscribe = (body: object) => client.post('/api/push/subscriptions', body);
    expect((await subscribe({ ...subscription, endpoint: 'http://push.example.net/x' })).status).toBe(400);
    expect((await subscribe({ ...subscription, keys: { ...subscription.keys, p256dh: 'AAAA' } })).status).toBe(400);
    expect((await subscribe({ ...subscription, keys: { ...subscription.keys, auth: 'AAAA' } })).status).toBe(400);
    expect((await subscribe({ ...subscription, device: 'device-0001', lang: 'en' })).json).toEqual({ ok: true });
    expect((await client.post('/api/push/test', { endpoint: 'https://push.example.net/unknown' })).json).toEqual({ error: 'not_subscribed' });
    expect((await client.post('/api/push/unsubscribe', { endpoint: subscription.endpoint })).json).toEqual({ ok: true });
  });

  it('reports the sync state, and the cron job where there is one', async () => {
    const status = (await client.get('/api/sync/status')).json;
    expect(status).toMatchObject({ state: 'idle', lastError: null, importing: null });
    expect(status.lastCheckAt).toBeGreaterThanOrEqual(status.lastSyncAt);
    if (name === 'php') {
      expect(status.cron).toEqual({ lastRunAt: null, command: expect.stringMatching(/php .*cron\.php$/) });
      runCron(backend);
      expect((await client.get('/api/sync/status')).json.cron.lastRunAt).toBeGreaterThan(Date.now() - 10_000);
    } else {
      expect(status.cron).toBeUndefined();
    }
  });

  it('imports older history in the background', async () => {
    expect((await client.post('/api/setup/import', { days: 90 })).status).toBe(202);
    await waitFor(async () => (await client.get('/api/sync/status')).json.importing === null);
    expect((await client.post('/api/setup/import', { days: -1 })).status).toBe(400);
  });

  it('signs out', async () => {
    const res = await client.post('/api/auth/logout');
    expect(res.headers.get('set-cookie')).toMatch(/^vsp_session=;/);
    client.cookie = '';
    expect((await client.get('/api/session')).json.authenticated).toBe(false);
  });

  it('limits sign-in attempts', async () => {
    const attempts = [];
    for (let i = 0; i < 12; i++) attempts.push((await client.post('/api/auth/login', { password: 'nope' })).status);
    expect(attempts.slice(0, 5)).toEqual([401, 401, 401, 401, 401]);
    expect(attempts.at(-1)).toBe(429);
    const blocked = await client.post('/api/auth/login', { password: 'hunter2' });
    expect(blocked).toMatchObject({ status: 429, json: { error: 'rate_limited' } });
  });
});
