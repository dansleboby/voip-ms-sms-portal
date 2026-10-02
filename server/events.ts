import type { ServerResponse } from 'node:http';
import type { ServerEvent } from '../shared/types.js';

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

/** Fans server events out to every open browser tab over Server-Sent Events. */
export class EventHub {
  private readonly clients = new Map<ServerResponse, Tab>();
  private readonly listeners = new Set<(count: number) => void>();
  private heartbeat: NodeJS.Timeout | null = null;

  get clientCount(): number {
    return this.clients.size;
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

  /** Records that a tab was shown or hidden. Returns false for an unknown tab. */
  setVisibility(tab: string, visible: boolean): boolean {
    let found = false;
    for (const info of this.clients.values()) {
      if (info.tab === tab) {
        info.visible = visible;
        found = true;
      }
    }
    return found;
  }

  /** True while the app is on screen in one of this browser's tabs. */
  isOnScreen(device: string): boolean {
    for (const info of this.clients.values()) if (info.device === device && info.visible) return true;
    return false;
  }

  broadcast(event: ServerEvent): void {
    const frame = `data: ${JSON.stringify(event)}\n\n`;
    for (const res of this.clients.keys()) res.write(frame);
  }

  close(): void {
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = null;
    for (const res of this.clients.keys()) res.end();
    this.clients.clear();
  }

  private ensureHeartbeat(): void {
    if (this.heartbeat) return;
    this.heartbeat = setInterval(() => {
      for (const res of this.clients.keys()) res.write(': ping\n\n');
    }, 25_000);
    this.heartbeat.unref();
  }

  private notify(): void {
    for (const listener of this.listeners) listener(this.clients.size);
  }
}
