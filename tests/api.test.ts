import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client, runCron, startBackend, waitFor, type Backend } from './backends.js';
import { browserKeys } from './webpush-helpers.js';
import type { ContactDto, ConversationDto, DidDto, EventsPollDto, MessageDto, ServerEvent, SessionInfoDto, UserDto } from '../shared/types.js';

/**
 * The HTTP API, as the web client uses it, in demo mode. Docker and shared
 * hosting run the same server, so whatever passes here works on both.
 */

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);
const { version } = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, '..', 'package.json'), 'utf8')) as { version: string };

const MONTREAL = '5145550100';
const GATINEAU = '8195550123';
const MARIE = '4385550142';

describe('The server', () => {
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
    for (const f of files) form.append('files[]', new Blob([new Uint8Array(f.data)], { type: f.type }), 'file');
    return client.post('/api/messages', form);
  }

  beforeAll(async () => {
    backend = await startBackend();
    client = new Client(backend.url);
  }, 30_000);

  afterAll(async () => {
    await backend?.stop();
  });

  it('reports its state before sign-in, and asks for it', async () => {
    const session = await client.get('/api/session');
    expect(session.json).toMatchObject({ authenticated: false, setupCompleted: false, credentialsSource: 'env', demo: true, version, pollActiveSeconds: 3 });
    expect(session.json.liveUpdates).toBe('poll');
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
    // A session id and its signature.
    expect(cookie).toMatch(/^vsp_session=[\w-]{32}\.[\w-]{43};/);
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Lax/i);
    expect((await client.get('/api/session')).json).toMatchObject({
      authenticated: true,
      mode: 'simple',
      user: { id: null, email: null, name: null, role: 'owner' },
    });
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

  it('turns SMS on for a number in the VoIP.ms account', async () => {
    const before = ((await client.get('/api/dids')).json as DidDto[]).find((d) => d.did === GATINEAU);
    expect(before).toMatchObject({ smsEnabled: false, smsAvailable: true, visible: false });
    expect((await client.post(`/api/dids/${GATINEAU}/enable-sms`)).json).toMatchObject({ did: GATINEAU, smsEnabled: true, visible: true });
    // Still on once the numbers are read from VoIP.ms again.
    expect(((await client.get('/api/setup/dids')).json as DidDto[]).find((d) => d.did === GATINEAU)).toMatchObject({ smsEnabled: true });
    expect((await sendForm({ did: GATINEAU, to: MARIE, body: 'Enfin' })).status).toBe(202);
    expect((await client.post('/api/dids/5550000000/enable-sms')).status).toBe(404);
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

  it('deletes messages and conversations for good, at VoIP.ms too when asked', async () => {
    const LAVAL = '4505550199';
    const GARAGE = '4505550111';
    const find = async (name: string) => ((await client.get(`/api/conversations?q=${encodeURIComponent(name)}`)).json as ConversationDto[])[0]!;
    const thread = async (id: number) => ((await client.get(`/api/conversations/${id}/messages`)).json as MessageDto[]).map((m) => m.body);
    const importAgain = async () => {
      await client.post('/api/setup/import', { days: 30 });
      // The PHP version imports after answering polls.
      await waitFor(async () => (await poll(), (await client.get('/api/sync/status')).json.importing === null));
    };

    // The whole demo history, older texts included.
    await importAgain();
    const alex = await find('Alex');
    const [first, ...rest] = (await client.get(`/api/conversations/${alex.id}/messages`)).json as MessageDto[];
    await poll();
    expect((await client.request('DELETE', `/api/messages/${first!.id}`)).json).toEqual({ ok: true });
    const event = await waitFor(async () => (await poll()).find((e) => e.type === 'deleted'));
    expect(event).toMatchObject({ messageIds: [first!.id], conversation: { id: alex.id } });
    expect(await thread(alex.id)).toEqual(rest.map((m) => m.body));
    expect((await client.request('DELETE', `/api/messages/${first!.id}`)).status).toBe(404);
    expect((await client.request('DELETE', `/api/messages/${rest[0]!.id}?voipms=yes`)).status).toBe(400);

    const garage = await find('Garage');
    expect((await client.request('DELETE', `/api/conversations/${garage.id}?voipms=1`)).json).toEqual({ ok: true, deleted: 2 });
    expect(((await client.get('/api/conversations')).json as ConversationDto[]).map((c) => c.id)).not.toContain(garage.id);
    expect((await client.get('/api/conversations?q=BELANGER')).json).toEqual([]);

    // Checking VoIP.ms's history again brings neither back.
    await importAgain();
    expect(await thread(alex.id)).toEqual(rest.map((m) => m.body));
    expect(((await client.get('/api/conversations')).json as ConversationDto[]).map((c) => c.id)).not.toContain(garage.id);

    // A new text brings the conversation back, with that text only.
    expect((await sendForm({ did: LAVAL, to: GARAGE, body: 'Encore ouvert?' })).status).toBe(202);
    expect((await find('Garage')).id).toBe(garage.id);
    expect((await thread(garage.id))[0]).toBe('Encore ouvert?');
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
    expect(moved.json).toMatchObject({ color: null, icon: null });
    const updated = await client.request('PUT', `/api/contacts/${moved.json.id}`, {
      name: 'Autre nom',
      phones: ['5145551234', '32665'],
      color: '#e52592',
      icon: 'briefcase',
    });
    expect(updated.json).toMatchObject({ name: 'Autre nom', phones: ['5145551234', '32665'], color: '#e52592', icon: 'briefcase' });
    // Conversations show the contact's look.
    const code = ((await client.get('/api/conversations?q=32665')).json as ConversationDto[])[0]!;
    expect(code.contact).toEqual({ id: moved.json.id, name: 'Autre nom', color: '#e52592', icon: 'briefcase' });
    for (const look of [{ color: 'pink' }, { icon: 'skull' }]) {
      expect((await client.request('PUT', `/api/contacts/${moved.json.id}`, { name: 'x', phones: ['32665'], ...look })).status).toBe(400);
    }
    expect((await client.request('DELETE', `/api/contacts/${moved.json.id}`)).json).toEqual({ ok: true });
    expect((await client.request('DELETE', `/api/contacts/${moved.json.id}`)).status).toBe(404);

    const vcard = [
      'BEGIN:VCARD', 'FN:Nouvelle Personne', 'TEL:819-555-0177', 'END:VCARD',
      'BEGIN:VCARD', 'FN:Déjà là', `TEL:${MARIE}`, 'END:VCARD',
    ].join('\r\n');
    expect((await client.post('/api/contacts/import', { vcard })).json).toEqual({ imported: 1, skipped: 1, ids: [expect.any(Number)] });
  });

  it('deletes contacts in bulk, such as a list imported by mistake, keeping their conversations', async () => {
    const vcard = ['Un', 'Deux', 'Trois'].map((name, i) => `BEGIN:VCARD\r\nFN:Lot ${name}\r\nTEL:873-555-010${i}\r\nEND:VCARD`).join('\r\n');
    const imported = (await client.post('/api/contacts/import', { vcard })).json as { imported: number; ids: number[] };
    expect(imported.imported).toBe(3);
    const names = async () => ((await client.get('/api/contacts')).json as ContactDto[]).map((c) => c.name).filter((n) => n.startsWith('Lot '));
    expect(await names()).toEqual(['Lot Deux', 'Lot Trois', 'Lot Un']);
    expect((await sendForm({ did: MONTREAL, to: '8735550100', body: 'Bonjour' })).status).toBe(202);

    // Ids that are gone, or listed twice, are not counted.
    const [first, ...rest] = imported.ids;
    expect((await client.post('/api/contacts/delete', { ids: [first, first, 999_999] })).json).toEqual({ deleted: 1 });
    expect((await client.post('/api/contacts/delete', { ids: rest })).json).toEqual({ deleted: 2 });
    expect(await names()).toEqual([]);
    expect((await client.post('/api/contacts/delete', { ids: rest })).json).toEqual({ deleted: 0 });
    // The conversation stays, under its number.
    const kept = ((await client.get('/api/conversations?q=8735550100')).json as ConversationDto[])[0]!;
    expect(kept).toMatchObject({ phone: '8735550100', contact: null });

    for (const ids of [[], [0], ['12'], [1.5], Array.from({ length: 5001 }, (_, i) => i + 1)]) {
      expect((await client.post('/api/contacts/delete', { ids })).status).toBe(400);
    }
    expect((await client.post('/api/contacts/delete', {})).status).toBe(400);
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
    expect(status.cron).toEqual({ lastRunAt: null, command: expect.stringMatching(/php .*cron\.php$/) });
    runCron(backend);
    expect((await client.get('/api/sync/status')).json.cron.lastRunAt).toBeGreaterThan(Date.now() - 10_000);
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

describe('The server with numbers left out by its settings', () => {
  const LAVAL = '4505550199';
  const GARAGE = '4505550111';
  let dataDir: string;
  let backend: Backend | undefined;

  async function start(env: Record<string, string>): Promise<Client> {
    await backend?.stop();
    backend = await startBackend({ DATA_DIR: dataDir, ...env });
    const client = new Client(backend.url);
    await client.login();
    return client;
  }

  /** A tab's poll: the PHP server checks VoIP.ms (or imports history) after answering it. */
  async function tick(client: Client): Promise<void> {
    await client.get('/api/events/poll?tab=tab-00000001&visible=1');
  }

  async function conversations(client: Client, query = ''): Promise<string[]> {
    return ((await client.get(`/api/conversations${query}`)).json as ConversationDto[]).map((c) => c.phone).sort();
  }

  beforeAll(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'contract-dids-'));
  });

  afterAll(async () => {
    await backend?.stop();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }, 30_000);

  it('never fetches the texts of a number left out', async () => {
    const client = await start({ ALLOWED_DIDS: '(514) 555-0100' });
    expect((await client.get('/api/session')).json.didsRestricted).toBe(true);
    expect(((await client.get('/api/setup/dids')).json as DidDto[]).map((d) => d.did)).toEqual([MONTREAL]);
    await client.post('/api/setup/complete');
    await waitFor(async () => (await client.get('/api/sync/status')).json.lastSyncAt);
    expect(await conversations(client)).toEqual(['4385550142', '5145550187']);
    const query = `echo json_encode((new PDO('sqlite:' . $argv[1]))->query('SELECT DISTINCT did FROM conversations UNION SELECT did FROM dids')->fetchAll(PDO::FETCH_COLUMN));`;
    const stored = spawnSync('php', ['-r', query, '--', path.join(dataDir, 'portal.db')], { encoding: 'utf8' }).stdout;
    expect(JSON.parse(stored)).toEqual([MONTREAL]);
  }, 30_000);

  it('hides what was stored before a number was left out, until it is allowed again', async () => {
    let client = await start({});
    expect((await client.get('/api/session')).json.didsRestricted).toBe(false);
    await client.get('/api/setup/dids');
    await client.post('/api/setup/import', { days: 7 });
    await waitFor(async () => {
      await tick(client);
      return (await conversations(client)).length === 4;
    });
    const garage = ((await client.get(`/api/conversations?did=${LAVAL}`)).json as ConversationDto[]).find((c) => c.phone === GARAGE)!;
    const failed = (await client.get(`/api/conversations/${garage.id}/messages`)).json as MessageDto[];

    client = await start({ EXCLUDED_DIDS: `450-555-0199, ${GATINEAU}` });
    expect(((await client.get('/api/dids')).json as DidDto[]).map((d) => d.did)).toEqual([MONTREAL]);
    expect(((await client.get('/api/setup/dids')).json as DidDto[]).map((d) => d.did)).toEqual([MONTREAL]);
    expect(await conversations(client)).toEqual(['4385550142', '5145550187']);
    expect(await conversations(client, `?did=${LAVAL}`)).toEqual([]);
    expect(await conversations(client, '?q=BELANGER')).toEqual([]);
    expect((await client.get(`/api/conversations/lookup?did=${LAVAL}&phone=${GARAGE}`)).json).toEqual({ conversation: null });
    for (const [method, url, body] of [
      ['GET', `/api/conversations/${garage.id}`],
      ['GET', `/api/conversations/${garage.id}/messages`],
      ['PATCH', `/api/conversations/${garage.id}`, { archived: true }],
      ['POST', `/api/conversations/${garage.id}/read`],
      ['POST', `/api/messages/${failed[0]!.id}/retry`],
      ['PATCH', `/api/dids/${LAVAL}`, { label: 'x' }],
    ] as const) {
      expect((await client.request(method, url, body)).status, `${method} ${url}`).toBe(404);
    }
    const form = new FormData();
    for (const [k, v] of Object.entries({ did: LAVAL, to: GARAGE, body: 'x' })) form.set(k, v);
    expect((await client.post('/api/messages', form)).json).toEqual({ error: 'unknown_did' });

    client = await start({ ALLOWED_DIDS: LAVAL });
    expect(((await client.get('/api/dids')).json as DidDto[]).map((d) => d.did)).toEqual([LAVAL]);
    expect(await conversations(client)).toEqual(['32665', GARAGE]);
  }, 30_000);

  it('refuses a setting that is not a list of numbers', async () => {
    expect(() => runCron(backend!, { EXCLUDED_DIDS: '514555, 4505550199' })).toThrow('EXCLUDED_DIDS: "514555" is not a 10-digit phone number.');
    // config.php takes a list too.
    const load = (list: string) => {
      fs.writeFileSync(path.join(dataDir, 'config.php'), `<?php return ['APP_PASSWORD' => 'x', 'ALLOWED_DIDS' => ${list}];`);
      const script = `require '${path.resolve('php/app/bootstrap.php')}';
        try { echo json_encode(SmsPortal\\Config::load('${dataDir}')->allowedDids); } catch (SmsPortal\\ConfigError $e) { echo $e->getMessage(); }`;
      return spawnSync('php', ['-r', script], { encoding: 'utf8' }).stdout;
    };
    expect(load(`['514-555-0100', 4505550199]`)).toBe('["5145550100","4505550199"]');
    expect(load(`['514-555-0100', 'office']`)).toBe('ALLOWED_DIDS: "office" is not a 10-digit phone number.');
  }, 30_000);
});

describe('The server with texts announced by VoIP.ms', () => {
  const LAVAL = '4505550199';
  const GATINEAU = '8195550123';
  /** Laval's callback in the demo account, to another system. */
  const CRM = 'https://crm.example.com/sms?from={FROM}&message={MESSAGE}';
  let backend: Backend;
  let client: Client;

  beforeAll(async () => {
    backend = await startBackend({ PUBLIC_URL: 'https://sms.example.com' });
    client = new Client(backend.url);
    await client.login();
    await client.get('/api/setup/dids');
    await client.post('/api/setup/complete');
  }, 30_000);

  afterAll(async () => {
    await backend?.stop();
  });

  const states = (status: { numbers: { did: string; state: string }[] }) => Object.fromEntries(status.numbers.map((n) => [n.did, n.state]));

  it('needs a session to change anything', async () => {
    const stranger = new Client(backend.url);
    expect((await stranger.get('/api/webhook')).status).toBe(401);
    expect((await stranger.post('/api/webhook/enable', {})).status).toBe(401);
    expect((await stranger.post('/api/webhook/disable')).status).toBe(401);
  });

  it('points the numbers at the portal, leaving another callback alone unless asked', async () => {
    const before = (await client.get('/api/webhook')).json;
    expect(before).toMatchObject({ enabled: false, url: null, complete: false, publicUrl: 'https://sms.example.com', safetyMinutes: 15 });
    expect(states(before)).toEqual({ [MONTREAL]: 'none', [LAVAL]: 'other', [GATINEAU]: 'sms_off' });

    const enabled = (await client.post('/api/webhook/enable', {})).json;
    expect(enabled.url).toMatch(/^https:\/\/sms\.example\.com\/api\/voipms\/callback\/[\w-]{32}$/);
    expect(enabled).toMatchObject({ enabled: true, complete: false });
    expect(states(enabled)).toEqual({ [MONTREAL]: 'ours', [LAVAL]: 'other', [GATINEAU]: 'sms_off' });
    expect(enabled.numbers.find((n: { did: string }) => n.did === LAVAL)).toMatchObject({ otherUrl: CRM, error: null });
    expect((await client.post('/api/webhook/enable', { replace: ['450'] })).status).toBe(400);

    const replaced = (await client.post('/api/webhook/enable', { replace: [LAVAL] })).json;
    expect(replaced).toMatchObject({ enabled: true, complete: true, url: enabled.url });
    expect(states(replaced)).toEqual({ [MONTREAL]: 'ours', [LAVAL]: 'ours', [GATINEAU]: 'sms_off' });
    expect((await client.get('/api/sync/status')).json.webhook).toEqual({ lastCallAt: null, complete: true });
  });

  it('answers VoIP.ms "ok" without a session, only at the secret address', async () => {
    const { url } = (await client.get('/api/webhook')).json as { url: string };
    const path = new URL(url).pathname;
    const stranger = new Client(backend.url);
    expect((await stranger.get('/api/voipms/callback/not-the-secret')).status).toBe(404);
    const call = await stranger.get(`${path}?to=${MONTREAL}&from=4385550142&message=Allo&id=1`);
    expect(call.status).toBe(200);
    expect(call.headers.get('content-type')).toMatch(/^text\/plain/);
    expect(call.json).toBe('ok');
    const webhook = (await client.get('/api/sync/status')).json.webhook;
    expect(webhook.lastCallAt).toBeGreaterThan(Date.now() - 60_000);
  });

  it('turns SMS on for a number with the callback already set', async () => {
    expect((await client.post(`/api/dids/${GATINEAU}/enable-sms`)).json).toMatchObject({ smsEnabled: true });
    expect(states((await client.get('/api/webhook')).json)[GATINEAU]).toBe('ours');
  });

  it('gives the numbers back their own callback when turned off', async () => {
    const off = (await client.post('/api/webhook/disable')).json;
    expect(off).toMatchObject({ enabled: false, url: null, complete: false });
    expect(states(off)).toEqual({ [MONTREAL]: 'none', [LAVAL]: 'other', [GATINEAU]: 'none' });
    expect(off.numbers.find((n: { did: string }) => n.did === LAVAL).otherUrl).toBe(CRM);
    expect((await client.get('/api/sync/status')).json.webhook).toBeNull();
  });
});

describe('The server asked for webhooks without HTTPS', () => {
  it('refuses: VoIP.ms could not reach it, and the secret would travel in clear', async () => {
    const backend = await startBackend();
    try {
      const client = new Client(backend.url);
      await client.login();
      await client.post('/api/setup/complete');
      expect(await client.post('/api/webhook/enable', {}, { origin: backend.url })).toMatchObject({ status: 400, json: { error: 'webhook_needs_https' } });
      expect((await client.get('/api/webhook')).json).toMatchObject({ enabled: false, publicUrl: null });
    } finally {
      await backend.stop();
    }
  }, 30_000);
});

describe('The server with several VoIP.ms accounts', () => {
  /** The demo's second sample account: a bakery in Québec. */
  const QUEBEC = '4185550142';
  let backend: Backend;
  let client: Client;

  beforeAll(async () => {
    backend = await startBackend();
    client = new Client(backend.url);
    await client.login();
    await client.get('/api/setup/dids');
    await client.post('/api/setup/complete');
  }, 30_000);

  afterAll(async () => {
    await backend?.stop();
  });

  /** A tab's poll: the PHP server checks VoIP.ms after answering it. */
  const tick = () => client.get('/api/events/poll?tab=tab-00000001&visible=1');
  const send = (fields: Record<string, string>) => {
    const form = new FormData();
    for (const [k, v] of Object.entries(fields)) form.set(k, v);
    return client.post('/api/messages', form);
  };

  it('needs a session', async () => {
    const stranger = new Client(backend.url);
    expect((await stranger.get('/api/accounts')).status).toBe(401);
    expect((await stranger.post('/api/accounts', { username: 'b@example.com', password: 'x' })).status).toBe(401);
  });

  it('lists the account set up first', async () => {
    expect((await client.get('/api/accounts')).json).toEqual([{ id: 1, label: null, username: 'demo@example.com', credentialsSource: 'env', numbers: 3 }]);
  });

  it('adds an account once, checking its credentials, with its own numbers', async () => {
    const added = await client.post('/api/accounts', { label: 'Boulangerie', username: 'b@example.com', password: 'secret' });
    expect(added).toMatchObject({
      status: 201,
      json: {
        account: { id: 2, label: 'Boulangerie', username: 'b@example.com', credentialsSource: 'db', numbers: 1 },
        connection: { status: 'success', ip: '203.0.113.10' },
      },
    });
    expect((await client.post('/api/accounts', { username: 'b@example.com', password: 'other' })).json).toEqual({ error: 'account_exists' });
    expect((await client.post('/api/accounts', { username: 'DEMO@example.com', password: 'x' })).json).toEqual({ error: 'account_exists' });
    expect((await client.post('/api/accounts', { username: 'b', password: 'x' })).status).toBe(400);
    const dids = (await client.get('/api/dids')).json as DidDto[];
    expect(dids.map((d) => [d.did, d.accountId])).toEqual([
      [MONTREAL, 1],
      ['4505550199', 1],
      ['8195550123', 1],
      [QUEBEC, 2],
    ]);
  });

  it('checks the new account, and sends from its number', async () => {
    // Its first check looks a day back, like the first account's: older texts are the history import's.
    const quebec = await waitFor(async () => {
      await tick();
      const conversations = ((await client.get('/api/conversations')).json as ConversationDto[]).filter((c) => c.did === QUEBEC);
      return conversations.length > 0 && conversations;
    });
    expect(quebec.map((c) => c.phone)).toEqual(['4185550123']);
    const res = await send({ did: QUEBEC, to: '4185550177', body: 'Merci, à vendredi!' });
    expect(res.status).toBe(202);
    const id = (res.json as { message: MessageDto }).message.id;
    await waitFor(async () => {
      await tick();
      const messages = (await client.get(`/api/conversations/${(res.json as { conversation: ConversationDto }).conversation.id}/messages`)).json as MessageDto[];
      return messages.find((m) => m.id === id)?.status === 'sent';
    });
  }, 30_000);

  it('renames an account', async () => {
    expect((await client.request('PATCH', '/api/accounts/2', { label: 'Boulangerie Fortin' })).json).toMatchObject({ id: 2, label: 'Boulangerie Fortin' });
    expect((await client.request('PATCH', '/api/accounts/99', { label: 'x' })).status).toBe(404);
  });
});

describe('The server in the Team mode', () => {
  let backend: Backend;
  let owner: Client;
  let admin: Client;
  let marc: Client;
  let marcId: number;

  beforeAll(async () => {
    backend = await startBackend();
    owner = new Client(backend.url);
    await owner.login();
    await owner.get('/api/setup/dids');
    await owner.post('/api/setup/complete');
  }, 30_000);

  afterAll(async () => {
    await backend?.stop();
  });

  /** Signs in from a new browser. Sign-ins are limited to ten a minute: this file makes nine. */
  async function signIn(email: string, password: string) {
    const client = new Client(backend.url);
    const res = await client.post('/api/auth/login', { email, password });
    return { client, res };
  }

  it('starts in the simple mode, where only APP_PASSWORD signs in', async () => {
    expect((await owner.get('/api/session')).json).toMatchObject({ mode: 'simple', user: { role: 'owner' } });
    expect(await owner.get('/api/users')).toMatchObject({ status: 409, json: { error: 'team_mode_off' } });
    expect((await signIn('julie@example.com', 'hunter2')).res).toMatchObject({ status: 401, json: { error: 'wrong_password' } });
  });

  it('turns the Team mode on with a first admin, once, by the owner only', async () => {
    expect((await owner.post('/api/team', { email: 'not-an-email', password: 'correct horse' })).status).toBe(400);
    expect((await owner.post('/api/team', { email: 'julie@example.com', password: 'short' })).status).toBe(400);
    const res = await owner.post('/api/team', { email: ' Julie@Example.com ', name: 'Julie', password: 'correct horse' });
    expect(res).toMatchObject({ status: 201, json: { id: 1, email: 'julie@example.com', name: 'Julie', role: 'admin', disabled: false, numbers: [] } });
    expect(await owner.post('/api/team', { email: 'other@example.com', password: 'correct horse' })).toMatchObject({ status: 409, json: { error: 'team_mode_on' } });
    // The owner stays signed in, and can always come back with APP_PASSWORD.
    expect((await owner.get('/api/session')).json).toMatchObject({ mode: 'team', user: { id: null, role: 'owner' } });
  });

  it('signs users in by email', async () => {
    expect((await signIn('julie@example.com', 'wrong password')).res).toMatchObject({ status: 401, json: { error: 'wrong_password' } });
    expect((await signIn('nobody@example.com', 'correct horse')).res).toMatchObject({ status: 401, json: { error: 'wrong_password' } });
    admin = (await signIn('JULIE@example.com', 'correct horse')).client;
    expect((await admin.get('/api/session')).json).toMatchObject({
      authenticated: true,
      mode: 'team',
      user: { id: 1, email: 'julie@example.com', name: 'Julie', role: 'admin' },
    });
  });

  it('lets admins add users, with the numbers each one texts from', async () => {
    const numbers = [
      { did: '4505550199', canSend: false },
      { did: MONTREAL, canSend: true },
    ];
    const res = await admin.post('/api/users', { email: 'marc@example.com', name: 'Marc', password: 'marc password', role: 'user', numbers });
    expect(res).toMatchObject({ status: 201, json: { email: 'marc@example.com', name: 'Marc', role: 'user', disabled: false, numbers } });
    marcId = res.json.id;
    expect(await admin.post('/api/users', { email: 'marc@example.com', password: 'another one', role: 'user' })).toMatchObject({ status: 409, json: { error: 'email_taken' } });
    expect(
      await admin.post('/api/users', { email: 'x@example.com', password: 'another one', role: 'user', numbers: [{ did: '9995550000', canSend: true }] }),
    ).toMatchObject({ status: 400, json: { error: 'unknown_did', dids: ['9995550000'] } });
    expect((await admin.post('/api/users', { email: 'x@example.com', password: 'another one', role: 'owner' })).status).toBe(400);
    expect(((await admin.get('/api/users')).json as UserDto[]).map((u) => u.email)).toEqual(['julie@example.com', 'marc@example.com']);
    const patched = await admin.request('PATCH', `/api/users/${marcId}`, { name: 'Marc-André', numbers: [{ did: MONTREAL, canSend: false }] });
    expect(patched.json).toMatchObject({ name: 'Marc-André', numbers: [{ did: MONTREAL, canSend: false }] });
    expect((await admin.request('PATCH', `/api/users/${marcId}`, { name: '  ' })).json).toMatchObject({ name: null });
    expect((await admin.request('PATCH', '/api/users/99', { name: 'x' })).status).toBe(404);
  });

  it('keeps users out of what only admins change', async () => {
    marc = (await signIn('marc@example.com', 'marc password')).client;
    expect((await marc.get('/api/session')).json).toMatchObject({ user: { id: marcId, email: 'marc@example.com', role: 'user' } });
    for (const url of ['/api/users', '/api/setup/status', '/api/accounts', '/api/webhook']) {
      expect(await marc.get(url)).toMatchObject({ status: 403, json: { error: 'forbidden' } });
    }
    expect((await marc.request('PATCH', `/api/dids/${MONTREAL}`, { label: 'x' })).status).toBe(403);
    expect((await marc.request('PATCH', '/api/users/1', { disabled: true })).status).toBe(403);
    expect((await marc.post('/api/team', { email: 'y@example.com', password: 'correct horse' })).status).toBe(403);
    expect((await admin.post('/api/team', { email: 'y@example.com', password: 'correct horse' })).status).toBe(403);
    expect((await marc.get('/api/conversations')).status).toBe(200);
  });

  it('stops admins from locking themselves out', async () => {
    expect((await admin.request('PATCH', '/api/users/1', { disabled: true })).json).toEqual({ error: 'cannot_change_self' });
    expect((await admin.request('PATCH', '/api/users/1', { role: 'user' })).json).toEqual({ error: 'cannot_change_self' });
    expect((await admin.request('DELETE', '/api/users/1')).json).toEqual({ error: 'cannot_change_self' });
  });

  /** A tab's poll as `client`: its events since its last one. The server checks VoIP.ms after answering. */
  const cursors = new Map<Client, string>();
  async function poll(client: Client): Promise<ServerEvent[]> {
    const after = cursors.get(client);
    const query = new URLSearchParams({ tab: 'tab-00000002', visible: '1', ...(after ? { after } : {}) });
    const body = (await client.get(`/api/events/poll?${query}`)).json as EventsPollDto;
    cursors.set(client, body.cursor);
    return body.events;
  }

  function send(client: Client, fields: Record<string, string>, files: { type: string; data: Buffer }[] = []) {
    const form = new FormData();
    for (const [k, v] of Object.entries(fields)) form.set(k, v);
    for (const f of files) form.append('files[]', new Blob([new Uint8Array(f.data)], { type: f.type }), 'file');
    return client.post('/api/messages', form);
  }

  it('shows users the numbers given to them only, and lets them text from those they may send from', async () => {
    const all = await waitFor(async () => {
      await poll(owner);
      const list = (await owner.get('/api/conversations')).json as ConversationDto[];
      return list.length === 4 && list;
    });
    await poll(marc);
    expect(((await marc.get('/api/dids')).json as DidDto[]).map((d) => [d.did, d.canSend])).toEqual([[MONTREAL, false]]);
    expect(((await admin.get('/api/dids')).json as DidDto[]).every((d) => d.canSend)).toBe(true);
    const mine = (await marc.get('/api/conversations')).json as ConversationDto[];
    expect(mine.map((c) => c.id)).toEqual(all.filter((c) => c.did === MONTREAL).map((c) => c.id));
    expect(((await marc.get('/api/conversations?q=BELANGER')).json as ConversationDto[])).toEqual([]);

    const garage = all.find((c) => c.did === '4505550199' && c.phone === '4505550111')!;
    expect((await marc.get(`/api/conversations/${garage.id}`)).status).toBe(404);
    expect((await marc.get(`/api/conversations/${garage.id}/messages`)).status).toBe(404);
    expect((await marc.post(`/api/conversations/${garage.id}/read`)).status).toBe(404);
    expect((await marc.request('PATCH', `/api/conversations/${garage.id}`, { archived: true })).status).toBe(404);
    expect((await marc.get('/api/conversations/lookup?did=4505550199&phone=4505550111')).json).toEqual({ conversation: null });
    expect(await send(marc, { did: '4505550199', to: '4505550111', body: 'x' })).toMatchObject({ status: 400, json: { error: 'unknown_did' } });

    // Nor what is sent from the others, its pictures included.
    const sent = await send(owner, { did: '4505550199', to: '4505550111', body: '' }, [{ type: 'image/png', data: PNG }]);
    expect(sent.json.message.sentBy).toEqual({ userId: null, name: null });
    const picture = (sent.json as { message: MessageDto }).message.attachments[0]!;
    expect((await owner.get(picture.url!)).status).toBe(200);
    expect((await marc.get(picture.url!)).status).toBe(404);
    expect((await marc.post(`/api/media/${picture.id}/retry`)).status).toBe(404);
    const events = await waitFor(async () => {
      const batch = await poll(owner);
      return batch.some((e) => e.type === 'message' && e.message.status === 'sent') && batch;
    });
    expect(events.some((e) => e.type === 'message' && e.conversation.id === garage.id)).toBe(true);
    expect((await poll(marc)).filter((e) => 'conversation' in e)).toEqual([]);

    // A number they may only read.
    const marie = mine.find((c) => c.phone === MARIE)!;
    const thread = (await marc.get(`/api/conversations/${marie.id}/messages`)).json as MessageDto[];
    expect(thread.every((m) => m.sentBy === null)).toBe(true);
    expect(await send(marc, { did: MONTREAL, to: MARIE, body: 'x' })).toMatchObject({ status: 403, json: { error: 'read_only' } });
    expect((await marc.request('DELETE', `/api/messages/${thread[0]!.id}`)).json).toEqual({ error: 'read_only' });
    expect((await marc.request('DELETE', `/api/conversations/${marie.id}`)).json).toEqual({ error: 'read_only' });
    expect((await marc.post(`/api/messages/${thread[0]!.id}/retry`)).json).toEqual({ error: 'read_only' });
  }, 30_000);

  it('keeps unread counts and archives per person on the numbers set so, and says who sent each text', async () => {
    expect((await admin.request('PATCH', `/api/users/${marcId}`, { numbers: [{ did: MONTREAL, canSend: true }] })).status).toBe(200);
    const patched = await admin.request('PATCH', `/api/dids/${MONTREAL}`, { sharedState: false });
    expect(patched.json).toMatchObject({ did: MONTREAL, sharedState: false });
    expect((await marc.request('PATCH', `/api/dids/${MONTREAL}`, { sharedState: true })).status).toBe(403);

    const res = await send(marc, { did: MONTREAL, to: MARIE, body: 'Je regarde ça.' });
    expect(res.status).toBe(202);
    const { message, conversation } = res.json as { message: MessageDto; conversation: ConversationDto };
    // Their name, or their email without one.
    expect(message.sentBy).toEqual({ userId: marcId, name: 'marc@example.com' });
    expect(conversation.lastMessage?.sentBy).toEqual(message.sentBy);
    const unread = async (client: Client) => ((await client.get(`/api/conversations/${conversation.id}`)).json as ConversationDto).unreadCount;
    // The demo answers each text.
    await waitFor(async () => (await poll(marc), (await unread(marc)) === 1));
    expect(await unread(owner)).toBe(1);
    expect(((await owner.get(`/api/conversations/${conversation.id}/messages?limit=2`)).json as MessageDto[])[0]!.sentBy).toEqual({ userId: marcId, name: 'marc@example.com' });

    expect((await marc.post(`/api/conversations/${conversation.id}/read`)).json).toEqual({ ok: true });
    expect(await unread(marc)).toBe(0);
    expect(await unread(owner)).toBe(1);
    expect(((await owner.get('/api/dids')).json as DidDto[]).find((d) => d.did === MONTREAL)!.unreadCount).toBe(1);
    expect(((await marc.get('/api/dids')).json as DidDto[])[0]!.unreadCount).toBe(0);
    // Each tab hears of the conversation as it is for its person.
    const seen = (await poll(owner)).flatMap((e) => (e.type === 'conversation' && e.conversation.id === conversation.id ? [e.conversation.unreadCount] : []));
    expect(seen.length).toBeGreaterThan(0);
    expect(new Set(seen)).toEqual(new Set([1]));

    expect((await marc.request('PATCH', `/api/conversations/${conversation.id}`, { archived: true })).json).toMatchObject({ archived: true });
    expect(((await marc.get('/api/conversations')).json as ConversationDto[]).map((c) => c.id)).not.toContain(conversation.id);
    expect(((await owner.get('/api/conversations')).json as ConversationDto[]).map((c) => c.id)).toContain(conversation.id);

    // Shared again: what someone read is read.
    expect((await admin.request('PATCH', `/api/dids/${MONTREAL}`, { sharedState: true })).json).toMatchObject({ sharedState: true });
    expect(await unread(owner)).toBe(0);
    expect(((await marc.get('/api/conversations')).json as ConversationDto[]).map((c) => c.id)).toContain(conversation.id);
  }, 30_000);

  it('lets each person hide a number from their list and mute it, for themselves only', async () => {
    const LAVAL = '4505550199';
    const numbers = [{ did: MONTREAL, canSend: true }, { did: LAVAL, canSend: false }];
    expect((await admin.request('PATCH', `/api/users/${marcId}`, { numbers })).status).toBe(200);
    await poll(admin);
    await poll(marc);

    expect((await marc.request('PATCH', `/api/me/dids/${LAVAL}`, { hidden: true, muted: true })).json).toMatchObject({
      did: LAVAL,
      visible: true,
      hidden: true,
      muted: true,
    });
    expect((await marc.request('PATCH', `/api/me/dids/${GATINEAU}`, { muted: true })).status).toBe(404);
    expect((await marc.request('PATCH', `/api/me/dids/${LAVAL}`, { hidden: 'yes' })).status).toBe(400);
    const mine = (await marc.get('/api/conversations')).json as ConversationDto[];
    expect(mine.length).toBeGreaterThan(0);
    expect(mine.every((c) => c.did === MONTREAL)).toBe(true);
    // Still there when asked for.
    expect(((await marc.get(`/api/conversations?did=${LAVAL}`)).json as ConversationDto[]).length).toBeGreaterThan(0);

    // Nobody else's choice changes, nor their tabs.
    expect(((await admin.get('/api/dids')).json as DidDto[]).find((d) => d.did === LAVAL)).toMatchObject({ hidden: false, muted: false });
    expect(((await admin.get('/api/conversations')).json as ConversationDto[]).some((c) => c.did === LAVAL)).toBe(true);
    expect((await poll(admin)).filter((e) => e.type === 'reload')).toEqual([]);
    expect((await poll(marc)).map((e) => e.type)).toEqual(expect.arrayContaining(['dids', 'reload']));

    expect((await marc.request('PATCH', `/api/me/dids/${LAVAL}`, { hidden: false })).json).toMatchObject({ hidden: false, muted: true });
    expect(((await marc.get('/api/conversations')).json as ConversationDto[]).some((c) => c.did === LAVAL)).toBe(true);
  });

  it('keeps an address book per number, and one of their own for each person', async () => {
    const LAVAL = '4505550199';
    // Marc's own: it names his conversations, and nobody else sees it.
    const own = await marc.post('/api/contacts', { name: 'Ma sœur', phones: [MARIE], book: { kind: 'personal' } });
    expect(own).toMatchObject({ status: 201, json: { book: { kind: 'personal' }, editable: true } });
    const marie = ((await marc.get('/api/conversations')).json as ConversationDto[]).find((c) => c.phone === MARIE)!;
    expect(marie.contact?.name).toBe('Ma sœur');
    expect(((await admin.get(`/api/conversations/${marie.id}`)).json as ConversationDto).contact?.name).toBe('Marie Tremblay');
    expect(((await admin.get('/api/contacts')).json as ContactDto[]).map((c) => c.name)).not.toContain('Ma sœur');

    // Every number's book is the admins'; a number's, theirs and that of whoever may text from it.
    const book = (b: object) => ({ name: 'Pharmacie', phones: ['5145550199'], book: b });
    expect(await marc.post('/api/contacts', book({ kind: 'all' }))).toMatchObject({ status: 403, json: { error: 'book_forbidden' } });
    expect(await marc.post('/api/contacts', book({ kind: 'numbers', dids: [LAVAL] }))).toMatchObject({ status: 403, json: { error: 'book_forbidden' } });
    expect(await marc.post('/api/contacts', book({ kind: 'numbers', dids: [MONTREAL] }))).toMatchObject({
      status: 201,
      json: { book: { kind: 'numbers', dids: [MONTREAL] }, editable: true },
    });
    const garage = await admin.post('/api/contacts', { name: 'Garage du coin', phones: ['4505550188'], book: { kind: 'numbers', dids: [LAVAL] } });
    expect(garage.status).toBe(201);
    expect(((await marc.get('/api/contacts')).json as ContactDto[]).find((c) => c.name === 'Garage du coin')).toMatchObject({ editable: false });
    expect((await marc.request('PUT', `/api/contacts/${garage.json.id}`, { name: 'x', phones: ['4505550188'] })).json).toEqual({ error: 'read_only' });
    expect((await marc.request('DELETE', `/api/contacts/${garage.json.id}`)).json).toEqual({ error: 'read_only' });
    // Alex is in every number's book, which Marc may not change.
    expect(await marc.post('/api/contacts', { name: 'Alex', phones: ['5145550187'], book: { kind: 'numbers', dids: [MONTREAL] }, force: true })).toMatchObject({
      status: 409,
      json: { error: 'phone_locked', phones: ['5145550187'] },
    });

    // Imports go to their own book.
    const imported = await marc.post('/api/contacts/import', { vcard: 'BEGIN:VCARD\r\nVERSION:3.0\r\nFN:Paul\r\nTEL:514-555-0166\r\nEND:VCARD\r\n' });
    expect(imported.json).toMatchObject({ imported: 1 });
    expect(((await marc.get('/api/contacts')).json as ContactDto[]).find((c) => c.name === 'Paul')).toMatchObject({ book: { kind: 'personal' } });
  });

  it('lets users change their own name and password, signing their other browsers out', async () => {
    const phone = (await signIn('marc@example.com', 'marc password')).client;
    expect(((await marc.get('/api/sessions')).json as SessionInfoDto[]).map((s) => s.current).sort()).toEqual([false, true]);
    expect(await marc.request('PATCH', '/api/me', { password: { current: 'wrong', next: 'new marc password' } })).toMatchObject({ status: 400, json: { error: 'wrong_password' } });
    expect((await marc.request('PATCH', '/api/me', { password: { current: 'marc password', next: 'short' } })).status).toBe(400);
    const res = await marc.request('PATCH', '/api/me', { name: 'Marc', password: { current: 'marc password', next: 'new marc password' } });
    expect(res.json).toMatchObject({ id: marcId, name: 'Marc' });
    expect((await phone.get('/api/conversations')).status).toBe(401);
    expect((await marc.get('/api/conversations')).status).toBe(200);
    expect(await owner.request('PATCH', '/api/me', { name: 'x' })).toMatchObject({ status: 409, json: { error: 'owner_has_no_account' } });
  });

  it('lists and ends the sessions of whoever is signed in, and only theirs', async () => {
    const phone = (await signIn('marc@example.com', 'new marc password')).client;
    const sessions = (await marc.get('/api/sessions')).json as SessionInfoDto[];
    expect(sessions).toHaveLength(2);
    const other = sessions.find((s) => !s.current)!;
    expect(other.id).toMatch(/^[\w-]{16}$/);
    expect((await admin.request('DELETE', `/api/sessions/${other.id}`)).status).toBe(404);
    expect((await marc.request('DELETE', `/api/sessions/${other.id}`)).json).toEqual({ ok: true });
    expect((await phone.get('/api/conversations')).status).toBe(401);
    expect((await marc.get('/api/sessions')).json).toHaveLength(1);
  });

  it('turns a disabled user away, even signed in', async () => {
    expect((await admin.request('PATCH', `/api/users/${marcId}`, { disabled: true })).json).toMatchObject({ disabled: true });
    expect((await marc.get('/api/conversations')).status).toBe(401);
    expect((await signIn('marc@example.com', 'new marc password')).res.status).toBe(401);
    expect((await admin.request('DELETE', `/api/users/${marcId}`)).json).toEqual({ ok: true });
    expect((await admin.request('DELETE', `/api/users/${marcId}`)).status).toBe(404);
    expect(((await admin.get('/api/users')).json as UserDto[]).map((u) => u.email)).toEqual(['julie@example.com']);
  });

  it('ends the session on sign-out', async () => {
    const cookie = admin.cookie;
    expect((await admin.post('/api/auth/logout')).json).toEqual({ ok: true });
    const replay = new Client(backend.url);
    replay.cookie = cookie;
    expect((await replay.get('/api/conversations')).status).toBe(401);
  });
});
