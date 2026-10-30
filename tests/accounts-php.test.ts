import http from 'node:http';
import type net from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client, waitFor } from './backends.js';
import { FakeVoipMsServer } from './fake-voipms.js';
import { checkNow, php, sendForm, startPhp, type PhpBackend } from './php-server.js';
import type { ConversationDto, DidDto, MessageDto } from '../shared/types.js';

/**
 * Several VoIP.ms accounts on the PHP server, each a fake VoIP.ms account
 * with its own numbers and history: which account is asked for what, which
 * the demo accounts of the contract tests cannot show (server/app.test.ts
 * checked it for the Node server).
 */

const OTHER_DID = '4185550142';

/** VoIP.ms answers every account at the same address: sends each call to the fake account its credentials are for. */
async function oneAddress(accounts: FakeVoipMsServer[]): Promise<{ url: string; stop: () => Promise<unknown> }> {
  const server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const body = Buffer.concat(chunks);
    const headers = { 'content-type': req.headers['content-type'] ?? '' };
    let username = '';
    try {
      username = String((await new Response(body, { headers }).formData()).get('api_username') ?? '');
    } catch {
      // Not multipart: the first account answers as VoIP.ms would.
    }
    const account = accounts.find((a) => a.username === username) ?? accounts[0]!;
    try {
      const answer = await fetch(account.url + req.url, { method: req.method, headers, body: req.method === 'GET' ? undefined : body });
      res.writeHead(answer.status, { 'content-type': answer.headers.get('content-type') ?? 'text/plain' }).end(Buffer.from(await answer.arrayBuffer()));
    } catch {
      // That account is gone: the tests are over.
      res.writeHead(502).end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${(server.address() as net.AddressInfo).port}`,
    stop: () => {
      server.closeAllConnections();
      return new Promise((resolve) => server.close(resolve));
    },
  };
}

describe('PHP server: several VoIP.ms accounts', () => {
  const first = new FakeVoipMsServer();
  /** The second account, as VoIP.ms would show it: its own number and history. */
  const other = new FakeVoipMsServer('b@example.com', 'secret');
  let voipms: Awaited<ReturnType<typeof oneAddress>>;
  let backend: PhpBackend;
  let client: Client;
  /** The VoIP.ms id of the second account's first text. */
  let pains = '';

  const calls = (account: FakeVoipMsServer, method: string) => account.calls.filter((c) => c.method === method);
  const addOther = () => client.post('/api/accounts', { label: 'Boulangerie', username: 'b@example.com', password: 'secret' });

  beforeAll(async () => {
    other.dids.splice(0, other.dids.length, { did: OTHER_DID, description: 'Québec, QC', sms_available: 1, sms_enabled: 1, mms_available: 1 });
    await first.start();
    await other.start();
    voipms = await oneAddress([first, other]);
    backend = await startPhp(voipms.url, {
      VOIPMS_API_USERNAME: 'me@example.com',
      VOIPMS_API_PASSWORD: 'api-secret',
      PUBLIC_URL: 'https://sms.example.com',
    });
    client = new Client(backend.url);
    await client.login();
    await client.get('/api/setup/dids');
    await client.post('/api/setup/complete');
    await waitFor(async () => (await client.get('/api/sync/status')).json.lastSyncAt);
  }, 30_000);

  afterAll(async () => {
    await backend?.stop();
    await voipms?.stop();
    await first.stop();
    await other.stop();
  });

  it('adds an account with its own numbers, once', async () => {
    expect((await client.get('/api/accounts')).json).toEqual([{ id: 1, label: null, username: 'me@example.com', credentialsSource: 'env', numbers: 2 }]);
    const added = await addOther();
    expect(added).toMatchObject({
      status: 201,
      json: {
        account: { id: 2, label: 'Boulangerie', username: 'b@example.com', credentialsSource: 'db', numbers: 1 },
        connection: { status: 'success' },
      },
    });
    expect((await addOther()).json).toEqual({ error: 'account_exists' });
    expect((await client.post('/api/accounts', { username: 'ME@example.com', password: 'x' })).json).toEqual({ error: 'account_exists' });
    expect(((await client.get('/api/dids')).json as DidDto[]).map((d) => [d.did, d.accountId])).toEqual([
      ['4506575294', 1],
      ['5143604702', 1],
      [OTHER_DID, 2],
    ]);
    // Its credentials are kept encrypted, like the first account's.
    const stored = await php<{ credentials: unknown; setting: string }>(
      backend,
      "return ['credentials' => $app->credentials->get(2), 'setting' => $app->repo->getSetting('account.2.voipms.credentials')];",
    );
    expect(stored.credentials).toEqual({ username: 'b@example.com', password: 'secret' });
    expect(stored.setting).not.toContain('secret');
  });

  it('checks each account for its own numbers only', async () => {
    // The second account's first check: what it finds before is history.
    await checkNow(client);
    // The same VoIP.ms id as a text of the first account: stored apart all the same.
    pains = other.push({ did: OTHER_DID, contact: '4185550177', direction: 'in', message: 'Les pains sont prêts?' });
    // A number of the first account showing up in the second one's history stays the first one's.
    other.push({ did: '4506575294', contact: '4185550188', direction: 'in', message: 'Pas pour ce compte' });
    const own = first.push({ contact: '4383980707', direction: 'in', message: 'Pour le premier compte' });
    expect(own).toBe(pains);
    await checkNow(client);
    const conversations = (await client.get('/api/conversations')).json as ConversationDto[];
    expect(conversations.map((c) => [c.did, c.phone]).sort()).toEqual([
      [OTHER_DID, '4185550177'],
      ['4506575294', '4383980707'],
    ]);
    expect(conversations.every((c) => c.unreadCount === 1)).toBe(true);
    expect(
      await php(backend, `return [$app->repo->findMessageByRemote('sms', '${own}') !== null, $app->repo->findMessageByRemote('sms', '2:${pains}') !== null];`),
    ).toEqual([true, true]);
  }, 30_000);

  it('sends and deletes through the account a number belongs to', async () => {
    const sent = await sendForm(client, { did: OTHER_DID, to: '4185550177', body: 'Merci!' });
    expect(sent.status).toBe(202);
    const { message, conversation } = sent.json as { message: MessageDto; conversation: ConversationDto };
    await waitFor(async () => calls(other, 'sendSMS').length === 1);
    expect(calls(other, 'sendSMS')[0]!.fields).toMatchObject({ did: OTHER_DID, dst: '4185550177', message: 'Merci!' });
    expect(calls(first, 'sendSMS')).toEqual([]);
    await waitFor(async () =>
      ((await client.get(`/api/conversations/${conversation.id}/messages`)).json as MessageDto[]).some((m) => m.id === message.id && m.status === 'sent'),
    );

    expect((await client.request('DELETE', `/api/conversations/${conversation.id}?voipms=1`)).json).toEqual({ ok: true, deleted: 2 });
    await waitFor(async () => calls(other, 'deleteSMS').length === 2);
    // By the ids VoIP.ms knows them by, without the account the portal adds to them.
    const ids = calls(other, 'deleteSMS').map((c) => c.fields.id!);
    expect(ids).toContain(pains);
    expect(ids.every((id) => /^\d+$/.test(id))).toBe(true);
    expect(calls(first, 'deleteSMS')).toEqual([]);
  }, 30_000);

  it('checks the account whose secret VoIP.ms calls with', async () => {
    // Settings only turns the first account's webhook on so far.
    const second = await php<{ enabled: boolean; complete: boolean; url: string }>(backend, "return $app->accounts->get(2)->webhook->enable('https://sms.example.com', []);");
    expect(second).toMatchObject({ enabled: true, complete: true });
    // Each account has its own secret, so its own address.
    const primary = (await client.post('/api/webhook/enable', {})).json as { url: string };
    expect(second.url).not.toBe(primary.url);

    const id = other.push({ did: OTHER_DID, contact: '4185550199', direction: 'in', message: 'Annoncé par VoIP.ms' });
    const checks = calls(first, 'getSMS').length;
    expect(await new Client(backend.url).get(new URL(second.url).pathname)).toMatchObject({ status: 200, json: 'ok' });
    // Stored under the account: two accounts' VoIP.ms ids can never clash.
    await waitFor(async () => php(backend, `return $app->repo->findMessageByRemote('sms', '2:${id}');`));
    // The first account was not checked for it.
    expect(calls(first, 'getSMS')).toHaveLength(checks);
  }, 30_000);
});
