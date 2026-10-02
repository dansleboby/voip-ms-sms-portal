import { describe, expect, it } from 'vitest';
import { parseMessage, VOIPMS_API_URL, VoipMsClient, VoipMsError } from './client.js';

function fakeFetch(responses: (Response | (() => Response))[]) {
  const calls: { url: string; body: FormData }[] = [];
  const impl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), body: init?.body as FormData });
    const next = responses.shift();
    if (!next) throw new Error('No more responses');
    return typeof next === 'function' ? next() : next;
  }) as typeof fetch;
  return { impl, calls };
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const creds = { username: 'me@example.com', password: 'secret' };

describe('VoipMsClient', () => {
  it('posts multipart form data with credentials and method', async () => {
    const { impl, calls } = fakeFetch([json({ status: 'success', sms: 112275629 })]);
    const client = new VoipMsClient(creds, { fetch: impl, minIntervalMs: 0 });
    expect(await client.sendSms('4506575294', '4383980707', 'Allô é')).toBe('112275629');
    expect(calls[0]!.url).toBe(VOIPMS_API_URL);
    const form = calls[0]!.body;
    expect(form).toBeInstanceOf(FormData);
    expect(form.get('api_username')).toBe('me@example.com');
    expect(form.get('api_password')).toBe('secret');
    expect(form.get('method')).toBe('sendSMS');
    expect(form.get('content_type')).toBe('json');
    expect(form.get('message')).toBe('Allô é');
  });

  it('turns error statuses into VoipMsError', async () => {
    const { impl } = fakeFetch([json({ status: 'ip_not_enabled', message: 'This IP is not enabled for API use' })]);
    const client = new VoipMsClient(creds, { fetch: impl, minIntervalMs: 0 });
    await expect(client.getBalance()).rejects.toMatchObject({ code: 'ip_not_enabled' });
  });

  it('reports Cloudflare errors (seen live: "error code: 522") as http_error', async () => {
    const { impl } = fakeFetch([new Response('error code: 522', { status: 522 })]);
    const client = new VoipMsClient(creds, { fetch: impl, minIntervalMs: 0 });
    await expect(client.getIP()).rejects.toMatchObject({ code: 'http_error' });
  });

  it('reports non-JSON bodies', async () => {
    const { impl } = fakeFetch([new Response('<soap:Fault/>', { status: 200 })]);
    const client = new VoipMsClient(creds, { fetch: impl, minIntervalMs: 0 });
    await expect(client.getIP()).rejects.toBeInstanceOf(VoipMsError);
  });

  it('treats no_sms as an empty result and asks for one kind at a time', async () => {
    const { impl, calls } = fakeFetch([json({ status: 'no_sms', message: 'There are no SMS messages' })]);
    const client = new VoipMsClient(creds, { fetch: impl, minIntervalMs: 0 });
    expect(await client.getMessages('mms', { from: '2026-10-01', to: '2026-10-02', limit: 100 })).toEqual([]);
    expect(calls[0]!.body.get('method')).toBe('getMMS');
    expect(calls[0]!.body.get('all_messages')).toBe('0');
    expect(calls[0]!.body.get('timezone')).toBeNull();
  });

  it('passes up to three media to sendMMS', async () => {
    const { impl, calls } = fakeFetch([json({ status: 'success', mms: 10456720 })]);
    const client = new VoipMsClient(creds, { fetch: impl, minIntervalMs: 0 });
    await client.sendMms('4506575294', '4383980707', '', ['data:a', 'data:b', 'data:c', 'data:d']);
    const form = calls[0]!.body;
    expect(form.get('media1')).toBe('data:a');
    expect(form.get('media3')).toBe('data:c');
    expect(form.get('media4')).toBeNull();
  });

  it('parses DIDs with mixed string/number flags', async () => {
    const { impl } = fakeFetch([
      json({ status: 'success', dids: [{ did: '4506575294', description: 'Le Gardeur, QC', sms_available: 1, sms_enabled: '1', mms_available: 1 }] }),
    ]);
    const client = new VoipMsClient(creds, { fetch: impl, minIntervalMs: 0 });
    expect(await client.getDids()).toEqual([
      { did: '4506575294', description: 'Le Gardeur, QC', smsAvailable: true, smsEnabled: true, mmsAvailable: true },
    ]);
  });

  it('runs calls one after the other', async () => {
    let active = 0;
    let maxActive = 0;
    const impl = (async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, 5));
      active--;
      return json({ status: 'success', ip: '1.2.3.4' });
    }) as unknown as typeof fetch;
    const client = new VoipMsClient(creds, { fetch: impl, minIntervalMs: 0 });
    await Promise.all([client.getIP(), client.getIP(), client.getIP()]);
    expect(maxActive).toBe(1);
  });
});

describe('parseMessage', () => {
  it('reads a getMMS row (shape observed on the live API)', () => {
    const m = parseMessage('mms', {
      id: '10456720',
      date: '2026-10-02 14:24:31',
      type: '0',
      did: '4506575294',
      contact: '4383980707',
      carrier_status: 'Information not available',
      message: 'MMS avec image',
      col_media1: 'https://voip.ms/media/abc/media.png',
      col_media2: '',
      col_media3: '',
      media: ['https://voip.ms/media/abc/media.png'],
    });
    expect(m).toMatchObject({ kind: 'mms', id: '10456720', direction: 'out', media: ['https://voip.ms/media/abc/media.png'] });
  });

  it('makes relative media paths absolute and maps type 1 to incoming', () => {
    const m = parseMessage('mms', { id: '1', type: '1', media: ['media/xyz/media.jpg'], col_media1: 'media/xyz/media.jpg' });
    expect(m.direction).toBe('in');
    expect(m.media).toEqual(['https://voip.ms/media/xyz/media.jpg']);
  });
});
