import Database from 'better-sqlite3';
import type {
  AttachmentDto,
  AttachmentStatus,
  ContactDto,
  ConversationDto,
  DidDto,
  Direction,
  MessageDto,
  MessageStatus,
} from '../shared/types.js';
import type { MessageKind } from '../shared/message.js';

export type DB = Database.Database;

/** Applied in order; the index + 1 is stored in PRAGMA user_version. */
const MIGRATIONS: string[] = [
  `
  CREATE TABLE settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE dids (
    did           TEXT PRIMARY KEY,
    label         TEXT,
    color         TEXT NOT NULL,
    visible       INTEGER NOT NULL DEFAULT 1,
    sms_enabled   INTEGER NOT NULL DEFAULT 1,
    mms_available INTEGER NOT NULL DEFAULT 1,
    description   TEXT,
    position      INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE contacts (
    id         INTEGER PRIMARY KEY,
    name       TEXT NOT NULL,
    notes      TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE contact_phones (
    phone      TEXT PRIMARY KEY,
    contact_id INTEGER NOT NULL REFERENCES contacts(id) ON DELETE CASCADE
  );
  CREATE INDEX contact_phones_contact ON contact_phones(contact_id);

  -- A conversation is a (your number, their number) pair: replies must leave
  -- from the DID the conversation belongs to.
  CREATE TABLE conversations (
    id              INTEGER PRIMARY KEY,
    did             TEXT NOT NULL,
    phone           TEXT NOT NULL,
    last_message_id INTEGER,
    last_message_at INTEGER,
    unread_count    INTEGER NOT NULL DEFAULT 0,
    UNIQUE (did, phone)
  );
  CREATE INDEX conversations_recent ON conversations(last_message_at DESC);

  CREATE TABLE messages (
    id              INTEGER PRIMARY KEY,
    conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    kind            TEXT NOT NULL CHECK (kind IN ('sms', 'mms')),
    -- VoIP.ms id; SMS and MMS have separate sequences, hence (kind, remote_id).
    remote_id       TEXT,
    direction       TEXT NOT NULL CHECK (direction IN ('in', 'out')),
    body            TEXT NOT NULL DEFAULT '',
    sent_at         INTEGER NOT NULL,
    status          TEXT NOT NULL,
    error           TEXT,
    carrier_status  TEXT,
    created_at      INTEGER NOT NULL,
    UNIQUE (kind, remote_id)
  );
  CREATE INDEX messages_conversation ON messages(conversation_id, sent_at, id);

  CREATE TABLE attachments (
    id         INTEGER PRIMARY KEY,
    message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    position   INTEGER NOT NULL,
    remote_url TEXT,
    file_name  TEXT,
    mime       TEXT,
    size       INTEGER,
    status     TEXT NOT NULL,
    attempts   INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX attachments_message ON attachments(message_id);
  CREATE INDEX attachments_pending ON attachments(status) WHERE status = 'pending';
  `,
];

export function openDatabase(file: string): DB {
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  migrate(db);
  return db;
}

function migrate(db: DB): void {
  const current = db.pragma('user_version', { simple: true }) as number;
  for (let i = current; i < MIGRATIONS.length; i++) {
    db.transaction(() => {
      db.exec(MIGRATIONS[i]!);
      db.pragma(`user_version = ${i + 1}`);
    })();
  }
}

/** Distinct colors that read well on light and dark surfaces. */
export const DID_COLORS = ['#1a73e8', '#e8710a', '#188038', '#a142f4', '#d93025', '#007b83', '#c5221f', '#9334e6'];

interface DidRow {
  did: string;
  label: string | null;
  color: string;
  visible: number;
  sms_enabled: number;
  mms_available: number;
  description: string | null;
  position: number;
  unread: number | null;
}

interface ConversationRow {
  id: number;
  did: string;
  phone: string;
  last_message_id: number | null;
  last_message_at: number | null;
  unread_count: number;
  last_body: string | null;
  last_direction: Direction | null;
  last_status: MessageStatus | null;
  last_attachments: number | null;
  contact_id: number | null;
  contact_name: string | null;
}

interface MessageRow {
  id: number;
  conversation_id: number;
  kind: MessageKind;
  remote_id: string | null;
  direction: Direction;
  body: string;
  sent_at: number;
  status: MessageStatus;
  error: string | null;
  carrier_status: string | null;
  created_at: number;
}

export interface AttachmentRow {
  id: number;
  message_id: number;
  position: number;
  remote_url: string | null;
  file_name: string | null;
  mime: string | null;
  size: number | null;
  status: AttachmentStatus;
  attempts: number;
}

export interface NewMessage {
  conversationId: number;
  kind: MessageKind;
  remoteId: string | null;
  direction: Direction;
  body: string;
  sentAt: number;
  status: MessageStatus;
  carrierStatus?: string | null;
}

export interface NewAttachment {
  remoteUrl?: string | null;
  fileName?: string | null;
  mime?: string | null;
  size?: number | null;
  status: AttachmentStatus;
}

function escapeLike(text: string): string {
  return text.replace(/[\\%_]/g, (c) => `\\${c}`);
}

const CONVERSATION_SELECT = `
  SELECT c.id, c.did, c.phone, c.last_message_id, c.last_message_at, c.unread_count,
         m.body AS last_body, m.direction AS last_direction, m.status AS last_status,
         (SELECT COUNT(*) FROM attachments a WHERE a.message_id = m.id) AS last_attachments,
         ct.id AS contact_id, ct.name AS contact_name
  FROM conversations c
  LEFT JOIN messages m ON m.id = c.last_message_id
  LEFT JOIN contact_phones cp ON cp.phone = c.phone
  LEFT JOIN contacts ct ON ct.id = cp.contact_id
`;

export class Repo {
  constructor(readonly db: DB) {}

  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }

  // ---------------------------------------------------------------- settings

  getSetting(key: string): string | null {
    const row = this.db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined;
    return row?.value ?? null;
  }

  setSetting(key: string, value: string): void {
    this.db
      .prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run(key, value);
  }

  deleteSetting(key: string): void {
    this.db.prepare('DELETE FROM settings WHERE key = ?').run(key);
  }

  // -------------------------------------------------------------------- dids

  listDids(): DidDto[] {
    const rows = this.db
      .prepare(
        `SELECT d.*, (SELECT SUM(unread_count) FROM conversations c WHERE c.did = d.did) AS unread
         FROM dids d ORDER BY d.position, d.did`,
      )
      .all() as DidRow[];
    return rows.map((r) => ({
      did: r.did,
      label: r.label,
      color: r.color,
      visible: r.visible === 1,
      smsEnabled: r.sms_enabled === 1,
      mmsAvailable: r.mms_available === 1,
      description: r.description,
      position: r.position,
      unreadCount: r.unread ?? 0,
    }));
  }

  getDid(did: string): DidDto | null {
    return this.listDids().find((d) => d.did === did) ?? null;
  }

  private nextDidColor(): string {
    const used = (this.db.prepare('SELECT color FROM dids').all() as { color: string }[]).map((r) => r.color);
    return DID_COLORS.find((c) => !used.includes(c)) ?? DID_COLORS[used.length % DID_COLORS.length]!;
  }

  /** Inserts or refreshes a DID from VoIP.ms, keeping the user's label, color and visibility. */
  upsertDid(info: { did: string; description: string | null; smsEnabled: boolean; mmsAvailable: boolean }): void {
    const existing = this.db.prepare('SELECT did FROM dids WHERE did = ?').get(info.did);
    if (existing) {
      this.db
        .prepare('UPDATE dids SET description = ?, sms_enabled = ?, mms_available = ? WHERE did = ?')
        .run(info.description, info.smsEnabled ? 1 : 0, info.mmsAvailable ? 1 : 0, info.did);
      return;
    }
    const position = (this.db.prepare('SELECT COUNT(*) AS n FROM dids').get() as { n: number }).n;
    this.db
      .prepare(
        `INSERT INTO dids (did, label, color, visible, sms_enabled, mms_available, description, position)
         VALUES (?, NULL, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        info.did,
        this.nextDidColor(),
        info.smsEnabled ? 1 : 0,
        info.smsEnabled ? 1 : 0,
        info.mmsAvailable ? 1 : 0,
        info.description,
        position,
      );
  }

  /** Makes sure a DID seen in message history exists locally. */
  ensureDid(did: string): void {
    if (this.db.prepare('SELECT did FROM dids WHERE did = ?').get(did)) return;
    this.upsertDid({ did, description: null, smsEnabled: true, mmsAvailable: true });
  }

  updateDid(did: string, patch: { label?: string | null; color?: string; visible?: boolean; position?: number }): boolean {
    const sets: string[] = [];
    const values: unknown[] = [];
    if (patch.label !== undefined) {
      sets.push('label = ?');
      values.push(patch.label?.trim() ? patch.label.trim() : null);
    }
    if (patch.color !== undefined) {
      sets.push('color = ?');
      values.push(patch.color);
    }
    if (patch.visible !== undefined) {
      sets.push('visible = ?');
      values.push(patch.visible ? 1 : 0);
    }
    if (patch.position !== undefined) {
      sets.push('position = ?');
      values.push(patch.position);
    }
    if (sets.length === 0) return this.getDid(did) !== null;
    const res = this.db.prepare(`UPDATE dids SET ${sets.join(', ')} WHERE did = ?`).run(...values, did);
    return res.changes > 0;
  }

  // ----------------------------------------------------------- conversations

  getOrCreateConversation(did: string, phone: string): number {
    const row = this.db.prepare('SELECT id FROM conversations WHERE did = ? AND phone = ?').get(did, phone) as
      | { id: number }
      | undefined;
    if (row) return row.id;
    return Number(this.db.prepare('INSERT INTO conversations (did, phone) VALUES (?, ?)').run(did, phone).lastInsertRowid);
  }

  findConversation(did: string, phone: string): number | null {
    const row = this.db.prepare('SELECT id FROM conversations WHERE did = ? AND phone = ?').get(did, phone) as
      | { id: number }
      | undefined;
    return row?.id ?? null;
  }

  getConversation(id: number): ConversationDto | null {
    const row = this.db.prepare(`${CONVERSATION_SELECT} WHERE c.id = ?`).get(id) as ConversationRow | undefined;
    return row ? toConversationDto(row) : null;
  }

  listConversations(opts: { did?: string; query?: string; limit?: number } = {}): ConversationDto[] {
    const where = ['c.last_message_id IS NOT NULL'];
    const params: unknown[] = [];
    if (opts.did) {
      where.push('c.did = ?');
      params.push(opts.did);
    } else {
      where.push('c.did IN (SELECT did FROM dids WHERE visible = 1)');
    }
    const q = opts.query?.trim();
    if (q) {
      const like = `%${escapeLike(q)}%`;
      const digits = q.replace(/\D/g, '');
      const clauses = [
        "ct.name LIKE ? ESCAPE '\\'",
        "EXISTS (SELECT 1 FROM messages mm WHERE mm.conversation_id = c.id AND mm.body LIKE ? ESCAPE '\\')",
      ];
      params.push(like, like);
      if (digits.length >= 3) {
        clauses.push('c.phone LIKE ?');
        params.push(`%${digits}%`);
      }
      where.push(`(${clauses.join(' OR ')})`);
    }
    params.push(opts.limit ?? 500);
    const rows = this.db
      .prepare(`${CONVERSATION_SELECT} WHERE ${where.join(' AND ')} ORDER BY c.last_message_at DESC, c.id DESC LIMIT ?`)
      .all(...params) as ConversationRow[];
    return rows.map(toConversationDto);
  }

  /** Recomputes the conversation's last message and optionally bumps its unread counter. */
  touchConversation(conversationId: number, unreadDelta = 0): void {
    const last = this.db
      .prepare('SELECT id, sent_at FROM messages WHERE conversation_id = ? ORDER BY sent_at DESC, id DESC LIMIT 1')
      .get(conversationId) as { id: number; sent_at: number } | undefined;
    this.db
      .prepare(
        `UPDATE conversations SET last_message_id = ?, last_message_at = ?, unread_count = unread_count + ? WHERE id = ?`,
      )
      .run(last?.id ?? null, last?.sent_at ?? null, unreadDelta, conversationId);
  }

  markConversationRead(id: number): boolean {
    return this.db.prepare('UPDATE conversations SET unread_count = 0 WHERE id = ? AND unread_count > 0').run(id).changes > 0;
  }

  // ---------------------------------------------------------------- messages

  insertMessage(m: NewMessage): number {
    return Number(
      this.db
        .prepare(
          `INSERT INTO messages (conversation_id, kind, remote_id, direction, body, sent_at, status, carrier_status, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(m.conversationId, m.kind, m.remoteId, m.direction, m.body, m.sentAt, m.status, m.carrierStatus ?? null, Date.now())
        .lastInsertRowid,
    );
  }

  findMessageByRemote(kind: MessageKind, remoteId: string): { id: number; carrierStatus: string | null } | null {
    const row = this.db.prepare('SELECT id, carrier_status FROM messages WHERE kind = ? AND remote_id = ?').get(kind, remoteId) as
      | { id: number; carrier_status: string | null }
      | undefined;
    return row ? { id: row.id, carrierStatus: row.carrier_status } : null;
  }

  updateMessage(
    id: number,
    patch: { kind?: MessageKind; remoteId?: string | null; status?: MessageStatus; error?: string | null; carrierStatus?: string | null; sentAt?: number },
  ): void {
    const map: Record<string, string> = {
      kind: 'kind',
      remoteId: 'remote_id',
      status: 'status',
      error: 'error',
      carrierStatus: 'carrier_status',
      sentAt: 'sent_at',
    };
    const sets: string[] = [];
    const values: unknown[] = [];
    for (const [key, column] of Object.entries(map)) {
      const value = (patch as Record<string, unknown>)[key];
      if (value !== undefined) {
        sets.push(`${column} = ?`);
        values.push(value);
      }
    }
    if (sets.length) this.db.prepare(`UPDATE messages SET ${sets.join(', ')} WHERE id = ?`).run(...values, id);
  }

  getMessageRow(id: number): MessageRow | null {
    return (this.db.prepare('SELECT * FROM messages WHERE id = ?').get(id) as MessageRow | undefined) ?? null;
  }

  getMessage(id: number): MessageDto | null {
    const row = this.getMessageRow(id);
    return row ? this.toMessageDto(row, this.attachmentsFor([row.id])) : null;
  }

  /** Newest-last page of a conversation, optionally strictly older than message `beforeId`. */
  listMessages(conversationId: number, opts: { beforeId?: number; limit?: number } = {}): MessageDto[] {
    const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
    let rows: MessageRow[];
    const before = opts.beforeId ? this.getMessageRow(opts.beforeId) : null;
    if (before) {
      rows = this.db
        .prepare(
          `SELECT * FROM messages WHERE conversation_id = ? AND (sent_at < ? OR (sent_at = ? AND id < ?))
           ORDER BY sent_at DESC, id DESC LIMIT ?`,
        )
        .all(conversationId, before.sent_at, before.sent_at, before.id, limit) as MessageRow[];
    } else {
      rows = this.db
        .prepare('SELECT * FROM messages WHERE conversation_id = ? ORDER BY sent_at DESC, id DESC LIMIT ?')
        .all(conversationId, limit) as MessageRow[];
    }
    rows.reverse();
    const attachments = this.attachmentsFor(rows.map((r) => r.id));
    return rows.map((r) => this.toMessageDto(r, attachments));
  }

  private attachmentsFor(messageIds: number[]): Map<number, AttachmentRow[]> {
    const map = new Map<number, AttachmentRow[]>();
    if (messageIds.length === 0) return map;
    const rows = this.db
      .prepare(
        `SELECT * FROM attachments WHERE message_id IN (${messageIds.map(() => '?').join(',')}) ORDER BY message_id, position`,
      )
      .all(...messageIds) as AttachmentRow[];
    for (const r of rows) {
      const list = map.get(r.message_id) ?? [];
      list.push(r);
      map.set(r.message_id, list);
    }
    return map;
  }

  private toMessageDto(row: MessageRow, attachments: Map<number, AttachmentRow[]>): MessageDto {
    return {
      id: row.id,
      conversationId: row.conversation_id,
      kind: row.kind,
      direction: row.direction,
      body: row.body,
      sentAt: row.sent_at,
      status: row.status,
      error: row.error,
      carrierStatus: row.carrier_status,
      attachments: (attachments.get(row.id) ?? []).map(toAttachmentDto),
    };
  }

  // ------------------------------------------------------------- attachments

  insertAttachment(messageId: number, position: number, a: NewAttachment): number {
    return Number(
      this.db
        .prepare(
          `INSERT INTO attachments (message_id, position, remote_url, file_name, mime, size, status)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(messageId, position, a.remoteUrl ?? null, a.fileName ?? null, a.mime ?? null, a.size ?? null, a.status)
        .lastInsertRowid,
    );
  }

  getAttachment(id: number): AttachmentRow | null {
    return (this.db.prepare('SELECT * FROM attachments WHERE id = ?').get(id) as AttachmentRow | undefined) ?? null;
  }

  listAttachments(messageId: number): AttachmentRow[] {
    return this.db.prepare('SELECT * FROM attachments WHERE message_id = ? ORDER BY position').all(messageId) as AttachmentRow[];
  }

  pendingAttachments(maxAttempts: number, afterId = 0, limit = 20): AttachmentRow[] {
    return this.db
      .prepare(`SELECT * FROM attachments WHERE status = 'pending' AND attempts < ? AND id > ? ORDER BY id LIMIT ?`)
      .all(maxAttempts, afterId, limit) as AttachmentRow[];
  }

  updateAttachment(
    id: number,
    patch: { fileName?: string | null; mime?: string | null; size?: number | null; status?: AttachmentStatus; attempts?: number },
  ): void {
    const map: Record<string, string> = { fileName: 'file_name', mime: 'mime', size: 'size', status: 'status', attempts: 'attempts' };
    const sets: string[] = [];
    const values: unknown[] = [];
    for (const [key, column] of Object.entries(map)) {
      const value = (patch as Record<string, unknown>)[key];
      if (value !== undefined) {
        sets.push(`${column} = ?`);
        values.push(value);
      }
    }
    if (sets.length) this.db.prepare(`UPDATE attachments SET ${sets.join(', ')} WHERE id = ?`).run(...values, id);
  }

  // ---------------------------------------------------------------- contacts

  listContacts(): ContactDto[] {
    const contacts = this.db.prepare('SELECT id, name, notes FROM contacts ORDER BY name COLLATE NOCASE').all() as {
      id: number;
      name: string;
      notes: string | null;
    }[];
    const phones = this.db.prepare('SELECT phone, contact_id FROM contact_phones ORDER BY rowid').all() as {
      phone: string;
      contact_id: number;
    }[];
    const byContact = new Map<number, string[]>();
    for (const p of phones) byContact.set(p.contact_id, [...(byContact.get(p.contact_id) ?? []), p.phone]);
    return contacts.map((c) => ({ ...c, phones: byContact.get(c.id) ?? [] }));
  }

  getContact(id: number): ContactDto | null {
    return this.listContacts().find((c) => c.id === id) ?? null;
  }

  /** Phones already attached to another contact than `exceptId`. */
  conflictingPhones(phones: string[], exceptId: number | null): string[] {
    if (phones.length === 0) return [];
    const rows = this.db
      .prepare(`SELECT phone, contact_id FROM contact_phones WHERE phone IN (${phones.map(() => '?').join(',')})`)
      .all(...phones) as { phone: string; contact_id: number }[];
    return rows.filter((r) => r.contact_id !== exceptId).map((r) => r.phone);
  }

  saveContact(input: { id?: number; name: string; notes?: string | null; phones: string[] }): number {
    return this.transaction(() => {
      const now = Date.now();
      let id = input.id;
      if (id) {
        this.db.prepare('UPDATE contacts SET name = ?, notes = ?, updated_at = ? WHERE id = ?').run(input.name, input.notes ?? null, now, id);
        this.db.prepare('DELETE FROM contact_phones WHERE contact_id = ?').run(id);
      } else {
        id = Number(
          this.db
            .prepare('INSERT INTO contacts (name, notes, created_at, updated_at) VALUES (?, ?, ?, ?)')
            .run(input.name, input.notes ?? null, now, now).lastInsertRowid,
        );
      }
      const phones = [...new Set(input.phones)];
      const previousOwners = new Set(
        phones.length === 0
          ? []
          : (
              this.db
                .prepare(`SELECT contact_id FROM contact_phones WHERE phone IN (${phones.map(() => '?').join(',')})`)
                .all(...phones) as { contact_id: number }[]
            ).map((r) => r.contact_id),
      );
      const insert = this.db.prepare(
        'INSERT INTO contact_phones (phone, contact_id) VALUES (?, ?) ON CONFLICT(phone) DO UPDATE SET contact_id = excluded.contact_id',
      );
      for (const phone of phones) insert.run(phone, id);
      // A contact whose only numbers were just moved here has nothing left to identify it.
      const orphanCheck = this.db.prepare('SELECT 1 FROM contact_phones WHERE contact_id = ? LIMIT 1');
      for (const owner of previousOwners) {
        if (owner !== id && !orphanCheck.get(owner)) this.db.prepare('DELETE FROM contacts WHERE id = ?').run(owner);
      }
      return id;
    });
  }

  deleteContact(id: number): boolean {
    return this.db.prepare('DELETE FROM contacts WHERE id = ?').run(id).changes > 0;
  }
}

function toConversationDto(row: ConversationRow): ConversationDto {
  return {
    id: row.id,
    did: row.did,
    phone: row.phone,
    contact: row.contact_id !== null ? { id: row.contact_id, name: row.contact_name ?? '' } : null,
    unreadCount: row.unread_count,
    lastMessageAt: row.last_message_at,
    lastMessage:
      row.last_message_id !== null && row.last_direction !== null
        ? {
            body: row.last_body ?? '',
            direction: row.last_direction,
            status: row.last_status ?? 'sent',
            attachmentCount: row.last_attachments ?? 0,
          }
        : null,
  };
}

export function toAttachmentDto(row: AttachmentRow): AttachmentDto {
  return {
    id: row.id,
    mime: row.mime,
    size: row.size,
    status: row.status,
    url: row.status === 'ready' && row.file_name ? `/api/media/${row.id}` : null,
  };
}
