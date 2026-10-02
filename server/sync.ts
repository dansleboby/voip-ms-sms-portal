import type { Repo } from './db.js';
import type { EventHub } from './events.js';
import type { Logger } from './logger.js';
import type { MediaStore } from './media.js';
import { DAY_MS, epochToZonedDate, zonedToEpoch } from './time.js';
import { VoipMsError, type RemoteKind, type RemoteMessage, type VoipMsApi } from './voipms/client.js';
import { normalizePhone } from '../shared/phone.js';
import type { SyncStatusDto } from '../shared/types.js';

const LAST_SUCCESS_KEY = 'sync.lastSuccessAt';
/** VoIP.ms refuses ranges over 92 days; smaller windows also keep responses small. */
const WINDOW_DAYS = 30;
/**
 * Messages asked per call. VoIP.ms documents no maximum; a full page is
 * treated as possibly truncated and re-fetched one day at a time.
 */
const PAGE_LIMIT = 1000;
/** Local outgoing message with no VoIP.ms id that a fetched message may correspond to. */
const ADOPT_WINDOW_MS = 15 * 60 * 1000;
const RATE_LIMIT_BACKOFF_MS = 60_000;
const MAX_ERROR_BACKOFF_MS = 5 * 60_000;

export interface SyncDeps {
  repo: Repo;
  events: EventHub;
  media: MediaStore;
  /** Null until VoIP.ms credentials are configured. */
  getClient: () => VoipMsApi | null;
  /** Polling only runs once the setup wizard is finished. */
  isEnabled: () => boolean;
  timeZone: string;
  pollActiveMs: number;
  pollIdleMs: number;
  log: Logger;
  now?: () => number;
}

/** Serializes work that must not interleave (a poll and the bookkeeping of a send). */
class Mutex {
  private tail: Promise<unknown> = Promise.resolve();

  run<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.tail.then(fn);
    this.tail = result.catch(() => undefined);
    return result;
  }
}

/**
 * Keeps the local database in step with VoIP.ms by polling getSMS/getMMS.
 *
 * VoIP.ms keeps the message history, so polling never loses anything: after a
 * downtime the next poll widens its window back to the last successful sync.
 */
export class SyncEngine {
  private readonly mutex = new Mutex();
  private readonly now: () => number;
  private timer: NodeJS.Timeout | null = null;
  private ticking = false;
  private stopped = true;
  private active = false;
  private consecutiveErrors = 0;
  private importing: { done: number; total: number } | null = null;
  private state: SyncStatusDto['state'] = 'idle';
  private lastError: string | null = null;

  constructor(private readonly deps: SyncDeps) {
    this.now = deps.now ?? Date.now;
  }

  status(): SyncStatusDto {
    const last = this.deps.repo.getSetting(LAST_SUCCESS_KEY);
    return {
      state: this.deps.isEnabled() && this.deps.getClient() ? this.state : 'disabled',
      mode: this.active ? 'active' : 'idle',
      lastSyncAt: last ? Number(last) : null,
      lastError: this.lastError,
      importing: this.importing,
    };
  }

  start(): void {
    this.stopped = false;
    this.schedule(0);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  /** Faster polling while someone has the app open; an opening tab triggers a sync right away. */
  setActive(active: boolean): void {
    if (active === this.active) return;
    this.active = active;
    if (active) this.schedule(0);
    this.publishStatus();
  }

  /** Runs `fn` with polling held off, so a send and a poll never race on the same message. */
  exclusive<T>(fn: () => Promise<T>): Promise<T> {
    return this.mutex.run(fn);
  }

  /** Requests a sync soon (e.g. right after setup or a send). */
  trigger(delayMs = 0): void {
    this.schedule(delayMs);
  }

  private interval(): number {
    if (this.consecutiveErrors > 0) {
      if (this.lastError === 'api_limit_exceeded') return RATE_LIMIT_BACKOFF_MS;
      const base = this.active ? this.deps.pollActiveMs : this.deps.pollIdleMs;
      return Math.min(base * 2 ** (this.consecutiveErrors - 1), MAX_ERROR_BACKOFF_MS);
    }
    return this.active ? this.deps.pollActiveMs : this.deps.pollIdleMs;
  }

  private schedule(delayMs: number): void {
    if (this.stopped) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.tick(), delayMs);
    this.timer.unref?.();
  }

  private async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      await this.syncRecent();
    } finally {
      this.ticking = false;
      this.schedule(this.interval());
    }
  }

  /** Fetches everything since the last successful sync (at least the last day). */
  async syncRecent(): Promise<void> {
    const client = this.deps.getClient();
    if (!client || !this.deps.isEnabled()) {
      this.state = 'idle';
      return;
    }
    const now = this.now();
    const last = Number(this.deps.repo.getSetting(LAST_SUCCESS_KEY) ?? 0);
    // Start a day before the last success to absorb clock and time zone edges; at most 90 days back.
    const from = Math.max(Math.min(now - DAY_MS, (last || now) - DAY_MS), now - 90 * DAY_MS);
    this.state = 'syncing';
    try {
      // The very first sync only establishes a baseline: no unread badges or notifications for old texts.
      await this.syncRange(client, from, now + DAY_MS, last > 0 ? -Infinity : Infinity);
      this.deps.repo.setSetting(LAST_SUCCESS_KEY, String(now));
      this.state = 'idle';
      this.lastError = null;
      this.consecutiveErrors = 0;
      this.deps.media.kick();
    } catch (err) {
      this.state = 'error';
      this.lastError = err instanceof VoipMsError ? err.code : 'internal_error';
      this.consecutiveErrors++;
      this.deps.log.warn({ err }, 'VoIP.ms sync failed');
    }
    this.publishStatus();
  }

  /**
   * Imports older messages without marking them unread. Messages newer than
   * the last poll are still treated as new: the import must not swallow a
   * text the next poll would have announced. Resolves once done.
   */
  async importHistory(days: number): Promise<void> {
    const client = this.deps.getClient();
    if (!client) throw new VoipMsError('not_configured');
    if (this.importing) throw new VoipMsError('import_in_progress');
    const now = this.now();
    const last = Number(this.deps.repo.getSetting(LAST_SUCCESS_KEY) ?? 0);
    const liveAfter = last > 0 ? last : Infinity;
    const windows = splitWindows(now - days * DAY_MS, now + DAY_MS, WINDOW_DAYS);
    this.importing = { done: 0, total: windows.length };
    this.publishStatus();
    try {
      // Newest first, so recent conversations show up while older ones load.
      for (const [from, to] of windows.reverse()) {
        await this.syncRange(client, from, to, liveAfter);
        this.importing = { done: this.importing.done + 1, total: windows.length };
        this.deps.events.broadcast({ type: 'reload' });
        this.publishStatus();
      }
      this.deps.media.kick();
    } finally {
      this.importing = null;
      this.publishStatus();
    }
  }

  /** Messages sent after `liveAfter` count as new (unread, announced); older ones are stored quietly. */
  private async syncRange(client: VoipMsApi, fromMs: number, toMs: number, liveAfter: number): Promise<void> {
    let quiet = 0;
    for (const [from, to] of splitWindows(fromMs, toMs, WINDOW_DAYS)) {
      for (const kind of ['sms', 'mms'] as const) {
        const messages = await this.fetchAll(client, kind, from, to);
        quiet += await this.mutex.run(async () => this.ingest(messages, liveAfter));
      }
    }
    // Quiet changes are not announced one by one: have the clients reload instead.
    if (quiet > 0) this.deps.events.broadcast({ type: 'reload' });
  }

  /** Fetches a window; if it hits the page limit, falls back to one call per day. */
  private async fetchAll(client: VoipMsApi, kind: RemoteKind, fromMs: number, toMs: number): Promise<RemoteMessage[]> {
    const from = epochToZonedDate(fromMs, this.deps.timeZone);
    const to = epochToZonedDate(toMs, this.deps.timeZone);
    const messages = await client.getMessages(kind, { from, to, limit: PAGE_LIMIT });
    if (messages.length < PAGE_LIMIT) return messages;
    const all: RemoteMessage[] = [];
    for (const date of datesBetween(fromMs, toMs, this.deps.timeZone)) {
      const day = await client.getMessages(kind, { from: date, to: date, limit: PAGE_LIMIT });
      if (day.length >= PAGE_LIMIT) {
        this.deps.log.warn({ kind, date }, 'More messages in one day than a page holds; some may be missing');
      }
      all.push(...day);
    }
    return all;
  }

  /**
   * Stores messages not seen before. Those sent after `liveAfter` are new:
   * incoming ones become unread and each one is announced. Returns how many
   * changes were made quietly.
   */
  ingest(messages: RemoteMessage[], liveAfter: number): number {
    const { repo, events, timeZone } = this.deps;
    const changed: { messageId: number; conversationId: number }[] = [];
    let quiet = 0;
    let newDid = false;
    let newMedia = false;

    repo.transaction(() => {
      for (const remote of messages) {
        if (!remote.id) continue;
        const existing = repo.findMessageByRemote(remote.kind, remote.id);
        if (existing) {
          if (remote.carrierStatus && remote.carrierStatus !== existing.carrierStatus) {
            repo.updateMessage(existing.id, { carrierStatus: remote.carrierStatus });
            const row = repo.getMessageRow(existing.id);
            if (row && row.sent_at > liveAfter) changed.push({ messageId: row.id, conversationId: row.conversation_id });
            else quiet++;
          }
          continue;
        }

        const did = normalizePhone(remote.did);
        const phone = normalizePhone(remote.contact);
        if (!did || !phone) continue;
        if (!repo.getDid(did)) {
          repo.ensureDid(did);
          newDid = true;
        }
        const conversationId = repo.getOrCreateConversation(did, phone);
        let sentAt: number;
        try {
          sentAt = zonedToEpoch(remote.date, timeZone);
        } catch {
          sentAt = this.now();
        }

        const live = sentAt > liveAfter;
        if (remote.direction === 'out') {
          const adopted = this.adoptLocalSend(conversationId, remote, sentAt);
          if (adopted !== null) {
            changed.push({ messageId: adopted, conversationId });
            continue;
          }
        }

        const messageId = repo.insertMessage({
          conversationId,
          kind: remote.kind,
          remoteId: remote.id,
          direction: remote.direction,
          body: remote.body,
          sentAt,
          status: remote.direction === 'in' ? 'received' : 'sent',
          carrierStatus: remote.carrierStatus,
        });
        remote.media.forEach((url, i) => {
          repo.insertAttachment(messageId, i, { remoteUrl: url, status: 'pending' });
          newMedia = true;
        });
        repo.touchConversation(conversationId, live && remote.direction === 'in' ? 1 : 0);
        if (live) changed.push({ messageId, conversationId });
        else quiet++;
      }
    });

    if (newDid) events.broadcast({ type: 'dids' });
    if (newMedia) this.deps.media.kick();
    for (const { messageId, conversationId } of changed) {
      const message = repo.getMessage(messageId);
      const conversation = repo.getConversation(conversationId);
      if (message && conversation) events.broadcast({ type: 'message', message, conversation });
    }
    if (changed.length) events.broadcast({ type: 'dids' });
    return quiet;
  }

  /**
   * A send can fail ambiguously (timeout, Cloudflare 5xx, restart) after
   * VoIP.ms accepted it. When the message then shows up in the history,
   * attach it to the local copy instead of displaying it twice. Only failed
   * attempts qualify: a message still waiting to be sent must go out.
   */
  private adoptLocalSend(conversationId: number, remote: RemoteMessage, sentAt: number): number | null {
    const row = this.deps.repo.db
      .prepare(
        `SELECT m.id FROM messages m
         WHERE m.conversation_id = ? AND m.direction = 'out' AND m.remote_id IS NULL AND m.status = 'failed'
           AND m.kind = ? AND m.body = ? AND m.sent_at BETWEEN ? AND ?
           AND (SELECT COUNT(*) FROM attachments a WHERE a.message_id = m.id) = ?
         ORDER BY m.sent_at LIMIT 1`,
      )
      .get(
        conversationId,
        remote.kind,
        remote.body,
        sentAt - ADOPT_WINDOW_MS,
        sentAt + ADOPT_WINDOW_MS,
        remote.media.length,
      ) as { id: number } | undefined;
    if (!row) return null;
    this.deps.repo.updateMessage(row.id, {
      kind: remote.kind,
      remoteId: remote.id,
      status: 'sent',
      error: null,
      carrierStatus: remote.carrierStatus,
    });
    return row.id;
  }

  private publishStatus(): void {
    this.deps.events.broadcast({ type: 'sync', status: this.status() });
  }
}

/**
 * Splits [from, to] into windows of at most `days` calendar days. Consecutive
 * windows share their boundary day so a DST shift can never skip a date;
 * the duplicates are dropped on ingest.
 */
export function splitWindows(fromMs: number, toMs: number, days: number): [number, number][] {
  const windows: [number, number][] = [];
  const span = (days - 1) * DAY_MS;
  for (let start = fromMs; ; start += span) {
    const end = Math.min(start + span, toMs);
    windows.push([start, end]);
    if (end >= toMs) return windows;
  }
}

/** Every calendar date (in `timeZone`) touched by [from, to]. */
export function datesBetween(fromMs: number, toMs: number, timeZone: string): string[] {
  const dates = new Set<string>();
  // Half-day steps cannot jump over a date, whatever the DST transitions.
  for (let t = fromMs; t < toMs; t += DAY_MS / 2) dates.add(epochToZonedDate(t, timeZone));
  dates.add(epochToZonedDate(toMs, timeZone));
  return [...dates];
}
