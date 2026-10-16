import crypto from 'node:crypto';
import type { ServerResponse } from 'node:http';
import type { EventsPollDto, ServerEvent } from '../shared/types.js';

/** What a tab says about itself when it connects. */
export interface TabInfo {
  /** Random id of the browser, shared by its tabs and its push subscription. */
  device?: string | null;
  /** Random id of this connection, to report visibility changes. */
  tab?: string | null;
  visible?: boolean;
}

interface Tab {
  device: string | null;
  tab: string | null;
  visible: boolean;
}

interface PollingTab extends Tab {
  seenAt: number;
}

/** Events kept for polling tabs; one that falls further behind reloads everything. */
const BACKLOG_SIZE = 500;
/**
 * A polling tab counts as open until it misses its polls for this long.
 * Hidden tabs poll every 30 s, and browsers may stretch that to a minute.
 */
const POLLING_TAB_TTL_MS = 90_000;
/**
 * A visible tab polls every few seconds. One closed without saying so stops
 * hiding the device's push notifications after this long.
 */
const ON_SCREEN_TTL_MS = 15_000;
const HEARTBEAT_MS = 25_000;

/**
 * Fans server events out to every open browser tab, over Server-Sent Events
 * or to tabs that poll for them (hosts that cannot hold a stream open).
 */
export class EventHub {
  private readonly clients = new Map<ServerResponse, Tab>();
  private readonly pollers = new Map<string, PollingTab>();
  private readonly listeners = new Set<(count: number) => void>();
  private readonly backlog: { seq: number; event: ServerEvent }[] = [];
  private seq = 0;
  /** Cursors from before a restart point into a backlog that is gone. */
  private readonly epoch = crypto.randomBytes(6).toString('base64url');
  private heartbeat: NodeJS.Timeout | null = null;

  constructor(private readonly now: () => number = Date.now) {}

  get clientCount(): number {
    return this.clients.size + this.pollers.size;
  }

  /** Called with the number of connected tabs whenever it changes. */
  onClientCountChange(listener: (count: number) => void): void {
    this.listeners.add(listener);
  }

  attach(res: ServerResponse, info: TabInfo = {}): void {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      // Disables response buffering in nginx so events arrive immediately.
      'X-Accel-Buffering': 'no',
    });
    res.write('retry: 3000\n\n');
    this.clients.set(res, { device: info.device ?? null, tab: info.tab ?? null, visible: info.visible ?? true });
    res.on('close', () => {
      this.clients.delete(res);
      this.notify();
    });
    this.ensureHeartbeat();
    this.notify();
  }

  /**
   * A polling tab asks for the events after `after` (none on its first
   * poll). Each poll also tells whether the tab is still open and visible.
   */
  poll(after: string | undefined, info: TabInfo = {}): EventsPollDto {
    if (info.tab) {
      const known = this.pollers.has(info.tab);
      this.pollers.set(info.tab, { device: info.device ?? null, tab: info.tab, visible: info.visible ?? true, seenAt: this.now() });
      if (!known) this.notify();
      this.ensureHeartbeat();
    }
    const cursor = `${this.epoch}.${this.seq}`;
    if (after === undefined) return { cursor, events: [], reset: false };
    const seq = this.parseCursor(after);
    const oldest = this.backlog[0]?.seq ?? this.seq + 1;
    if (seq === null || seq > this.seq || seq < oldest - 1) return { cursor, events: [], reset: true };
    return { cursor, events: this.backlog.filter((e) => e.seq > seq).map((e) => e.event), reset: false };
  }

  /** Records that a tab was shown or hidden. Returns false for an unknown tab. */
  setVisibility(tab: string, visible: boolean): boolean {
    let found = false;
    for (const info of this.clients.values()) {
      if (info.tab === tab) {
        info.visible = visible;
        found = true;
      }
    }
    const polling = this.pollers.get(tab);
    if (polling) {
      polling.visible = visible;
      found = true;
    }
    return found;
  }

  /** True while the app is on screen in one of this browser's tabs. */
  isOnScreen(device: string): boolean {
    for (const info of this.clients.values()) if (info.device === device && info.visible) return true;
    const now = this.now();
    for (const info of this.pollers.values()) {
      if (info.device === device && info.visible && now - info.seenAt < ON_SCREEN_TTL_MS) return true;
    }
    return false;
  }

  broadcast(event: ServerEvent): void {
    this.backlog.push({ seq: ++this.seq, event });
    if (this.backlog.length > BACKLOG_SIZE) this.backlog.shift();
    const frame = `data: ${JSON.stringify(event)}\n\n`;
    for (const res of this.clients.keys()) res.write(frame);
  }

  /** Forgets the polling tabs that stopped polling (closed, or frozen by the browser). */
  expire(): void {
    const now = this.now();
    let changed = false;
    for (const [tab, info] of this.pollers) {
      if (now - info.seenAt > POLLING_TAB_TTL_MS) {
        this.pollers.delete(tab);
        changed = true;
      }
    }
    if (changed) this.notify();
  }

  close(): void {
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = null;
    for (const res of this.clients.keys()) res.end();
    this.clients.clear();
    this.pollers.clear();
  }

  private parseCursor(cursor: string): number | null {
    const dot = cursor.lastIndexOf('.');
    const seq = cursor.slice(dot + 1);
    if (cursor.slice(0, dot) !== this.epoch || !/^\d{1,15}$/.test(seq)) return null;
    return Number(seq);
  }

  private ensureHeartbeat(): void {
    if (this.heartbeat) return;
    this.heartbeat = setInterval(() => {
      for (const res of this.clients.keys()) res.write(': ping\n\n');
      this.expire();
    }, HEARTBEAT_MS);
    this.heartbeat.unref();
  }

  private notify(): void {
    for (const listener of this.listeners) listener(this.clientCount);
  }
}
