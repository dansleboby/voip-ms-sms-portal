import type { PushSubscriptionRow, Repo } from './db.js';
import type { EventHub } from './events.js';
import type { Logger } from './logger.js';
import { generateVapidKeys, sendPush, type VapidKeys } from './webpush.js';
import { formatPhone } from '../shared/phone.js';
import type { ConversationDto, MessageDto } from '../shared/types.js';

const VAPID_KEY = 'push.vapid';
const OWNER_KEY = 'push.owner';
/** Keeps the encrypted payload well under the 4 KB push services accept. */
const BODY_MAX_CHARS = 240;

export type PushLang = 'fr' | 'en';

const TEXT: Record<PushLang, { attachment: string; attachments: (n: number) => string; testTitle: string; testBody: string }> = {
  fr: {
    attachment: '📎 Pièce jointe',
    attachments: (n) => `📎 ${n} pièces jointes`,
    testTitle: 'Notifications activées',
    testBody: 'Les nouveaux textos s’afficheront ici, même quand l’application est fermée.',
  },
  en: {
    attachment: '📎 Attachment',
    attachments: (n) => `📎 ${n} attachments`,
    testTitle: 'Notifications are on',
    testBody: 'New texts will show up here, even when the app is closed.',
  },
};

/** What the service worker receives (see web/public/sw.js). */
export interface PushPayload {
  title: string;
  body: string;
  /** Notifications with the same tag replace each other: one per conversation. */
  tag: string;
  url: string;
  timestamp?: number;
  /** Unread texts in the shown conversations, for the badge on the installed app's icon. */
  unread?: number;
}

export interface PushDeps {
  repo: Repo;
  events: EventHub;
  log: Logger;
  subject: string;
  /** Changes with APP_PASSWORD (see CredentialStore.fingerprint). */
  ownerFingerprint: string;
  fetch?: typeof fetch;
}

export class PushError extends Error {
  constructor(
    readonly code: string,
    readonly status?: number,
  ) {
    super(code);
  }
}

/**
 * Sends Web Push notifications for new incoming texts to the browsers that
 * asked for them, skipping those where the app is currently on screen (the
 * page shows its own notification there).
 */
export class PushService {
  private readonly vapid: VapidKeys;

  constructor(private readonly deps: PushDeps) {
    const stored = deps.repo.getSetting(VAPID_KEY);
    if (stored) {
      this.vapid = JSON.parse(stored) as VapidKeys;
    } else {
      this.vapid = generateVapidKeys();
      deps.repo.setSetting(VAPID_KEY, JSON.stringify(this.vapid));
    }
    // Notifications show message previews: a new APP_PASSWORD revokes every browser, like sessions.
    if (deps.repo.getSetting(OWNER_KEY) !== deps.ownerFingerprint) {
      const dropped = deps.repo.deleteAllPushSubscriptions();
      if (dropped) deps.log.info({ count: dropped }, 'APP_PASSWORD changed: push subscriptions removed');
      deps.repo.setSetting(OWNER_KEY, deps.ownerFingerprint);
    }
  }

  get publicKey(): string {
    return this.vapid.publicKey;
  }

  /** New texts from a poll, grouped into one notification per conversation. */
  notifyIncoming(items: { messageId: number; conversationId: number }[]): void {
    const subscriptions = this.deps.repo.listPushSubscriptions();
    if (subscriptions.length === 0) return;
    // VoIP.ms lists newest first: the last one stored is not necessarily the latest.
    const latest = new Map<number, { messageId: number; sentAt: number; count: number }>();
    for (const { messageId, conversationId } of items) {
      const sentAt = this.deps.repo.getMessageRow(messageId)?.sent_at ?? 0;
      const entry = latest.get(conversationId);
      const newer = !entry || sentAt > entry.sentAt || (sentAt === entry.sentAt && messageId > entry.messageId);
      latest.set(conversationId, {
        messageId: newer ? messageId : entry.messageId,
        sentAt: newer ? sentAt : entry.sentAt,
        count: (entry?.count ?? 0) + 1,
      });
    }
    const dids = this.deps.repo.listDids();
    const multi = dids.filter((d) => d.visible).length > 1;
    // Archived conversations are already left out of these counts.
    const unread = dids.filter((d) => d.visible).reduce((n, d) => n + d.unreadCount, 0);
    for (const [conversationId, { messageId, count }] of latest) {
      const message = this.deps.repo.getMessage(messageId);
      const conversation = this.deps.repo.getConversation(conversationId);
      if (!message || !conversation) continue;
      const did = dids.find((d) => d.did === conversation.did);
      if (did && !did.visible) continue;
      const didLabel = multi ? did?.label || formatPhone(conversation.did) : null;
      for (const sub of subscriptions) {
        if (sub.device && this.deps.events.isOnScreen(sub.device)) continue;
        const payload = { ...messagePayload(message, conversation, count, didLabel, langOf(sub.lang)), unread };
        void this.deliver(sub, payload, `c${conversationId}`).catch((err: unknown) => {
          this.deps.log.warn({ err }, 'Push notification failed');
        });
      }
    }
  }

  /** Sends a sample notification to one browser; throws PushError when the push service refuses it. */
  async sendTest(endpoint: string): Promise<void> {
    const sub = this.deps.repo.getPushSubscription(endpoint);
    if (!sub) throw new PushError('not_subscribed');
    const text = TEXT[langOf(sub.lang)];
    const status = await this.deliver(sub, { title: text.testTitle, body: text.testBody, tag: 'test', url: '/settings' });
    if (status >= 300) throw new PushError('push_failed', status);
  }

  /** Returns the push service's status; forgets browsers that unsubscribed. */
  private async deliver(sub: PushSubscriptionRow, payload: PushPayload, topic?: string): Promise<number> {
    const status = await sendPush(sub, JSON.stringify(payload), {
      vapid: this.vapid,
      subject: this.deps.subject,
      urgency: 'high',
      topic,
      fetch: this.deps.fetch,
    });
    if (status === 404 || status === 410) {
      // The browser dropped the subscription (permission revoked, data cleared...).
      this.deps.repo.deletePushSubscription(sub.endpoint);
      this.deps.log.info({ status }, 'Push subscription expired and was removed');
    } else if (status >= 300) {
      this.deps.log.warn({ status, host: new URL(sub.endpoint).host }, 'Push service refused a notification');
    }
    return status;
  }
}

function langOf(value: string): PushLang {
  return value === 'en' ? 'en' : 'fr';
}

export function messagePayload(
  message: MessageDto,
  conversation: ConversationDto,
  count: number,
  didLabel: string | null,
  lang: PushLang,
): PushPayload {
  const text = TEXT[lang];
  const name = conversation.contact?.name || formatPhone(conversation.phone);
  const attachments = message.attachments.length;
  let body = message.body.trim();
  if (body.length > BODY_MAX_CHARS) body = `${[...body].slice(0, BODY_MAX_CHARS).join('')}…`;
  if (!body && attachments) body = attachments > 1 ? text.attachments(attachments) : text.attachment;
  if (didLabel) body = `${body}\n— ${didLabel}`;
  return {
    title: count > 1 ? `${name} (${count})` : name,
    body,
    tag: `conversation-${conversation.id}`,
    url: `/c/${conversation.id}`,
    timestamp: message.sentAt,
  };
}
