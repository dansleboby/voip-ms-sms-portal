import type { ServerResponse } from 'node:http';
import type { ServerEvent } from '../shared/types.js';

/** Fans server events out to every open browser tab over Server-Sent Events. */
export class EventHub {
  private readonly clients = new Set<ServerResponse>();
  private readonly listeners = new Set<(count: number) => void>();
  private heartbeat: NodeJS.Timeout | null = null;

  get clientCount(): number {
    return this.clients.size;
  }

  /** Called with the number of connected tabs whenever it changes. */
  onClientCountChange(listener: (count: number) => void): void {
    this.listeners.add(listener);
  }

  attach(res: ServerResponse): void {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      // Disables response buffering in nginx so events arrive immediately.
      'X-Accel-Buffering': 'no',
    });
    res.write('retry: 3000\n\n');
    this.clients.add(res);
    res.on('close', () => {
      this.clients.delete(res);
      this.notify();
    });
    this.ensureHeartbeat();
    this.notify();
  }

  broadcast(event: ServerEvent): void {
    const frame = `data: ${JSON.stringify(event)}\n\n`;
    for (const res of this.clients) res.write(frame);
  }

  close(): void {
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = null;
    for (const res of this.clients) res.end();
    this.clients.clear();
  }

  private ensureHeartbeat(): void {
    if (this.heartbeat) return;
    this.heartbeat = setInterval(() => {
      for (const res of this.clients) res.write(': ping\n\n');
    }, 25_000);
    this.heartbeat.unref();
  }

  private notify(): void {
    for (const listener of this.listeners) listener(this.clients.size);
  }
}
