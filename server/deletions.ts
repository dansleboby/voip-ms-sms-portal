import { voipmsId, type Repo } from './db.js';
import type { Logger } from './logger.js';
import { VoipMsError, type VoipMsApi } from './voipms/client.js';

/** Failures worth another try later; any other means VoIP.ms will not delete that message. */
const PASSING = new Set(['network_error', 'http_error', 'invalid_response', 'api_limit_exceeded', 'not_configured']);
const RETRY_MS = 60_000;

/**
 * Deletes at VoIP.ms the messages deleted "at VoIP.ms too", one call each and
 * in the background: a conversation can hold hundreds. A failure that may
 * pass (network, rate limit) waits a minute; the message stays deleted in
 * the portal whatever happens.
 */
export class RemoteDeletions {
  private current: Promise<void> | null = null;
  private again = false;
  private stopped = false;
  private timer: NodeJS.Timeout | null = null;

  /** `clientForDid`: the client of the account the message's number belongs to. */
  constructor(private readonly deps: { repo: Repo; clientForDid: (did: string) => VoipMsApi | null; log: Logger }) {}

  /** Processes the pending deletions; safe to call often. */
  kick(): void {
    if (this.stopped) return;
    if (this.current) {
      this.again = true;
      return;
    }
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.current = this.drain()
      .catch((err: unknown) => this.deps.log.warn({ err }, 'Deleting at VoIP.ms was interrupted'))
      .finally(() => {
        this.current = null;
        if (this.again) {
          this.again = false;
          this.kick();
        }
      });
  }

  /** Waits for the call in progress, so that nothing touches the database once it is closed. */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    await this.current;
  }

  private async drain(): Promise<void> {
    const { repo, log } = this.deps;
    for (;;) {
      const batch = repo.pendingRemoteDeletes(20);
      if (batch.length === 0) return;
      for (const message of batch) {
        try {
          const client = this.deps.clientForDid(message.did);
          if (!client) throw new VoipMsError('not_configured');
          await client.deleteMessage(message.kind, voipmsId(message.remoteId));
        } catch (err) {
          const code = err instanceof VoipMsError ? err.code : 'internal_error';
          if (PASSING.has(code)) return this.retryLater();
          log.warn({ err, messageId: message.id }, 'VoIP.ms did not delete a message; it stays deleted in the portal');
        }
        if (this.stopped) return;
        repo.remoteDeleteDone(message.id);
      }
    }
  }

  private retryLater(): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => this.kick(), RETRY_MS);
    this.timer.unref?.();
  }
}
