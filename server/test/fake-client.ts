import { epochToZonedDateTime } from '../time.js';
import { VoipMsError, type DidInfo, type MessageQuery, type RemoteKind, type RemoteMessage, type SmsCallback, type VoipMsApi } from '../voipms/client.js';

/** Scriptable VoIP.ms double for tests. */
export class FakeVoipMs implements VoipMsApi {
  dids: DidInfo[] = [
    { did: '4506575294', description: 'Le Gardeur, QC', smsAvailable: true, smsEnabled: true, mmsAvailable: true, callback: null },
    { did: '5143604702', description: 'Montréal, QC', smsAvailable: true, smsEnabled: true, mmsAvailable: true, callback: null },
  ];
  messages: RemoteMessage[] = [];
  sent: { kind: RemoteKind; did: string; dst: string; message: string; media: string[] }[] = [];
  queries: { kind: RemoteKind; query: MessageQuery }[] = [];
  ip = '198.51.100.7';
  /** Date given to pushed messages without one; defaults to the current Eastern time. */
  defaultDate: string | null = null;
  /** Next error to throw from the matching call. */
  failNext: Partial<Record<'getIP' | 'getBalance' | 'getMessages' | 'sendSms' | 'sendMms' | 'deleteMessage' | 'setCallback', string>> = {};
  deleted: { kind: RemoteKind; id: string }[] = [];
  private nextId = { sms: 1000, mms: 500 };

  private maybeFail(method: keyof FakeVoipMs['failNext']): void {
    const code = this.failNext[method];
    if (code) {
      delete this.failNext[method];
      throw new VoipMsError(code);
    }
  }

  push(m: Partial<RemoteMessage> & Pick<RemoteMessage, 'direction' | 'body'>): RemoteMessage {
    const kind = m.kind ?? (m.media?.length ? 'mms' : 'sms');
    const message: RemoteMessage = {
      kind,
      id: m.id ?? String(this.nextId[kind]++),
      date: m.date ?? this.defaultDate ?? epochToZonedDateTime(Date.now(), 'America/New_York'),
      did: m.did ?? '4506575294',
      contact: m.contact ?? '4383980707',
      carrierStatus: m.carrierStatus ?? null,
      media: m.media ?? [],
      ...m,
    };
    this.messages.push(message);
    return message;
  }

  async getIP(): Promise<string> {
    this.maybeFail('getIP');
    return this.ip;
  }

  async getBalance(): Promise<number> {
    this.maybeFail('getBalance');
    return 24.1175;
  }

  async getDids(): Promise<DidInfo[]> {
    return this.dids;
  }

  async deleteMessage(kind: RemoteKind, id: string): Promise<void> {
    this.maybeFail('deleteMessage');
    this.messages = this.messages.filter((m) => !(m.kind === kind && m.id === id));
    this.deleted.push({ kind, id });
  }

  async enableSms(did: string, callback?: SmsCallback): Promise<void> {
    const info = this.dids.find((d) => d.did === did);
    if (!info?.smsAvailable) throw new VoipMsError('invalid_did');
    info.smsEnabled = true;
    if (callback !== undefined) info.callback = callback;
  }

  async setCallback(did: string, callback: SmsCallback | null): Promise<void> {
    this.maybeFail('setCallback');
    const info = this.dids.find((d) => d.did === did);
    if (!info?.smsEnabled) throw new VoipMsError('sms_disabled');
    info.callback = callback;
  }

  async getMessages(kind: RemoteKind, query: MessageQuery): Promise<RemoteMessage[]> {
    this.maybeFail('getMessages');
    this.queries.push({ kind, query });
    return this.messages.filter((m) => m.kind === kind && m.date.slice(0, 10) >= query.from && m.date.slice(0, 10) <= query.to);
  }

  async sendSms(did: string, dst: string, message: string): Promise<string> {
    this.maybeFail('sendSms');
    if (Buffer.byteLength(message) > 160) throw new VoipMsError('sms_toolong');
    this.sent.push({ kind: 'sms', did, dst, message, media: [] });
    return String(this.nextId.sms++);
  }

  async sendMms(did: string, dst: string, message: string, media: string[]): Promise<string> {
    this.maybeFail('sendMms');
    this.sent.push({ kind: 'mms', did, dst, message, media });
    return String(this.nextId.mms++);
  }
}
