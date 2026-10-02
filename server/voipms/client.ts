/**
 * Minimal VoIP.ms REST client covering what the SMS portal needs.
 *
 * Findings from the live API that shape this file:
 * - POST bodies must be multipart/form-data; urlencoded bodies get a SOAP fault.
 * - Every call except getIP is refused unless the caller's IP is whitelisted.
 * - getSMS / getMMS with all_messages=1 mix SMS and MMS without saying which is
 *   which, and the two have separate id sequences, so each kind is fetched with
 *   its own call and all_messages=0.
 * - "No results" comes back as an error status (no_sms, no_did).
 */

import { unescapeQuotes } from './text.js';

export const VOIPMS_API_URL = 'https://voip.ms/api/v1/rest.php';

export class VoipMsError extends Error {
  constructor(
    readonly code: string,
    message?: string,
  ) {
    super(message ?? code);
    this.name = 'VoipMsError';
  }
}

export interface VoipMsCredentials {
  username: string;
  password: string;
}

export interface DidInfo {
  did: string;
  description: string | null;
  smsAvailable: boolean;
  smsEnabled: boolean;
  mmsAvailable: boolean;
}

export type RemoteKind = 'sms' | 'mms';

export interface RemoteMessage {
  kind: RemoteKind;
  id: string;
  /** Wall-clock date in VoIP.ms's time zone ("YYYY-MM-DD HH:mm:ss"). */
  date: string;
  direction: 'in' | 'out';
  did: string;
  contact: string;
  body: string;
  carrierStatus: string | null;
  /** Absolute media URLs (MMS only). */
  media: string[];
}

export interface MessageQuery {
  /** First calendar date, inclusive (VoIP.ms time zone). */
  from: string;
  /** Last calendar date, inclusive. The span may not exceed 92 days. */
  to: string;
  limit: number;
  did?: string;
  contact?: string;
}

/** Everything the rest of the server needs from VoIP.ms; also implemented by the demo client. */
export interface VoipMsApi {
  getIP(): Promise<string>;
  getBalance(): Promise<number>;
  getDids(): Promise<DidInfo[]>;
  getMessages(kind: RemoteKind, query: MessageQuery): Promise<RemoteMessage[]>;
  sendSms(did: string, dst: string, message: string): Promise<string>;
  /** `media` holds data URIs ("data:image/png;base64,...") or public URLs, at most 3. */
  sendMms(did: string, dst: string, message: string, media: string[]): Promise<string>;
}

type Params = Record<string, string | number | undefined>;
type Json = Record<string, unknown>;

export interface VoipMsClientOptions {
  fetch?: typeof fetch;
  /** Minimum spacing between two calls, to stay clear of the per-minute API limit. */
  minIntervalMs?: number;
  timeoutMs?: number;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function flag(value: unknown): boolean {
  return value === 1 || value === '1' || value === true;
}

function str(value: unknown): string {
  return value === undefined || value === null ? '' : String(value);
}

export class VoipMsClient implements VoipMsApi {
  private readonly fetchImpl: typeof fetch;
  private readonly minIntervalMs: number;
  private readonly timeoutMs: number;
  private chain: Promise<unknown> = Promise.resolve();
  private lastCallAt = 0;

  constructor(
    private readonly credentials: VoipMsCredentials,
    options: VoipMsClientOptions = {},
  ) {
    this.fetchImpl = options.fetch ?? fetch;
    this.minIntervalMs = options.minIntervalMs ?? 250;
    this.timeoutMs = options.timeoutMs ?? 60_000;
  }

  /** Calls run one at a time, in order. */
  call(method: string, params: Params = {}): Promise<Json> {
    const result = this.chain.then(() => this.execute(method, params));
    this.chain = result.catch(() => undefined);
    return result;
  }

  private async execute(method: string, params: Params): Promise<Json> {
    const wait = this.lastCallAt + this.minIntervalMs - Date.now();
    if (wait > 0) await sleep(wait);
    this.lastCallAt = Date.now();

    const form = new FormData();
    form.set('api_username', this.credentials.username);
    form.set('api_password', this.credentials.password);
    form.set('method', method);
    form.set('content_type', 'json');
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined) form.set(key, String(value));
    }

    let res: Response;
    try {
      res = await this.fetchImpl(VOIPMS_API_URL, {
        method: 'POST',
        body: form,
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      throw new VoipMsError('network_error', err instanceof Error ? err.message : String(err));
    }
    const text = await res.text();
    if (!res.ok) throw new VoipMsError('http_error', `HTTP ${res.status}`);
    let data: Json;
    try {
      data = JSON.parse(text) as Json;
    } catch {
      throw new VoipMsError('invalid_response', text.slice(0, 200));
    }
    if (data.status !== 'success') {
      throw new VoipMsError(str(data.status) || 'unknown_error', typeof data.message === 'string' ? data.message : undefined);
    }
    return data;
  }

  async getIP(): Promise<string> {
    const data = await this.call('getIP');
    return str(data.ip);
  }

  async getBalance(): Promise<number> {
    const data = await this.call('getBalance');
    const balance = data.balance as Json | undefined;
    return Number(balance?.current_balance ?? NaN);
  }

  async getDids(): Promise<DidInfo[]> {
    let data: Json;
    try {
      data = await this.call('getDIDsInfo');
    } catch (err) {
      if (err instanceof VoipMsError && err.code === 'no_did') return [];
      throw err;
    }
    const dids = Array.isArray(data.dids) ? (data.dids as Json[]) : [];
    return dids.map((d) => ({
      did: str(d.did),
      description: str(d.description) || null,
      smsAvailable: flag(d.sms_available),
      smsEnabled: flag(d.sms_enabled),
      mmsAvailable: flag(d.mms_available),
    }));
  }

  async getMessages(kind: RemoteKind, query: MessageQuery): Promise<RemoteMessage[]> {
    let data: Json;
    try {
      data = await this.call(kind === 'sms' ? 'getSMS' : 'getMMS', {
        from: query.from,
        to: query.to,
        limit: query.limit,
        did: query.did,
        contact: query.contact,
        all_messages: 0,
      });
    } catch (err) {
      if (err instanceof VoipMsError && err.code === 'no_sms') return [];
      throw err;
    }
    const rows = Array.isArray(data.sms) ? (data.sms as Json[]) : [];
    return rows.map((row) => parseMessage(kind, row));
  }

  async sendSms(did: string, dst: string, message: string): Promise<string> {
    const data = await this.call('sendSMS', { did, dst, message });
    return str(data.sms);
  }

  async sendMms(did: string, dst: string, message: string, media: string[]): Promise<string> {
    const params: Params = { did, dst, message };
    media.slice(0, 3).forEach((m, i) => {
      params[`media${i + 1}`] = m;
    });
    const data = await this.call('sendMMS', params);
    return str(data.mms);
  }
}

function absoluteMediaUrl(url: string): string {
  if (/^https?:\/\//i.test(url)) return url;
  return `https://voip.ms/${url.replace(/^\/+/, '')}`;
}

export function parseMessage(kind: RemoteKind, row: Json): RemoteMessage {
  const media = new Set<string>();
  if (Array.isArray(row.media)) {
    for (const m of row.media) if (typeof m === 'string' && m.trim()) media.add(absoluteMediaUrl(m.trim()));
  }
  for (const key of ['col_media1', 'col_media2', 'col_media3']) {
    const m = str(row[key]).trim();
    if (m) media.add(absoluteMediaUrl(m));
  }
  const carrier = str(row.carrier_status).trim();
  return {
    kind,
    id: str(row.id),
    date: str(row.date),
    // VoIP.ms: type 1 = received, 0 = sent.
    direction: str(row.type) === '1' ? 'in' : 'out',
    did: str(row.did),
    contact: str(row.contact),
    body: unescapeQuotes(str(row.message)),
    carrierStatus: carrier || null,
    media: [...media],
  };
}
