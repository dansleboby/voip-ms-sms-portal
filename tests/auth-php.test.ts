import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from './backends.js';
import { FakeVoipMsServer } from './fake-voipms.js';
import { cron, php, startPhp, type PhpBackend } from './php-server.js';
import type { DidDto } from '../shared/types.js';

/**
 * Signing in and the setup wizard on the PHP server, with VoIP.ms
 * credentials entered in the wizard rather than in the settings, behind a
 * proxy that only PUBLIC_URL describes (server/app.test.ts did this for the
 * Node server).
 */
describe('PHP server: sign-in and setup wizard', () => {
  const voipms = new FakeVoipMsServer();
  let backend: PhpBackend;
  let client: Client;

  /** Reads the numbers from VoIP.ms again, as the wizard does, and returns them as stored. */
  const refresh = async () => (await client.get('/api/setup/dids')).json as DidDto[];
  const did = async (number: string) => ((await client.get('/api/dids')).json as DidDto[]).find((d) => d.did === number);

  beforeAll(async () => {
    await voipms.start();
    // POLL_INTERVAL_ACTIVE left empty: its default.
    backend = await startPhp(voipms.url, { PUBLIC_URL: 'https://sms.example.com', POLL_INTERVAL_ACTIVE: '' });
    client = new Client(backend.url);
  }, 30_000);

  afterAll(async () => {
    await backend?.stop();
    await voipms.stop();
  });

  it('reports the session state', async () => {
    expect((await client.get('/api/session')).json).toMatchObject({
      authenticated: false,
      setupCompleted: false,
      credentialsSource: null,
      pollActiveSeconds: 10,
      // A PHP request cannot hold a stream open: tabs always poll.
      liveUpdates: 'poll',
    });
  });

  it('trusts PUBLIC_URL behind a proxy that rewrites Host and drops the protocol', async () => {
    // The request reaches PHP over plain HTTP, for 127.0.0.1: only PUBLIC_URL says what the browser sees.
    const login = (origin: string) => client.post('/api/auth/login', { password: 'hunter2' }, { origin });
    const res = await login('https://sms.example.com');
    expect(res.status).toBe(200);
    expect(res.headers.get('set-cookie')).toMatch(/; Secure/);
    expect(await login('https://evil.example')).toMatchObject({ status: 403, json: { error: 'bad_origin' } });
    await expect(cron(backend, { PUBLIC_URL: 'sms.example.com' })).rejects.toThrow(/PUBLIC_URL/);
  });

  it('rejects wrong credentials without saving them', async () => {
    const res = await client.post('/api/setup/credentials', { username: 'me@example.com', password: 'bad' });
    expect(res).toMatchObject({ status: 400, json: { error: 'invalid_credentials' } });
    expect((await client.get('/api/setup/status')).json).toEqual({ completed: false, credentialsSource: null, username: null });
  });

  it('validates and stores credentials, encrypted', async () => {
    // Right credentials from an address VoIP.ms does not let in yet: kept, and the wizard says what to do.
    voipms.failNext.getBalance = 'ip_not_enabled';
    const res = await client.post('/api/setup/credentials', { username: 'me@example.com', password: 'api-secret' });
    expect(res.json).toEqual({ ip: '198.51.100.7', status: 'ip_not_enabled', balance: null });
    expect((await client.get('/api/setup/status')).json).toEqual({ completed: false, credentialsSource: 'db', username: 'me@example.com' });
    const stored = await php<string>(backend, "return $app->repo->getSetting('voipms.credentials');");
    expect(stored).not.toContain('api-secret');

    expect((await client.post('/api/setup/test')).json).toMatchObject({ status: 'success', balance: 24.1175 });
  });

  it('lists numbers and completes', async () => {
    expect((await refresh()).map((d) => d.did)).toEqual(['4506575294', '5143604702']);
    expect((await client.post('/api/setup/complete')).json).toEqual({ ok: true });
    expect((await client.get('/api/session')).json).toMatchObject({ setupCompleted: true, credentialsSource: 'db' });
  });

  it('shows a number once SMS is turned on for it in VoIP.ms, then leaves it as the user sets it', async () => {
    const OFF = '5143604702';
    expect(await did(OFF)).toMatchObject({ smsEnabled: false, visible: false });
    voipms.dids.find((d) => d.did === OFF)!.sms_enabled = 1;
    await refresh();
    expect(await did(OFF)).toMatchObject({ smsEnabled: true, visible: true });
    expect((await client.request('PATCH', `/api/dids/${OFF}`, { visible: false })).status).toBe(200);
    await refresh();
    expect(await did(OFF)).toMatchObject({ smsEnabled: true, visible: false });
  });

  it('turns SMS on only where VoIP.ms offers it', async () => {
    const TOLL_FREE = '8335550142';
    voipms.dids.push({ did: TOLL_FREE, description: 'Sans frais', sms_available: 0, sms_enabled: 0, mms_available: 0 });
    await refresh();
    const res = await client.post(`/api/dids/${TOLL_FREE}/enable-sms`);
    expect(res).toMatchObject({ status: 409, json: { error: 'sms_not_available' } });
    expect(voipms.calls.some((c) => c.method === 'setSMS')).toBe(false);
    expect(await did(TOLL_FREE)).toMatchObject({ smsEnabled: false, smsAvailable: false, visible: false });
  });

  it('sends the user back to the wizard when stored credentials cannot be read', async () => {
    expect((await client.get('/api/session')).json.setupCompleted).toBe(true);
    // What a change of APP_PASSWORD, or a damaged value, leaves: credentials that no longer decrypt.
    await php(backend, `$app->repo->setSetting('voipms.credentials', '{"kdf":"pbkdf2-sha256","iv":"AAAAAAAAAAAAAAAA","tag":"AAAAAAAAAAAAAAAAAAAAAA==","data":"AAAA"}');`);
    expect((await client.get('/api/session')).json).toMatchObject({ authenticated: true, setupCompleted: false, credentialsSource: null });
  });
});
