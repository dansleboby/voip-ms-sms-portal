import http from 'node:http';
import type net from 'node:net';

/** The wall-clock time VoIP.ms writes its dates in ("2026-10-02 14:24:20"), in `timeZone`. */
function epochToZonedDateTime(epochMs: number, timeZone: string): string {
  const parts: Record<string, string> = {};
  const format = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  for (const p of format.formatToParts(new Date(epochMs))) parts[p.type] = p.value;
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second}`;
}

/**
 * A stand-in for the VoIP.ms REST API over HTTP, answering the way the live
 * API does (multipart bodies, "no_sms" for no results, dates in Eastern
 * time), for the server's REST client, which demo mode skips.
 */

interface Row {
  id: string;
  kind: 'sms' | 'mms';
  date: string;
  type: '0' | '1';
  did: string;
  contact: string;
  message: string;
  col_media1?: string;
  carrier_status?: string;
}

export interface Call {
  method: string;
  fields: Record<string, string>;
}

export class FakeVoipMsServer {
  readonly calls: Call[] = [];
  /**
   * Method -> VoIP.ms status to fail it with once, "http_522" for a Cloudflare
   * error page, or "not_json" for a body that is not JSON.
   */
  readonly failNext: Record<string, string> = {};
  /** Files served under /media/, for MMS links. */
  readonly files = new Map<string, { type: string; data: Buffer }>();
  /** The account's numbers, as getDIDsInfo reports them; setSMS changes them. */
  readonly dids: Record<string, string | number>[] = [
    { did: '4506575294', description: 'Le Gardeur, QC', sms_available: '1', sms_enabled: 1, mms_available: '1' },
    {
      did: '5143604702',
      description: '',
      sms_available: 1,
      sms_enabled: '0',
      mms_available: 0,
      sms_email: 'me@example.com',
      sms_email_enabled: '1',
      sms_forward: '',
      sms_forward_enabled: '0',
      sms_url_callback: 'https://hook.example/sms?from={FROM}',
      sms_url_callback_enabled: '1',
      sms_url_callback_retry: '1',
    },
  ];
  private readonly rows: Row[] = [];
  private nextId = { sms: 1000, mms: 5000 };
  private server: http.Server | null = null;
  url = '';

  async start(): Promise<void> {
    this.server = http.createServer((req, res) => void this.handle(req, res));
    await new Promise<void>((resolve) => this.server!.listen(0, '127.0.0.1', resolve));
    this.url = `http://127.0.0.1:${(this.server.address() as net.AddressInfo).port}`;
  }

  async stop(): Promise<void> {
    this.server?.closeAllConnections();
    await new Promise((resolve) => this.server?.close(resolve));
  }

  /** A message in the account's history; `at` defaults to now. */
  push(row: { kind?: 'sms' | 'mms'; direction: 'in' | 'out'; did?: string; contact: string; message: string; at?: number; media?: string }): string {
    const kind = row.kind ?? (row.media ? 'mms' : 'sms');
    const id = String(this.nextId[kind]++);
    this.rows.push({
      id,
      kind,
      date: epochToZonedDateTime(row.at ?? Date.now(), 'America/New_York'),
      type: row.direction === 'in' ? '1' : '0',
      did: row.did ?? '4506575294',
      contact: row.contact,
      message: row.message,
      ...(row.media ? { col_media1: row.media } : {}),
      ...(row.direction === 'out' ? { carrier_status: 'Delivered' } : {}),
    });
    return id;
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    if (req.method === 'GET' && req.url?.startsWith('/media/')) {
      const file = this.files.get(req.url.slice('/media/'.length));
      res.writeHead(file ? 200 : 404, file ? { 'content-type': file.type } : {});
      res.end(file?.data ?? 'not found');
      return;
    }
    let fields: Record<string, string> = {};
    try {
      const form = await new Response(Buffer.concat(chunks), { headers: { 'content-type': req.headers['content-type'] ?? '' } }).formData();
      fields = Object.fromEntries([...form.entries()].map(([k, v]) => [k, String(v)]));
    } catch {
      // Not multipart: the live API answers with a SOAP fault, of sorts.
      res.writeHead(200, { 'content-type': 'text/xml' }).end('<SOAP-ENV:Fault/>');
      return;
    }
    const method = fields.method ?? '';
    this.calls.push({ method, fields });
    const json = (body: object) => res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(body));
    const failure = this.failNext[method];
    if (failure) {
      delete this.failNext[method];
      if (failure === 'http_522') {
        res.writeHead(522).end('error code: 522');
        // Cloudflare can time out after VoIP.ms did the work.
        if (method === 'sendSMS') this.push({ direction: 'out', did: fields.did, contact: fields.dst!, message: fields.message! });
        return;
      }
      if (failure === 'not_json') {
        res.writeHead(200, { 'content-type': 'text/xml' }).end('<soap:Fault/>');
        return;
      }
      json({ status: failure });
      return;
    }
    if (fields.api_username !== 'me@example.com' || fields.api_password !== 'api-secret') {
      json({ status: 'invalid_credentials' });
      return;
    }
    switch (method) {
      case 'getIP':
        return json({ status: 'success', ip: '198.51.100.7' });
      case 'getBalance':
        return json({ status: 'success', balance: { current_balance: '24.1175' } });
      case 'getDIDsInfo': {
        const dids = this.dids.filter((d) => !fields.did || d.did === fields.did);
        return json(dids.length ? { status: 'success', dids } : { status: 'invalid_did' });
      }
      case 'setSMS': {
        const did = this.dids.find((d) => d.did === fields.did);
        if (!did) return json({ status: 'invalid_did' });
        if (!fields.enable) return json({ status: 'missing_enable' });
        // Settings left out are reset: the safe guess about the live API.
        Object.assign(did, {
          sms_enabled: fields.enable,
          sms_email: fields.email_address ?? '',
          sms_email_enabled: fields.email_enabled ?? '0',
          sms_forward: fields.sms_forward ?? '',
          sms_forward_enabled: fields.sms_forward_enable ?? '0',
          sms_url_callback: fields.url_callback ?? '',
          sms_url_callback_enabled: fields.url_callback_enable ?? '0',
          sms_url_callback_retry: fields.url_callback_retry ?? '0',
        });
        return json({ status: 'success' });
      }
      case 'getSMS':
      case 'getMMS': {
        const kind = method === 'getSMS' ? 'sms' : 'mms';
        const rows = this.rows.filter((r) => r.kind === kind && r.date.slice(0, 10) >= fields.from! && r.date.slice(0, 10) <= fields.to!);
        // Newest first, like the live API.
        return json(rows.length ? { status: 'success', sms: rows.reverse().map(({ kind: _kind, ...r }) => r) } : { status: 'no_sms' });
      }
      case 'deleteSMS':
      case 'deleteMMS': {
        const kind = method === 'deleteSMS' ? 'sms' : 'mms';
        const index = this.rows.findIndex((r) => r.kind === kind && r.id === fields.id);
        if (index < 0) return json({ status: kind === 'sms' ? 'invalid_sms' : 'invalid_mms' });
        this.rows.splice(index, 1);
        return json({ status: 'success' });
      }
      case 'sendSMS':
        return json({ status: 'success', sms: Number(this.push({ direction: 'out', did: fields.did, contact: fields.dst!, message: fields.message! })) });
      case 'sendMMS':
        return json({ status: 'success', mms: Number(this.push({ kind: 'mms', direction: 'out', did: fields.did, contact: fields.dst!, message: fields.message! })) });
      default:
        return json({ status: 'invalid_method' });
    }
  }
}
