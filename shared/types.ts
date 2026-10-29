/** Shapes exchanged between the server's REST/SSE API and the web client. */

import type { ContactIcon } from './contact.js';
import type { MessageKind } from './message.js';

export type Direction = 'in' | 'out';
export type MessageStatus = 'received' | 'sending' | 'sent' | 'failed';
export type AttachmentStatus = 'pending' | 'ready' | 'failed';
export type CredentialsSource = 'env' | 'db' | null;
/**
 * How open tabs receive live updates: one Server-Sent Events stream each, or
 * by polling /api/events/poll, for proxies and hosts that cannot hold a
 * stream open (shared PHP hosting).
 */
export type LiveUpdates = 'stream' | 'poll';

export interface SessionDto {
  authenticated: boolean;
  setupCompleted: boolean;
  credentialsSource: CredentialsSource;
  demo: boolean;
  version: string;
  /** Polling periods, in seconds, shown in the UI. */
  pollActiveSeconds: number;
  pollIdleSeconds: number;
  liveUpdates: LiveUpdates;
  /** Whether the server's configuration leaves some of the account's numbers out (ALLOWED_DIDS, EXCLUDED_DIDS). */
  didsRestricted: boolean;
}

export interface DidDto {
  did: string;
  /** User-chosen nickname ("Perso", "Bureau"...). */
  label: string | null;
  color: string;
  visible: boolean;
  smsEnabled: boolean;
  /** Whether VoIP.ms offers SMS on the number at all; when it does, the portal can turn it on. */
  smsAvailable: boolean;
  mmsAvailable: boolean;
  /** VoIP.ms description, usually the rate center ("Le Gardeur, QC"). */
  description: string | null;
  position: number;
  unreadCount: number;
  /** The VoIP.ms account the number belongs to (1: the one set up first). */
  accountId: number;
}

export interface AttachmentDto {
  id: number;
  mime: string | null;
  size: number | null;
  status: AttachmentStatus;
  /** Same-origin URL serving the stored file, null until downloaded. */
  url: string | null;
}

export interface MessageDto {
  id: number;
  conversationId: number;
  kind: MessageKind;
  direction: Direction;
  body: string;
  sentAt: number;
  status: MessageStatus;
  /** VoIP.ms error code when status is "failed". */
  error: string | null;
  carrierStatus: string | null;
  attachments: AttachmentDto[];
}

export interface ContactRef {
  id: number;
  name: string;
  /** Avatar color chosen for the contact; null for the one its number gives. */
  color: string | null;
  /** Icon shown instead of the initials; null for the initials. */
  icon: ContactIcon | null;
}

export interface ConversationDto {
  id: number;
  did: string;
  phone: string;
  contact: ContactRef | null;
  unreadCount: number;
  /** Hidden from the main list until a new message arrives. */
  archived: boolean;
  lastMessageAt: number | null;
  lastMessage: {
    body: string;
    direction: Direction;
    status: MessageStatus;
    attachmentCount: number;
  } | null;
}

export interface ContactDto extends ContactRef {
  notes: string | null;
  phones: string[];
}

export interface SyncStatusDto {
  state: 'disabled' | 'idle' | 'syncing' | 'error';
  mode: 'active' | 'idle';
  /** Last successful sync. */
  lastSyncAt: number | null;
  /** Last attempt, successful or not: shows that checks keep running even while VoIP.ms refuses them. */
  lastCheckAt: number | null;
  lastError: string | null;
  importing: { done: number; total: number } | null;
  /**
   * Servers without a process of their own (the PHP version) check VoIP.ms
   * from a cron job while no tab is open: when it last ran, and the command
   * to schedule.
   */
  cron?: { lastRunAt: number | null; command: string };
  /** Texts announced by VoIP.ms's URL callback (null: VoIP.ms is checked on a schedule only). */
  webhook: WebhookSummaryDto | null;
}

export interface WebhookSummaryDto {
  /** Last call from VoIP.ms. */
  lastCallAt: number | null;
  /** Every number with SMS on calls back: checks are then down to the safety net. */
  complete: boolean;
}

/** A number's SMS URL callback at VoIP.ms, as the portal sees it. */
export interface WebhookNumberDto {
  did: string;
  /**
   * ours: calls this portal. other: calls another address, left alone unless
   * replaced. none: no callback. sms_off: SMS is off, nothing to call back.
   */
  state: 'ours' | 'other' | 'none' | 'sms_off';
  /** The other address, to decide whether to replace it. */
  otherUrl: string | null;
  /** Why VoIP.ms refused the last change (sms_wait_message: try again in a minute). */
  error: string | null;
}

export interface WebhookStatusDto {
  enabled: boolean;
  /** The address VoIP.ms calls (it holds the secret). */
  url: string | null;
  lastCallAt: number | null;
  complete: boolean;
  /** PUBLIC_URL's origin, used for the address when set; otherwise the browser's. */
  publicUrl: string | null;
  /** Minutes between the checks that still run, for callbacks VoIP.ms never made and texts sent from other apps. */
  safetyMinutes: number;
  numbers: WebhookNumberDto[];
}

/** A VoIP.ms account the portal uses; the first one (id 1) is the one the setup wizard sets up. */
export interface AccountDto {
  id: number;
  label: string | null;
  /** The account's email at VoIP.ms; null when its credentials cannot be read (APP_PASSWORD changed). */
  username: string | null;
  credentialsSource: CredentialsSource;
  numbers: number;
}

export interface SetupStatusDto {
  completed: boolean;
  credentialsSource: CredentialsSource;
  username: string | null;
}

export interface ConnectionTestDto {
  /** Public IP VoIP.ms sees for this server, i.e. the one to whitelist. */
  ip: string | null;
  /** "success" or a VoIP.ms error code (invalid_credentials, ip_not_enabled, api_not_enabled...). */
  status: string;
  balance: number | null;
}

export type ServerEvent =
  | { type: 'message'; message: MessageDto; conversation: ConversationDto }
  | { type: 'conversation'; conversation: ConversationDto }
  /** Messages deleted; the conversation as it is now (no last message once all of them are gone). */
  | { type: 'deleted'; conversation: ConversationDto; messageIds: number[] }
  | { type: 'sync'; status: SyncStatusDto }
  /** Many conversations changed at once (history import): reload the list. */
  | { type: 'reload' }
  | { type: 'dids' }
  | { type: 'contacts' };

/** How this server was installed, which decides how it updates. */
export type InstallKind = 'docker' | 'source' | 'php';

/** A published version, from its release.json (scripts/release-manifest.mjs). */
export interface ReleaseDto {
  version: string;
  publishedAt: string | null;
  /** Its page on GitHub. */
  url: string;
  /** Its changelog section (Markdown bullets). */
  notes: string;
}

/** GET /api/update */
export interface UpdateStatusDto {
  current: string;
  install: InstallKind;
  /** False when UPDATE_CHECK is off: nothing is asked of GitHub. */
  enabled: boolean;
  /** The newest release as of the last check. */
  latest: ReleaseDto | null;
  /** The newest release is newer than this server. */
  available: boolean;
  checkedAt: number | null;
  /** Why the last check failed (unreachable, invalid_manifest...); null when it worked. */
  error: string | null;
  /** The PHP version can replace its own files (POST /api/update/install). */
  canInstall: boolean;
  /** Why it cannot, when it is the PHP version: not_packaged, not_writable, no_unzip. */
  blocked: string | null;
  /** Files or folders it cannot write to, when blocked is "not_writable". */
  paths?: string[];
}

/** GET /api/events/poll: the events since `after`, the same ones the stream sends. */
export interface EventsPollDto {
  /** Opaque; passed back as `after` on the next poll. */
  cursor: string;
  events: ServerEvent[];
  /**
   * The events since `after` are no longer known (the server restarted, or
   * too much happened since): reload everything instead.
   */
  reset: boolean;
}

export interface ApiErrorBody {
  error: string;
  message?: string;
}
