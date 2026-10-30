import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FakeVoipMsServer } from './fake-voipms.js';

/**
 * The VoIP.ms client (php/app/src/VoipMs/RestClient.php) against the fake
 * VoIP.ms over HTTP, one call at a time. Enabling SMS and pointing URL callbacks
 * are checked through the API in tests/voipms-php.test.ts.
 */

const exec = promisify(execFile);

describe('PHP RestClient', () => {
  let voipms: FakeVoipMsServer;

  beforeEach(async () => {
    voipms = new FakeVoipMsServer();
    await voipms.start();
  });

  afterEach(() => voipms.stop());

  /** Runs one method of the client in a php process; not execFileSync, which would block the fake's answers. */
  const call = async (method: string, ...args: unknown[]) => {
    const { stdout } = await exec('php', [path.join(import.meta.dirname, 'php/voipms-client.php'), `${voipms.url}/api/v1/rest.php`, method, JSON.stringify(args)]);
    return JSON.parse(stdout) as { result?: unknown; error?: string };
  };

  it('posts multipart form data with credentials and method', async () => {
    // The fake answers anything else than multipart with a SOAP fault, as the live API does.
    expect(await call('sendSms', '4506575294', '4383980707', 'Allô é')).toEqual({ result: '1000' });
    expect(voipms.calls).toHaveLength(1);
    expect(voipms.calls[0]!.fields).toMatchObject({
      api_username: 'me@example.com',
      api_password: 'api-secret',
      method: 'sendSMS',
      content_type: 'json',
      message: 'Allô é',
    });
  });

  it('turns error statuses into VoipMsError', async () => {
    voipms.failNext.getBalance = 'ip_not_enabled';
    expect(await call('getBalance')).toEqual({ error: 'ip_not_enabled' });
  });

  it('reports Cloudflare errors (seen live: "error code: 522") as http_error', async () => {
    voipms.failNext.getIP = 'http_522';
    expect(await call('getIP')).toEqual({ error: 'http_error' });
  });

  it('reports non-JSON bodies', async () => {
    voipms.failNext.getIP = 'not_json';
    expect(await call('getIP')).toEqual({ error: 'invalid_response' });
  });

  it('treats no_sms as an empty result and asks for one kind at a time', async () => {
    expect(await call('getMessages', 'mms', '2026-10-01', '2026-10-02', 100)).toEqual({ result: [] });
    const fields = voipms.calls[0]!.fields;
    expect(fields).toMatchObject({ method: 'getMMS', all_messages: '0' });
    expect(fields.timezone).toBeUndefined();
  });

  it('passes up to three media to sendMMS', async () => {
    await call('sendMms', '4506575294', '4383980707', '', ['data:a', 'data:b', 'data:c', 'data:d']);
    const fields = voipms.calls[0]!.fields;
    expect(fields).toMatchObject({ method: 'sendMMS', media1: 'data:a', media3: 'data:c' });
    expect(fields.media4).toBeUndefined();
  });

  it('parses DIDs with mixed string/number flags', async () => {
    voipms.dids.splice(
      0,
      voipms.dids.length,
      { did: '4506575294', description: 'Le Gardeur, QC', sms_available: 1, sms_enabled: '1', mms_available: 1 },
      // A callback switched off keeps its address at VoIP.ms: it is not one.
      { did: '5143604702', sms_url_callback_enabled: '0', sms_url_callback: 'https://old.example/sms' },
      { did: '4385550100', sms_enabled: 1, sms_url_callback_enabled: 1, sms_url_callback: 'https://hook.example/sms?to={TO}', sms_url_callback_retry: '1' },
    );
    expect((await call('getDids')).result).toEqual([
      { did: '4506575294', description: 'Le Gardeur, QC', smsAvailable: true, smsEnabled: true, mmsAvailable: true, callback: null },
      { did: '5143604702', description: null, smsAvailable: false, smsEnabled: false, mmsAvailable: false, callback: null },
      {
        did: '4385550100',
        description: null,
        smsAvailable: false,
        smsEnabled: true,
        mmsAvailable: false,
        callback: { url: 'https://hook.example/sms?to={TO}', retry: true },
      },
    ]);
  });

  it('refuses to set a callback on a number whose SMS is off, rather than turn SMS on', async () => {
    // The fake's second number has SMS off.
    expect(await call('setCallback', '5143604702', null)).toEqual({ error: 'sms_disabled' });
    expect(voipms.calls.map((c) => c.method)).toEqual(['getDIDsInfo']);
    expect(voipms.dids.find((d) => d.did === '5143604702')).toMatchObject({ sms_enabled: '0' });
  });
});
