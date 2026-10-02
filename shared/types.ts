/** Shapes exchanged between the server's REST/SSE API and the web client. */

import type { MessageKind } from './message.js';

export type Direction = 'in' | 'out';
export type MessageStatus = 'received' | 'sending' | 'sent' | 'failed';
export type AttachmentStatus = 'pending' | 'ready' | 'failed';
export type CredentialsSource = 'env' | 'db' | null;

export interface SessionDto {
  authenticated: boolean;
  setupCompleted: boolean;
  credentialsSource: CredentialsSource;
  demo: boolean;
  version: string;
  /** Polling periods, in seconds, shown in the UI. */
  pollActiveSeconds: number;
  pollIdleSeconds: number;
}

export interface DidDto {
  did: string;
  /** User-chosen nickname ("Perso", "Bureau"...). */
  label: string | null;
  color: string;
  visible: boolean;
  smsEnabled: boolean;
  mmsAvailable: boolean;
  /** VoIP.ms description, usually the rate center ("Le Gardeur, QC"). */
  description: string | null;
  position: number;
  unreadCount: number;
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
}

export interface ConversationDto {
  id: number;
  did: string;
  phone: string;
  contact: ContactRef | null;
  unreadCount: number;
  lastMessageAt: number | null;
  lastMessage: {
    body: string;
    direction: Direction;
    status: MessageStatus;
    attachmentCount: number;
  } | null;
}

export interface ContactDto {
  id: number;
  name: string;
  notes: string | null;
  phones: string[];
}

export interface SyncStatusDto {
  state: 'disabled' | 'idle' | 'syncing' | 'error';
  mode: 'active' | 'idle';
  lastSyncAt: number | null;
  lastError: string | null;
  importing: { done: number; total: number } | null;
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
  | { type: 'sync'; status: SyncStatusDto }
  /** Many conversations changed at once (history import): reload the list. */
  | { type: 'reload' }
  | { type: 'dids' }
  | { type: 'contacts' };

export interface ApiErrorBody {
  error: string;
  message?: string;
}
