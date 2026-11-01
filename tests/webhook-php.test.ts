import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client, waitFor } from './backends.js';
import { FakeVoipMsServer } from './fake-voipms.js';
import { startPhp, type PhpBackend } from './php-server.js';
import type { ConversationDto, EventsPollDto, SyncStatusDto } from '../shared/types.js';

/**
 * Texts announced by VoIP.ms on the PHP server: how often it still checks
 * VoIP.ms, which tests/voipms-php.test.ts and the contract tests leave out
 * (server/app.test.ts checked it for the Node server). Checks run after
 * a tab's poll when one is due, every POLL_INTERVAL_ACTIVE (3 s here).
 */
describe('PHP server: texts announced by VoIP.ms', () => {
  const voipms = new FakeVoipMsServer();
  let backend: PhpBackend;
  let client: Client;
  let cursor: string | null = null;

  /** Checks of VoIP.ms so far: each one asks for SMS, then MMS. */
  const checks = () => voipms.calls.filter((c) => c.method === 'getSMS').length;
  /** A tab's poll; from its second one on, it is no longer opening. */
  const poll = async () => {
    cursor = ((await client.get(`/api/events/poll?tab=tab-00000001&visible=1${cursor ? `&after=${cursor}` : ''}`)).json as EventsPollDto).cursor;
  };
  /** Until no check runs, and a moment more for one about to start. */
  const settle = async () => {
    await waitFor(async () => ((await client.get('/api/sync/status')).json as SyncStatusDto).state !== 'syncing');
    await new Promise((r) => setTimeout(r, 300));
  };

  beforeAll(async () => {
    await voipms.start();
    // Both numbers text, with no callback of their own: the portal can have them all.
    Object.assign(voipms.dids.find((d) => d.did === '5143604702')!, { sms_enabled: 1, sms_url_callback: '', sms_url_callback_enabled: '0' });
    backend = await startPhp(voipms.url, {
      VOIPMS_API_USERNAME: 'me@example.com',
      VOIPMS_API_PASSWORD: 'api-secret',
      PUBLIC_URL: 'https://sms.example.com',
    });
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

  it('reports the numbers VoIP.ms refused to change, and keeps checking at the usual pace', async () => {
    voipms.failNext.setSMS = 'sms_wait_message';
    const enabled = (await client.post('/api/webhook/enable', {})).json;
    expect(enabled.numbers).toEqual([
      { did: '4506575294', state: 'none', otherUrl: null, error: 'sms_wait_message' },
      { did: '5143604702', state: 'ours', otherUrl: null, error: null },
    ]);
    expect(enabled.complete).toBe(false);
    expect((await client.get('/api/sync/status')).json.webhook).toEqual({ lastCallAt: null, complete: false });
    // A number VoIP.ms does not announce texts for: the tab's polls check it as before.
    await poll();
    await settle();
    const before = checks();
    await waitFor(async () => (await poll(), checks() > before));
    // Asked again a minute later, the number follows.
    expect((await client.post('/api/webhook/enable', {})).json).toMatchObject({ enabled: true, complete: true });
  }, 30_000);

  it('ignores calls with a wrong secret', async () => {
    expect((await new Client(backend.url).get('/api/voipms/callback/guess')).status).toBe(404);
    expect((await client.get('/api/sync/status')).json.webhook).toEqual({ lastCallAt: null, complete: true });
  });

  it('checks VoIP.ms as soon as it calls, then only as a safety net', async () => {
    const { url } = (await client.get('/api/webhook')).json as { url: string };
    await settle();
    const queries = checks();
    voipms.push({ direction: 'in', contact: '5145550001', message: 'Allô par webhook' });
    expect(await new Client(backend.url).get(new URL(url).pathname)).toMatchObject({ status: 200, json: 'ok' });
    // A notification and an unread badge, as for a text found by a scheduled check.
    const conversation = await waitFor(async () => ((await client.get('/api/conversations')).json as ConversationDto[]).find((c) => c.phone === '5145550001'));
    expect(conversation).toMatchObject({ unreadCount: 1 });
    expect(checks()).toBe(queries + 1);
    expect((await client.get('/api/sync/status')).json.webhook.lastCallAt).toBeGreaterThan(Date.now() - 60_000);

    // No more checks every few seconds while the tab polls: the next one is the safety net, a quarter of an hour away.
    await settle();
    const after = checks();
    for (const end = Date.now() + 3500; Date.now() < end; ) {
      await poll();
      await new Promise((r) => setTimeout(r, 250));
    }
    await settle();
    expect(checks()).toBe(after);
    // A tab that opens still checks, once the usual interval has passed.
    cursor = null;
    await waitFor(async () => (await poll(), checks() > after));
  }, 30_000);
});
