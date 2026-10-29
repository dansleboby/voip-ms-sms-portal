import crypto from 'node:crypto';
import type { Repo } from './db.js';
import { VoipMsError, type SmsCallback, type VoipMsApi } from './voipms/client.js';
import { normalizePhone } from '../shared/phone.js';
import type { WebhookNumberDto, WebhookStatusDto, WebhookSummaryDto } from '../shared/types.js';
import { WEBHOOK_SAFETY_MINUTES } from '../shared/webhook.js';

const ENABLED_KEY = 'webhook.enabled';
const TOKEN_KEY = 'webhook.token';
const URL_KEY = 'webhook.url';
/** '1' while every number with SMS on calls back (as of the last look at VoIP.ms). */
const COMPLETE_KEY = 'webhook.complete';
/** The callbacks this portal replaced, by number, to give them back when webhooks are turned off. */
const PREVIOUS_KEY = 'webhook.previous';
const LAST_CALL_KEY = 'webhook.lastCallAt';

/** Where VoIP.ms calls; the secret follows. */
export const CALLBACK_PATH = '/api/voipms/callback/';
/** Checks that still run with webhooks on (shared/webhook.ts). */
export const SAFETY_INTERVAL_MS = WEBHOOK_SAFETY_MINUTES * 60_000;

export class WebhookError extends Error {
  constructor(
    readonly code: string,
    readonly statusCode = 400,
  ) {
    super(code);
  }
}

export interface WebhookDeps {
  repo: Repo;
  getClient: () => VoipMsApi | null;
  /** PUBLIC_URL's origin: the callback's address when set. */
  publicOrigin: string | null;
  /** A call from VoIP.ms: check it now. */
  onCall: () => void;
  now?: () => number;
}

/**
 * Texts announced by VoIP.ms (each number's "SMS/MMS URL Callback") instead
 * of found by checking on a schedule. A call is only a signal to check VoIP.ms
 * right away: what it says is never stored, since nothing proves it comes from
 * VoIP.ms. The secret in its address only keeps strangers from making the
 * portal check more often.
 */
export class WebhookReceiver {
  private readonly now: () => number;

  constructor(private readonly deps: WebhookDeps) {
    this.now = deps.now ?? Date.now;
  }

  private get repo(): Repo {
    return this.deps.repo;
  }

  enabled(): boolean {
    return this.repo.getSetting(ENABLED_KEY) === '1';
  }

  /** Every number with SMS on calls back: checks can slow down to the safety net. */
  complete(): boolean {
    return this.enabled() && this.repo.getSetting(COMPLETE_KEY) === '1';
  }

  summary(): WebhookSummaryDto | null {
    if (!this.enabled()) return null;
    return { lastCallAt: this.lastCallAt(), complete: this.complete() };
  }

  /** The callback for a number whose SMS is turned on while webhooks are on. */
  callbackForNewNumber(): SmsCallback | undefined {
    const url = this.repo.getSetting(URL_KEY);
    return this.enabled() && url ? { url, retry: true } : undefined;
  }

  /** A call to the callback address: true when its secret is right. */
  receive(token: string): boolean {
    const expected = this.repo.getSetting(TOKEN_KEY);
    if (!expected || !sameSecret(token, expected)) return false;
    this.repo.setSetting(LAST_CALL_KEY, String(this.now()));
    this.deps.onCall();
    return true;
  }

  /** The callback of each number, as VoIP.ms has it now. `errors`: what VoIP.ms refused just before. */
  async status(errors: Map<string, string> = new Map()): Promise<WebhookStatusDto> {
    const client = this.client();
    const token = this.repo.getSetting(TOKEN_KEY);
    const numbers: WebhookNumberDto[] = [];
    for (const d of await client.getDids()) {
      const did = normalizePhone(d.did);
      if (!this.repo.allowsDid(did)) continue;
      let state: WebhookNumberDto['state'] = 'none';
      if (!d.smsEnabled) state = 'sms_off';
      else if (d.callback && token && isOurs(d.callback.url, token)) state = 'ours';
      else if (d.callback) state = 'other';
      numbers.push({ did, state, otherUrl: state === 'other' ? d.callback!.url : null, error: errors.get(did) ?? null });
    }
    const enabled = this.enabled();
    const complete = enabled && numbers.every((n) => n.state === 'ours' || n.state === 'sms_off');
    this.repo.setSetting(COMPLETE_KEY, complete ? '1' : '0');
    return {
      enabled,
      url: enabled ? this.repo.getSetting(URL_KEY) : null,
      lastCallAt: this.lastCallAt(),
      complete,
      publicUrl: this.deps.publicOrigin,
      safetyMinutes: SAFETY_INTERVAL_MS / 60_000,
      numbers,
    };
  }

  /**
   * Points the callback of every number with SMS on at this portal. A number
   * that already calls another address keeps it unless listed in `replace`;
   * what it had is kept, to give it back when webhooks are turned off.
   * `origin`: the browser's, used when PUBLIC_URL is not set.
   */
  async enable(origin: string | null, replace: string[]): Promise<WebhookStatusDto> {
    const client = this.client();
    const base = this.deps.publicOrigin ?? origin;
    // VoIP.ms must reach the address from the Internet, and the secret must not travel in clear.
    if (!base?.startsWith('https://')) throw new WebhookError('webhook_needs_https');
    let token = this.repo.getSetting(TOKEN_KEY);
    if (!token) {
      token = crypto.randomBytes(24).toString('base64url');
      this.repo.setSetting(TOKEN_KEY, token);
    }
    const url = new URL(CALLBACK_PATH + token, base).href;
    // VoIP.ms answers first: refused (an IP not allowed, say), nothing changes.
    const dids = await client.getDids();
    this.repo.setSetting(URL_KEY, url);
    this.repo.setSetting(ENABLED_KEY, '1');

    const previous = this.previous();
    const errors = new Map<string, string>();
    for (const d of dids) {
      const did = normalizePhone(d.did);
      if (!this.repo.allowsDid(did) || !d.smsEnabled || d.callback?.url === url) continue;
      // A former address of this portal (another domain, say) is replaced without asking.
      const other = d.callback && !isOurs(d.callback.url, token) ? d.callback : null;
      if (other && !replace.includes(did)) continue;
      try {
        await client.setCallback(d.did, { url, retry: true });
        if (other) previous[did] = other;
      } catch (err) {
        if (!(err instanceof VoipMsError)) throw err;
        errors.set(did, err.code);
      }
    }
    this.repo.setSetting(PREVIOUS_KEY, JSON.stringify(previous));
    return this.status(errors);
  }

  /**
   * Back to checking on a schedule: the numbers calling this portal get back
   * the callback they had, or none. Checks speed up again even if VoIP.ms
   * refuses some changes; those numbers keep calling, which does no harm.
   */
  async disable(): Promise<WebhookStatusDto> {
    const client = this.client();
    this.repo.deleteSetting(ENABLED_KEY);
    this.repo.deleteSetting(COMPLETE_KEY);
    const token = this.repo.getSetting(TOKEN_KEY);
    const previous = this.previous();
    const errors = new Map<string, string>();
    for (const d of await client.getDids()) {
      const did = normalizePhone(d.did);
      if (!token || !d.callback || !isOurs(d.callback.url, token)) continue;
      try {
        await client.setCallback(d.did, previous[did] ?? null);
        delete previous[did];
      } catch (err) {
        if (!(err instanceof VoipMsError)) throw err;
        errors.set(did, err.code);
      }
    }
    this.repo.setSetting(PREVIOUS_KEY, JSON.stringify(previous));
    return this.status(errors);
  }

  private client(): VoipMsApi {
    const client = this.deps.getClient();
    if (!client) throw new WebhookError('not_configured', 409);
    return client;
  }

  private lastCallAt(): number | null {
    const value = this.repo.getSetting(LAST_CALL_KEY);
    return value ? Number(value) : null;
  }

  private previous(): Record<string, SmsCallback> {
    try {
      const value = JSON.parse(this.repo.getSetting(PREVIOUS_KEY) ?? '{}') as unknown;
      return value && typeof value === 'object' ? (value as Record<string, SmsCallback>) : {};
    } catch {
      return {};
    }
  }
}

/** A callback address of this portal: its path ends with the secret, whatever the domain. */
function isOurs(url: string, token: string): boolean {
  try {
    return new URL(url).pathname === CALLBACK_PATH + token;
  } catch {
    return false;
  }
}

function sameSecret(given: string, expected: string): boolean {
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
