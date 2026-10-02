import type { Repo } from './db.js';
import type { EventHub } from './events.js';
import type { Logger } from './logger.js';
import type { MediaStore } from './media.js';
import type { SyncEngine } from './sync.js';
import { VoipMsError, type VoipMsApi } from './voipms/client.js';
import { checkOutgoing, MAX_ATTACHMENT_BYTES } from '../shared/message.js';
import { isValidNanp, normalizePhone } from '../shared/phone.js';
import type { ConversationDto, MessageDto } from '../shared/types.js';

export class SendError extends Error {
  constructor(
    readonly code: string,
    readonly statusCode = 400,
  ) {
    super(code);
  }
}

export interface OutgoingFile {
  buffer: Buffer;
  mime: string;
}

export interface SendDeps {
  repo: Repo;
  events: EventHub;
  media: MediaStore;
  sync: SyncEngine;
  getClient: () => VoipMsApi | null;
  log: Logger;
}

/**
 * Records an outgoing message right away (status "sending") and delivers it
 * through VoIP.ms in the background; the UI follows along over SSE.
 */
export class MessageSender {
  constructor(private readonly deps: SendDeps) {}

  async queue(input: { did: string; to: string; body: string; files: OutgoingFile[] }): Promise<{
    message: MessageDto;
    conversation: ConversationDto;
  }> {
    const { repo, media } = this.deps;
    const did = normalizePhone(input.did);
    const to = normalizePhone(input.to);
    const didInfo = repo.getDid(did);
    if (!didInfo) throw new SendError('unknown_did');
    if (!didInfo.smsEnabled) throw new SendError('sms_not_enabled');
    if (!isValidNanp(to)) throw new SendError('invalid_destination');
    for (const file of input.files) {
      if (file.buffer.length > MAX_ATTACHMENT_BYTES) throw new SendError('attachment_too_large');
    }
    const body = input.body.replace(/\r\n/g, '\n');
    const check = checkOutgoing(body, input.files.length);
    if (check.problem) throw new SendError(check.problem);
    if (check.kind === 'mms' && !didInfo.mmsAvailable) throw new SendError('mms_not_available');

    const saved = await Promise.all(input.files.map((f) => media.save(f.buffer, f.mime)));
    const { messageId, conversationId } = repo.transaction(() => {
      const conversationId = repo.getOrCreateConversation(did, to);
      const messageId = repo.insertMessage({
        conversationId,
        kind: check.kind,
        remoteId: null,
        direction: 'out',
        body,
        sentAt: Date.now(),
        status: 'sending',
      });
      saved.forEach((file, i) => repo.insertAttachment(messageId, i, { ...file, status: 'ready' }));
      repo.touchConversation(conversationId);
      return { messageId, conversationId };
    });

    const result = this.publish(messageId, conversationId);
    void this.deliver(messageId);
    return result;
  }

  async retry(messageId: number): Promise<MessageDto> {
    const row = this.deps.repo.getMessageRow(messageId);
    if (!row || row.direction !== 'out') throw new SendError('not_found', 404);
    if (row.status !== 'failed') throw new SendError('not_failed', 409);
    this.deps.repo.updateMessage(messageId, { status: 'sending', error: null });
    const { message } = this.publish(messageId, row.conversation_id);
    void this.deliver(messageId);
    return message;
  }

  /** Sends through VoIP.ms. Never throws: failures end up on the message. */
  async deliver(messageId: number): Promise<void> {
    const { repo, sync, media, log } = this.deps;
    await sync.exclusive(async () => {
      const row = repo.getMessageRow(messageId);
      if (!row || row.status !== 'sending') return;
      const conversation = repo.getConversation(row.conversation_id);
      const client = this.deps.getClient();
      try {
        if (!conversation) throw new VoipMsError('not_found');
        if (!client) throw new VoipMsError('not_configured');
        let kind = row.kind;
        let remoteId: string | null = null;
        if (kind === 'sms') {
          try {
            remoteId = await client.sendSms(conversation.did, conversation.phone, row.body);
          } catch (err) {
            // Our byte count should prevent this; if VoIP.ms disagrees, MMS has room for it.
            if (!(err instanceof VoipMsError && err.code === 'sms_toolong')) throw err;
            kind = 'mms';
          }
        }
        if (kind === 'mms') {
          const attachments = repo.listAttachments(messageId);
          const dataUris = await Promise.all(attachments.map((a) => media.toDataUri(a)));
          remoteId = await client.sendMms(conversation.did, conversation.phone, row.body, dataUris);
        }
        repo.updateMessage(messageId, { kind, remoteId, status: 'sent', error: null });
      } catch (err) {
        const code = err instanceof VoipMsError ? err.code : 'internal_error';
        log.warn({ err, messageId }, 'Sending failed');
        repo.updateMessage(messageId, { status: 'failed', error: code });
      }
    });
    const row = repo.getMessageRow(messageId);
    if (row) this.publish(messageId, row.conversation_id);
  }

  private publish(messageId: number, conversationId: number): { message: MessageDto; conversation: ConversationDto } {
    const message = this.deps.repo.getMessage(messageId)!;
    const conversation = this.deps.repo.getConversation(conversationId)!;
    this.deps.events.broadcast({ type: 'message', message, conversation });
    return { message, conversation };
  }
}
