import { PRIMARY_ACCOUNT, type Repo } from './db.js';
import type { EventHub } from './events.js';
import type { Logger } from './logger.js';
import type { MediaStore } from './media.js';
import type { CredentialStore } from './secrets.js';
import { SyncEngine } from './sync.js';
import type { VoipMsApi, VoipMsCredentials } from './voipms/client.js';
import { WebhookReceiver } from './webhook.js';
import { normalizePhone } from '../shared/phone.js';
import type { AccountDto, SyncStatusDto, WebhookSummaryDto } from '../shared/types.js';

/** One VoIP.ms account: its client, the checks of its numbers, and VoIP.ms calling back for them. */
export interface Account {
  readonly id: number;
  /** Client for the account's credentials, or null while it has none (or cannot read them). */
  client(): VoipMsApi | null;
  /** Drops the cached client after its credentials change. */
  resetClient(): void;
  readonly sync: SyncEngine;
  readonly webhook: WebhookReceiver;
}

export interface AccountsDeps {
  repo: Repo;
  events: EventHub;
  media: MediaStore;
  credentials: CredentialStore;
  /** A client for credentials; the account matters to the demo, which has one sample account per id. */
  clientFor: (credentials: VoipMsCredentials, accountId: number) => VoipMsApi;
  isSetupCompleted: () => boolean;
  timeZone: string;
  pollActiveMs: number;
  pollIdleMs: number;
  publicOrigin: string | null;
  log: Logger;
  onIncoming: (messages: { messageId: number; conversationId: number }[]) => void;
}

/**
 * The VoIP.ms accounts the portal uses. Each one is checked on its own (its
 * own credentials, watermark and webhook), and a number belongs to the
 * account whose history it came from. To the rest of the server, their
 * checks look like one: started, triggered and reported together.
 */
export class Accounts {
  private readonly accounts = new Map<number, Account>();
  private started = false;
  private active = false;

  constructor(private readonly deps: AccountsDeps) {
    for (const { id } of deps.repo.listAccounts()) this.open(id);
  }

  primary(): Account {
    return this.open(PRIMARY_ACCOUNT);
  }

  get(id: number): Account | undefined {
    return this.accounts.get(id);
  }

  all(): Account[] {
    return [...this.accounts.values()];
  }

  /** The account a number belongs to; null for a number the portal does not know. */
  forDid(did: string): Account | null {
    const id = this.deps.repo.accountOfDid(normalizePhone(did));
    return id === null ? null : (this.accounts.get(id) ?? null);
  }

  list(): AccountDto[] {
    return this.deps.repo.listAccounts().map((a) => ({
      id: a.id,
      label: a.label,
      username: this.deps.credentials.get(a.id)?.username ?? null,
      credentialsSource: this.deps.credentials.source(a.id),
      numbers: a.numbers,
    }));
  }

  /** Adds an account with credentials already checked; its numbers come with the next refresh. */
  add(label: string | null, credentials: VoipMsCredentials): Account {
    const id = this.deps.repo.createAccount(label);
    this.deps.credentials.save(credentials, id);
    const account = this.open(id);
    if (this.started) {
      account.sync.setActive(this.active);
      account.sync.start();
    }
    return account;
  }

  /**
   * Fetches every account's numbers from VoIP.ms; an account VoIP.ms refuses
   * keeps the ones it had. The first account's refusal is reported: it is
   * the one the setup wizard sets up.
   */
  async refreshDids(): Promise<void> {
    let primaryError: unknown = null;
    for (const account of this.all()) {
      const client = account.client();
      if (!client) continue;
      try {
        const dids = (await client.getDids()).filter((d) => this.deps.repo.allowsDid(d.did));
        this.deps.repo.transaction(() => {
          for (const d of dids) {
            if (!this.deps.repo.upsertDid(d, account.id)) this.deps.log.warn({ did: d.did, account: account.id }, 'Number already used under another account');
          }
        });
      } catch (err) {
        if (account.id === PRIMARY_ACCOUNT) primaryError = err;
        else this.deps.log.warn({ err, account: account.id }, 'Could not refresh the numbers of a VoIP.ms account');
      }
    }
    this.deps.events.broadcast({ type: 'dids' });
    if (primaryError) throw primaryError;
  }

  /** A call from VoIP.ms: the account whose secret it carries checks its numbers. */
  receive(token: string): boolean {
    return this.all().some((account) => account.webhook.receive(token));
  }

  // ------------------------------------------------- the checks, all together

  start(): void {
    this.started = true;
    for (const account of this.all()) account.sync.start();
  }

  stop(): void {
    this.started = false;
    for (const account of this.all()) account.sync.stop();
  }

  setActive(active: boolean): void {
    this.active = active;
    for (const account of this.all()) account.sync.setActive(active);
  }

  trigger(delayMs = 0): void {
    for (const account of this.all()) account.sync.trigger(delayMs);
  }

  /** Checks every account now, one after the other. */
  async syncRecent(): Promise<void> {
    for (const account of this.all()) await account.sync.syncRecent();
  }

  /** The history of the account the wizard sets up. */
  importHistory(days: number): Promise<void> {
    return this.primary().sync.importHistory(days);
  }

  /**
   * One status for the tabs: an error or a check in progress on any account
   * shows; dates are those of the account checked least recently.
   */
  status(): SyncStatusDto {
    const all = this.all().map((a) => a.sync.status());
    if (all.length === 1) return all[0]!;
    const live = all.filter((s) => s.state !== 'disabled');
    const oldest = (values: (number | null)[]) => (values.includes(null) ? null : Math.min(...(values as number[])));
    const importing = all.filter((s) => s.importing);
    const webhooks = all.map((s) => s.webhook).filter((w): w is WebhookSummaryDto => w !== null);
    return {
      state:
        live.length === 0 ? 'disabled'
        : live.some((s) => s.state === 'syncing') ? 'syncing'
        : live.some((s) => s.state === 'error') ? 'error'
        : 'idle',
      mode: all.some((s) => s.mode === 'active') ? 'active' : 'idle',
      lastSyncAt: oldest(live.map((s) => s.lastSyncAt)),
      lastCheckAt: oldest(live.map((s) => s.lastCheckAt)),
      lastError: live.find((s) => s.lastError)?.lastError ?? null,
      importing: importing.length
        ? { done: importing.reduce((n, s) => n + s.importing!.done, 0), total: importing.reduce((n, s) => n + s.importing!.total, 0) }
        : null,
      webhook: webhooks.length
        ? {
            lastCallAt: webhooks.some((w) => w.lastCallAt !== null) ? Math.max(...webhooks.map((w) => w.lastCallAt ?? 0)) : null,
            complete: webhooks.every((w) => w.complete),
          }
        : null,
    };
  }

  private publish(): void {
    this.deps.events.broadcast({ type: 'sync', status: this.status() });
  }

  private open(id: number): Account {
    const existing = this.accounts.get(id);
    if (existing) return existing;
    const { deps } = this;
    let cached: VoipMsApi | null = null;
    const client = (): VoipMsApi | null => {
      if (cached) return cached;
      const credentials = deps.credentials.get(id);
      cached = credentials ? deps.clientFor(credentials, id) : null;
      return cached;
    };
    // The webhook's calls trigger the account's checks, which slow down once every number calls back.
    let sync: SyncEngine | null = null;
    const webhook = new WebhookReceiver({
      accountId: id,
      repo: deps.repo,
      getClient: client,
      publicOrigin: deps.publicOrigin,
      onCall: () => sync?.trigger(),
    });
    sync = new SyncEngine({
      accountId: id,
      repo: deps.repo,
      events: deps.events,
      media: deps.media,
      getClient: client,
      isEnabled: deps.isSetupCompleted,
      timeZone: deps.timeZone,
      pollActiveMs: deps.pollActiveMs,
      pollIdleMs: deps.pollIdleMs,
      log: deps.log,
      onIncoming: deps.onIncoming,
      webhook,
      publish: () => this.publish(),
    });
    const account: Account = {
      id,
      client,
      resetClient: () => {
        cached = null;
      },
      sync,
      webhook,
    };
    this.accounts.set(id, account);
    return account;
  }
}
