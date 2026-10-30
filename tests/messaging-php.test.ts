import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client, waitFor } from './backends.js';
import { FakeVoipMsServer } from './fake-voipms.js';
import { checkNow, cron, php, sendForm, startPhp, type PhpBackend } from './php-server.js';
import type { ContactDto, ConversationDto, DidDto, MessageDto } from '../shared/types.js';

/**
 * Texts on the PHP server with a VoIP.ms account (a fake one, over HTTP):
 * what tests/voipms-php.test.ts and the contract tests leave out, as
 * server/app.test.ts checked it for the Node server.
 */

const DID = '4506575294';
const MARIE = '4383980707';

describe('PHP server: messaging', () => {
  const voipms = new FakeVoipMsServer();
  let backend: PhpBackend;
  let client: Client;

  const conversation = async (phone: string) =>
    ((await client.get(`/api/conversations/lookup?did=${DID}&phone=${phone}`)).json as { conversation: ConversationDto | null }).conversation;
  const thread = async (id: number) => (await client.get(`/api/conversations/${id}/messages`)).json as MessageDto[];
  const message = async (conversationId: number, id: number) => (await thread(conversationId)).find((m) => m.id === id);
  const list = async (query = '') => ((await client.get(`/api/conversations${query}`)).json as ConversationDto[]).map((c) => c.id);
  /** A tab's poll: the PHP server checks VoIP.ms, and deletes there, after answering it. */
  const poll = () => client.get('/api/events/poll?tab=tab-00000001&visible=1');
  /** A text received by the account, once a check has brought it in. */
  async function receive(phone: string, ...bodies: string[]): Promise<ConversationDto> {
    for (const body of bodies) voipms.push({ direction: 'in', contact: phone, message: body });
    await checkNow(client);
    return (await conversation(phone))!;
  }

  beforeAll(async () => {
    await voipms.start();
    backend = await startPhp(voipms.url, { VOIPMS_API_USERNAME: 'me@example.com', VOIPMS_API_PASSWORD: 'api-secret' });
    client = new Client(backend.url);
    await client.login();
    await client.get('/api/setup/dids');
    await client.post('/api/setup/complete');
    // The first check only sets a baseline: texts after it are new.
    await waitFor(async () => (await client.get('/api/sync/status')).json.lastSyncAt);
  }, 30_000);

  afterAll(async () => {
    await backend?.stop();
    await voipms.stop();
  });

  it('sends long accented texts as MMS', async () => {
    // 160 characters, but 170 bytes: VoIP.ms counts its SMS limit in bytes.
    const body = 'é'.repeat(10) + 'a'.repeat(150);
    const { message: sent, conversation: conv } = (await sendForm(client, { did: DID, to: MARIE, body })).json as { message: MessageDto; conversation: ConversationDto };
    expect(sent.kind).toBe('mms');
    await waitFor(async () => (await message(conv.id, sent.id))?.status === 'sent');
    expect(voipms.calls.filter((c) => c.method === 'sendSMS')).toEqual([]);
    const mms = voipms.calls.find((c) => c.method === 'sendMMS')!.fields;
    expect(mms).toMatchObject({ did: DID, dst: MARIE, message: body });
    expect(mms.media1).toBeUndefined();
  });

  it('marks failed sends and retries them', async () => {
    voipms.failNext.sendSMS = 'limit_reached';
    const { message: sent, conversation: conv } = (await sendForm(client, { did: DID, to: MARIE, body: 'Hello' })).json as { message: MessageDto; conversation: ConversationDto };
    const failed = await waitFor(async () => {
      const m = await message(conv.id, sent.id);
      return m?.status === 'failed' && m;
    });
    expect(failed.error).toBe('limit_reached');
    const checks = voipms.calls.filter((c) => c.method === 'getSMS').length;
    const retry = await client.post(`/api/messages/${sent.id}/retry`);
    expect(retry).toMatchObject({ status: 200, json: { id: sent.id, status: 'sending' } });
    await waitFor(async () => (await message(conv.id, sent.id))?.status === 'sent');
    expect(voipms.calls.filter((c) => c.method === 'sendSMS' && c.fields.message === 'Hello')).toHaveLength(2);
    // Refused for sure the first time: sent again without looking at the history first.
    expect(voipms.calls.filter((c) => c.method === 'getSMS')).toHaveLength(checks);
  });

  it('does not show a sent message twice once the check sees it', async () => {
    const { message: sent, conversation: conv } = (await sendForm(client, { did: DID, to: MARIE, body: 'Once' })).json as { message: MessageDto; conversation: ConversationDto };
    await waitFor(async () => (await message(conv.id, sent.id))?.status === 'sent');
    expect((await message(conv.id, sent.id))!.carrierStatus).toBeNull();
    // VoIP.ms lists it in its history, delivered.
    await checkNow(client);
    const once = (await thread(conv.id)).filter((m) => m.body === 'Once');
    expect(once).toMatchObject([{ id: sent.id, status: 'sent', carrierStatus: 'Delivered' }]);
  });

  it('does not delete a message still being sent', async () => {
    const PHONE = '5145550001';
    const { message: first, conversation: conv } = (await sendForm(client, { did: DID, to: PHONE, body: 'Premier' })).json as { message: MessageDto; conversation: ConversationDto };
    await waitFor(async () => (await message(conv.id, first.id))?.status === 'sent');
    // A send whose outcome is not known yet.
    const id = await php<number>(
      backend,
      `return $app->repo->insertMessage(['conversationId' => ${conv.id}, 'kind' => 'sms', 'remoteId' => null, 'direction' => 'out',
        'body' => 'En route', 'sentAt' => SmsPortal\\Time::nowMs(), 'status' => 'sending']);`,
    );
    expect(await client.request('DELETE', `/api/messages/${id}`)).toMatchObject({ status: 409, json: { error: 'still_sending' } });
    // Deleting the conversation leaves it too.
    expect((await client.request('DELETE', `/api/conversations/${conv.id}`)).json).toEqual({ ok: true, deleted: 1 });
    expect((await thread(conv.id)).map((m) => m.body)).toEqual(['En route']);
  });

  it('marks sends cut off with their request as failed, from the cron job', async () => {
    // No process restarts here: a send stays "sending" when PHP stops its request halfway.
    const PHONE = '5145550002';
    const ids = await php<{ conversation: number; stale: number; fresh: number }>(
      backend,
      `$conversation = $app->repo->getOrCreateConversation('${DID}', '${PHONE}');
       $insert = fn (string $body) => $app->repo->insertMessage(['conversationId' => $conversation, 'kind' => 'sms', 'remoteId' => null,
         'direction' => 'out', 'body' => $body, 'sentAt' => SmsPortal\\Time::nowMs(), 'status' => 'sending']);
       SmsPortal\\Time::travelTo(SmsPortal\\Time::nowMs() - 6 * 60_000);
       $stale = $insert('Coupé');
       SmsPortal\\Time::travelTo(null);
       $fresh = $insert('Parti à l’instant');
       $app->repo->touchConversation($conversation);
       return ['conversation' => $conversation, 'stale' => $stale, 'fresh' => $fresh];`,
    );
    await cron(backend);
    expect(await message(ids.conversation, ids.stale)).toMatchObject({ status: 'failed', error: 'interrupted' });
    // A send that just started may still finish.
    expect(await message(ids.conversation, ids.fresh)).toMatchObject({ status: 'sending' });
  });

  it('marks conversations read and filters by search', async () => {
    const conv = await receive('5145551234', 'Rendez-vous chez le dentiste');
    expect(conv.unreadCount).toBe(1);
    expect((await client.post(`/api/conversations/${conv.id}/read`)).json).toEqual({ ok: true });
    expect((await conversation('5145551234'))!.unreadCount).toBe(0);
    expect(await list('?q=dentiste')).toEqual([conv.id]);
  });

  it('searches without regard to accents or case, in messages and contact names', async () => {
    await receive('5145551235', 'Ça coûte 40 $ pour la vidange, à tantôt');
    await receive('4505550111', 'Bonjour');
    expect((await client.post('/api/contacts', { name: 'Garage Bélanger', phones: ['4505550111'] })).status).toBe(201);
    const search = async (q: string) => ((await client.get(`/api/conversations?q=${encodeURIComponent(q)}`)).json as ConversationDto[]).map((c) => c.phone);
    expect(await search('cout')).toEqual(['5145551235']);
    expect(await search('A TANTOT')).toEqual(['5145551235']);
    expect(await search('Coûte')).toEqual(['5145551235']);
    expect(await search('belanger')).toEqual(['4505550111']);
    expect(await search('BÉLANGER')).toEqual(['4505550111']);
    // "%" is a character to find, not a wildcard.
    expect(await search('40 %')).toEqual([]);
  });

  it('archives conversations until a new message arrives', async () => {
    const PHONE = '5145551236';
    const unread = async () => ((await client.get('/api/dids')).json as DidDto[]).find((d) => d.did === DID)!.unreadCount;
    const before = await unread();
    const conv = await receive(PHONE, 'Premier');
    expect(await unread()).toBe(before + 1);

    const res = await client.request('PATCH', `/api/conversations/${conv.id}`, { archived: true });
    expect(res.json).toMatchObject({ id: conv.id, archived: true });
    expect(await list()).not.toContain(conv.id);
    expect(await list('?archived=1')).toEqual([conv.id]);
    // Search looks into archived conversations too, unless told otherwise.
    expect(await list('?q=premier')).toContain(conv.id);
    expect(await list('?q=premier&archived=0')).not.toContain(conv.id);
    // Archived conversations do not count in the badges.
    expect(await unread()).toBe(before);

    await receive(PHONE, 'Deuxième');
    expect((await conversation(PHONE))!.archived).toBe(false);

    await client.request('PATCH', `/api/conversations/${conv.id}`, { archived: true });
    expect((await sendForm(client, { did: DID, to: PHONE, body: 'Réponse' })).status).toBe(202);
    expect((await conversation(PHONE))!.archived).toBe(false);

    expect((await client.request('PATCH', '/api/conversations/999999', { archived: true })).status).toBe(404);
  });

  it('keeps conversations archived when older history is imported', async () => {
    const PHONE = '5145551237';
    const conv = await receive(PHONE, 'Récent');
    await client.request('PATCH', `/api/conversations/${conv.id}`, { archived: true });
    voipms.push({ direction: 'in', contact: PHONE, message: 'Vieux', at: Date.now() - 40 * 86_400_000 });
    expect((await client.post('/api/setup/import', { days: 60 })).status).toBe(202);
    await waitFor(async () => (await poll(), (await client.get('/api/sync/status')).json.importing === null));
    expect((await thread(conv.id)).map((m) => m.body)).toEqual(['Vieux', 'Récent']);
    expect((await conversation(PHONE))!.archived).toBe(true);
  }, 30_000);

  it('deletes at VoIP.ms in the background, trying again after a failure that may pass', async () => {
    const conv = await receive('5145551238', 'À effacer', 'À garder', 'Refusé');
    const local = async (body: string) => (await thread(conv.id)).find((m) => m.body === body)!;
    const pending = () => php<unknown[]>(backend, 'return $app->repo->pendingRemoteDeletes(10);');
    const deletes = () => voipms.calls.filter((c) => c.method === 'deleteSMS').map((c) => c.fields.id);
    const del = async (body: string) => (await client.request('DELETE', `/api/messages/${(await local(body)).id}?voipms=1`)).json;
    const before = deletes().length;

    // Cloudflare in front of VoIP.ms gives up: worth another try.
    voipms.failNext.deleteSMS = 'http_522';
    expect(await del('À effacer')).toEqual({ ok: true });
    await waitFor(async () => deletes().length === before + 1);
    expect(await pending()).toHaveLength(1);
    // The next poll (or cron run) tries again.
    await waitFor(async () => (await poll(), deletes().length === before + 2));
    const [failed, retried] = deletes().slice(before);
    expect(retried).toBe(failed);
    await waitFor(async () => (await pending()).length === 0);

    // A refusal is final: the message stays deleted here.
    voipms.failNext.deleteSMS = 'invalid_sms';
    expect(await del('Refusé')).toEqual({ ok: true });
    await waitFor(async () => deletes().length === before + 3);
    await waitFor(async () => (await pending()).length === 0);
    // Not asked again; VoIP.ms still lists it, and it does not come back.
    await poll();
    await checkNow(client);
    expect(deletes()).toHaveLength(before + 3);
    expect((await thread(conv.id)).map((m) => m.body)).toEqual(['À garder']);
  }, 30_000);
});

describe('PHP server: contacts', () => {
  let backend: PhpBackend;
  let client: Client;

  beforeAll(async () => {
    // Contacts need no VoIP.ms account.
    backend = await startPhp('http://127.0.0.1:9');
    client = new Client(backend.url);
    await client.login();
  }, 30_000);

  afterAll(async () => {
    await backend?.stop();
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
    const res = await client.post('/api/contacts/import', { vcard });
    const contacts = (await client.get('/api/contacts')).json as ContactDto[];
    // With the new contacts' ids, for Undo; a card without a number is not a contact.
    expect(res.json).toEqual({ imported: 2, skipped: 0, ids: expect.arrayContaining(contacts.map((c) => c.id)) });
    expect(contacts).toEqual([
      expect.objectContaining({ name: 'Garage Bélanger', phones: ['4505550111'] }),
      expect.objectContaining({ name: 'Marie Tremblay', phones: ['4385550142'] }),
    ]);
  });
});
