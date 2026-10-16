import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client, phpAvailable, startBackend, waitFor, type Backend } from './backends.js';
import { FakeVoipMsServer } from './fake-voipms.js';
import type { ConversationDto, MessageDto } from '../shared/types.js';

/**
 * The PHP version against a VoIP.ms account over HTTP (a fake one): its
 * curl client, sync, sends and media downloads, which demo mode skips.
 */

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);
const DID = '4506575294';
const MARIE = '4383980707';

describe.runIf(phpAvailable || process.env.REQUIRE_PHP)('PHP server with a VoIP.ms account', () => {
  const voipms = new FakeVoipMsServer();
  let backend: Backend;
  let client: Client;

  const conversations = async () => (await client.get('/api/conversations')).json as ConversationDto[];
  const thread = async (id: number) => (await client.get(`/api/conversations/${id}/messages`)).json as MessageDto[];
  /** A tab's poll: what makes the PHP version check VoIP.ms while the app is open. */
  const poll = () => client.get('/api/events/poll?tab=tab-00000001&visible=1');
  const send = (fields: Record<string, string>, files: Buffer[] = []) => {
    const form = new FormData();
    for (const [k, v] of Object.entries(fields)) form.set(k, v);
    for (const f of files) form.append('files[]', new Blob([f], { type: 'image/png' }), 'photo.png');
    return client.post('/api/messages', form);
  };

  beforeAll(async () => {
    await voipms.start();
    // The first check looks one day back; older history is the import's job.
    voipms.push({ direction: 'in', contact: MARIE, message: 'Ancien message', at: Date.now() - 2 * 3_600_000 });
    backend = await startBackend('php', {
      DEMO_MODE: 'false',
      VOIPMS_API_URL: `${voipms.url}/api/v1/rest.php`,
      VOIPMS_API_USERNAME: 'me@example.com',
      VOIPMS_API_PASSWORD: 'api-secret',
    });
    client = new Client(backend.url);
    await client.login();
  }, 30_000);

  afterAll(async () => {
    await backend?.stop();
    await voipms.stop();
  });

  it('calls the API the way it wants: multipart, one kind of message at a time', async () => {
    expect((await client.post('/api/setup/test')).json).toEqual({ ip: '198.51.100.7', status: 'success', balance: 24.1175 });
    const dids = (await client.get('/api/setup/dids')).json;
    expect(dids.map((d: { did: string; smsEnabled: boolean; description: string | null }) => [d.did, d.smsEnabled, d.description])).toEqual([
      [DID, true, 'Le Gardeur, QC'],
      ['5143604702', false, null],
    ]);
    await client.post('/api/setup/complete');
    // A check fetches SMS, then MMS: wait for the whole of it.
    await waitFor(async () => (await client.get('/api/sync/status')).json.lastCheckAt);
    const [first] = await conversations();
    expect(first).toMatchObject({ phone: MARIE, unreadCount: 0, lastMessage: { body: 'Ancien message' } });

    const sms = voipms.calls.find((c) => c.method === 'getSMS')!;
    expect(sms.fields).toMatchObject({ api_username: 'me@example.com', api_password: 'api-secret', content_type: 'json', all_messages: '0' });
    expect(sms.fields.timezone).toBeUndefined();
    expect(sms.fields.from).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(voipms.calls.some((c) => c.method === 'getMMS')).toBe(true);
  });

  it('picks up new texts when a tab polls, with their pictures', async () => {
    voipms.files.set('a.png', { type: 'image/png', data: PNG });
    voipms.push({ direction: 'in', contact: MARIE, message: 'C\\\\\\\'est l\\\'heure', media: `${voipms.url}/media/a.png` });
    voipms.push({ direction: 'in', contact: '5145551234', message: 'Nouveau' });
    const list = await waitFor(async () => {
      await poll();
      const all = await conversations();
      return all.length === 2 && all.every((c) => c.unreadCount === 1) && all;
    });
    expect(list.map((c) => c.phone).sort()).toEqual([MARIE, '5145551234']);
    const marie = list.find((c) => c.phone === MARIE)!;
    const picture = await waitFor(async () => {
      await poll();
      const last = (await thread(marie.id)).at(-1)!;
      return last.attachments[0]?.status === 'ready' && last;
    });
    // Quotes escaped by VoIP.ms, once or more, come out clean.
    expect(picture.body).toBe("C'est l'heure");
    const media = await fetch(backend.url + picture.attachments[0]!.url!, { headers: { cookie: client.cookie } });
    expect(Buffer.from(await media.arrayBuffer()).equals(PNG)).toBe(true);
  });

  it('sends SMS and MMS through VoIP.ms', async () => {
    const sms = (await send({ did: DID, to: MARIE, body: 'Allô é' })).json.message as MessageDto;
    const mms = (await send({ did: DID, to: MARIE, body: 'Photo' }, [PNG])).json.message as MessageDto;
    const conversation = (await conversations()).find((c) => c.phone === MARIE)!;
    await waitFor(async () => {
      const items = await thread(conversation.id);
      return [sms.id, mms.id].every((id) => items.find((m) => m.id === id)?.status === 'sent');
    });
    expect(voipms.calls.find((c) => c.method === 'sendSMS')!.fields).toMatchObject({ did: DID, dst: MARIE, message: 'Allô é' });
    const sendMms = voipms.calls.find((c) => c.method === 'sendMMS')!.fields;
    expect(sendMms).toMatchObject({ message: 'Photo', media1: `data:image/png;base64,${PNG.toString('base64')}` });
    expect(sendMms.media2).toBeUndefined();
  });

  it('checks the history before sending again after an ambiguous failure', async () => {
    voipms.failNext.sendSMS = 'http_522';
    const message = (await send({ did: DID, to: MARIE, body: 'Une seule fois' })).json.message as MessageDto;
    const conversation = (await conversations()).find((c) => c.phone === MARIE)!;
    const failed = await waitFor(async () => (await thread(conversation.id)).find((m) => m.id === message.id && m.status === 'failed'));
    expect(failed.error).toBe('http_error');
    const sendsBefore = voipms.calls.filter((c) => c.method === 'sendSMS').length;
    // VoIP.ms did send it: the retry finds it in the history instead of texting twice.
    const retried = await client.post(`/api/messages/${message.id}/retry`);
    expect(retried.json).toMatchObject({ id: message.id, status: 'sent' });
    expect(voipms.calls.filter((c) => c.method === 'sendSMS')).toHaveLength(sendsBefore);
    expect((await thread(conversation.id)).filter((m) => m.body === 'Une seule fois')).toHaveLength(1);
  });

  it('reports VoIP.ms refusals, and keeps checking', async () => {
    voipms.failNext.getSMS = 'ip_not_enabled';
    const before = (await client.get('/api/sync/status')).json.lastCheckAt as number;
    await client.post('/api/sync/now');
    const failing = await waitFor(async () => {
      const status = (await client.get('/api/sync/status')).json;
      return status.lastCheckAt > before && status;
    });
    expect(failing).toMatchObject({ state: 'error', lastError: 'ip_not_enabled' });
    expect(failing.lastSyncAt).toBeLessThan(failing.lastCheckAt);
    await client.post('/api/sync/now');
    await waitFor(async () => (await client.get('/api/sync/status')).json.lastError === null);
  });

  it('refuses wrong credentials in the wizard without keeping them', async () => {
    expect((await client.post('/api/setup/credentials', { username: 'me@example.com', password: 'nope' })).json).toEqual({
      error: 'credentials_from_env',
    });
  });
});
