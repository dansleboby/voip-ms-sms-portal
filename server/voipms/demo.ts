import { DAY_MS, epochToZonedDate, epochToZonedDateTime } from '../time.js';
import { VoipMsError, type DidInfo, type MessageQuery, type RemoteKind, type RemoteMessage, type VoipMsApi } from './client.js';

/**
 * In-memory stand-in for a VoIP.ms account (DEMO_MODE=true): sample numbers,
 * conversations and an auto-reply, so the interface can be tried or
 * developed without credentials and without sending real texts.
 */

const HOUR = 60 * 60 * 1000;
const MIN = 60 * 1000;

const PHOTO = `data:image/svg+xml;base64,${Buffer.from(
  `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="420" viewBox="0 0 640 420">
  <defs>
    <linearGradient id="sky" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#f6b26b"/><stop offset="1" stop-color="#fbe3c0"/></linearGradient>
    <linearGradient id="lake" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#4f7cac"/><stop offset="1" stop-color="#2d4b6e"/></linearGradient>
  </defs>
  <rect width="640" height="420" fill="url(#sky)"/>
  <circle cx="470" cy="150" r="46" fill="#fff4dc"/>
  <path d="M0 260 L120 150 L210 230 L320 120 L450 250 L540 180 L640 250 L640 300 L0 300Z" fill="#5b6f5a"/>
  <path d="M0 280 L90 220 L190 270 L300 200 L420 280 L640 240 L640 310 L0 310Z" fill="#3e523f"/>
  <rect y="300" width="640" height="120" fill="url(#lake)"/>
  <rect x="380" y="330" width="120" height="6" rx="3" fill="#fbe3c0" opacity=".6"/>
  <rect x="410" y="350" width="70" height="5" rx="2.5" fill="#fbe3c0" opacity=".4"/>
</svg>`,
).toString('base64')}`;

interface Seed {
  ago: number;
  did: string;
  contact: string;
  dir: 'in' | 'out';
  body: string;
  media?: string[];
}

const DIDS: DidInfo[] = [
  { did: '5145550100', description: 'Montréal, QC', smsAvailable: true, smsEnabled: true, mmsAvailable: true },
  { did: '4505550199', description: 'Laval, QC', smsAvailable: true, smsEnabled: true, mmsAvailable: true },
  { did: '8195550123', description: 'Gatineau, QC', smsAvailable: true, smsEnabled: false, mmsAvailable: false },
];

/** Contacts created locally in demo mode so names show up. */
export const DEMO_CONTACTS = [
  { name: 'Marie Tremblay', phones: ['4385550142'] },
  { name: 'Alex Martin', phones: ['5145550187'] },
  { name: 'Garage Bélanger', phones: ['4505550111'] },
];

const SEEDS: Seed[] = [
  { ago: 3 * DAY_MS + 2 * HOUR, did: '5145550100', contact: '4385550142', dir: 'in', body: 'Salut! Tu viens toujours au chalet en fin de semaine?' },
  { ago: 3 * DAY_MS + 1 * HOUR, did: '5145550100', contact: '4385550142', dir: 'out', body: 'Oui! On arrive samedi vers 10 h.' },
  { ago: 3 * DAY_MS + 50 * MIN, did: '5145550100', contact: '4385550142', dir: 'in', body: 'Parfait 😊 Apporte tes bottes, il a plu.' },
  { ago: 2 * HOUR, did: '5145550100', contact: '4385550142', dir: 'in', body: 'Regarde la vue ce matin!', media: [PHOTO] },
  { ago: 1 * HOUR + 55 * MIN, did: '5145550100', contact: '4385550142', dir: 'out', body: 'Wow, magnifique 😍' },
  { ago: 26 * HOUR, did: '4505550199', contact: '4505550111', dir: 'in', body: 'Bonjour, votre véhicule est prêt. Vous pouvez passer le récupérer avant 17 h.' },
  { ago: 25 * HOUR, did: '4505550199', contact: '4505550111', dir: 'out', body: 'Merci, je passe vers 16 h 30.' },
  { ago: 5 * DAY_MS, did: '5145550100', contact: '5145550187', dir: 'out', body: 'Hey Alex, are we still on for Thursday?' },
  { ago: 5 * DAY_MS - 20 * MIN, did: '5145550100', contact: '5145550187', dir: 'in', body: 'Yes! 7pm at the usual place.' },
  { ago: 12 * MIN, did: '5145550100', contact: '5145550187', dir: 'in', body: "Running 10 min late, sorry!" },
  { ago: 40 * MIN, did: '4505550199', contact: '32665', dir: 'in', body: 'Votre code de vérification est 482913. Ne le partagez avec personne.' },
];

interface Stored extends RemoteMessage {
  at: number;
}

export class DemoVoipMs implements VoipMsApi {
  private readonly messages: Stored[] = [];
  private nextId = { sms: 900000, mms: 50000 };

  constructor(private readonly timeZone: string) {
    const now = Date.now();
    for (const s of SEEDS) this.add(s.media ? 'mms' : 'sms', s.did, s.contact, s.dir, s.body, s.media ?? [], now - s.ago);
  }

  private add(kind: RemoteKind, did: string, contact: string, direction: 'in' | 'out', body: string, media: string[], at: number): string {
    const id = String(this.nextId[kind]++);
    this.messages.push({
      kind,
      id,
      date: epochToZonedDateTime(at, this.timeZone),
      direction,
      did,
      contact,
      body,
      carrierStatus: direction === 'out' ? 'Delivered' : null,
      media,
      at,
    });
    return id;
  }

  async getIP(): Promise<string> {
    return '203.0.113.10';
  }

  async getBalance(): Promise<number> {
    return 42.5;
  }

  async getDids(): Promise<DidInfo[]> {
    return DIDS;
  }

  async getMessages(kind: RemoteKind, query: MessageQuery): Promise<RemoteMessage[]> {
    return this.messages
      .filter((m) => m.kind === kind)
      .filter((m) => {
        const date = epochToZonedDate(m.at, this.timeZone);
        return date >= query.from && date <= query.to;
      })
      .filter((m) => !query.did || m.did === query.did)
      .slice(-query.limit)
      .map(({ at: _at, ...m }) => m);
  }

  private check(did: string): void {
    const info = DIDS.find((d) => d.did === did);
    if (!info?.smsEnabled) throw new VoipMsError('invalid_did');
  }

  async sendSms(did: string, dst: string, message: string): Promise<string> {
    this.check(did);
    if (Buffer.byteLength(message, 'utf8') > 160) throw new VoipMsError('sms_toolong');
    const id = this.add('sms', did, dst, 'out', message, [], Date.now());
    this.autoReply(did, dst);
    return id;
  }

  async sendMms(did: string, dst: string, message: string, media: string[]): Promise<string> {
    this.check(did);
    const id = this.add('mms', did, dst, 'out', message, media, Date.now());
    this.autoReply(did, dst);
    return id;
  }

  private autoReply(did: string, contact: string): void {
    setTimeout(() => {
      this.add('sms', did, contact, 'in', 'Bien reçu 👍 (réponse automatique de la démo)', [], Date.now());
    }, 4000).unref();
  }
}
