import fs from 'node:fs';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Services } from '../app.js';
import { isInlineSafe } from '../media.js';
import { SendError, type OutgoingFile } from '../send.js';
import { normalizePhone } from '../../shared/phone.js';
import type { ConversationDto, DidDto, MessageDto, SyncStatusDto } from '../../shared/types.js';

const IdParams = z.object({ id: z.coerce.number().int().positive() });

const DidPatch = z.object({
  label: z.string().max(40).nullable().optional(),
  color: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/)
    .optional(),
  visible: z.boolean().optional(),
  position: z.number().int().min(0).max(1000).optional(),
});

const ConversationQuery = z.object({
  did: z.string().optional(),
  q: z.string().max(200).optional(),
  /** "1": archived only, "0": main list only; by default a search looks through both. */
  archived: z.enum(['0', '1']).optional(),
});

const ConversationPatch = z.object({ archived: z.boolean() });

const LookupQuery = z.object({ did: z.string(), phone: z.string() });

const ClientId = z.string().regex(/^[\w-]{8,64}$/);
const TabQuery = z.object({ device: ClientId.optional(), tab: ClientId.optional(), visible: z.enum(['0', '1']).optional() });
const PresenceBody = z.object({ tab: ClientId, visible: z.boolean() });

const MessagesQuery = z.object({
  before: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});

/** What MMS carriers accept: pictures, video, audio clips and contact cards. */
const SENDABLE = /^(image|video|audio)\/[\w.+-]+$|^text\/(x-)?vcard$/;

export function registerMessagingRoutes(app: FastifyInstance, s: Services): void {
  // ------------------------------------------------------------------ numbers

  app.get('/api/dids', async (): Promise<DidDto[]> => s.repo.listDids());

  app.patch('/api/dids/:did', async (req, reply): Promise<DidDto | void> => {
    const { did } = z.object({ did: z.string() }).parse(req.params);
    const patch = DidPatch.parse(req.body);
    if (!s.repo.updateDid(did, patch)) return reply.code(404).send({ error: 'not_found' });
    s.events.broadcast({ type: 'dids' });
    s.events.broadcast({ type: 'reload' });
    return s.repo.getDid(did)!;
  });

  // ------------------------------------------------------------ conversations

  app.get('/api/conversations', async (req): Promise<ConversationDto[]> => {
    const { did, q, archived } = ConversationQuery.parse(req.query);
    return s.repo.listConversations({
      did: did || undefined,
      query: q,
      archived: archived === undefined ? undefined : archived === '1',
    });
  });

  app.get('/api/conversations/lookup', async (req) => {
    const { did, phone } = LookupQuery.parse(req.query);
    const id = s.repo.findConversation(normalizePhone(did), normalizePhone(phone));
    return { conversation: id ? s.repo.getConversation(id) : null };
  });

  app.get('/api/conversations/:id', async (req, reply): Promise<ConversationDto | void> => {
    const { id } = IdParams.parse(req.params);
    const conversation = s.repo.getConversation(id);
    if (!conversation) return reply.code(404).send({ error: 'not_found' });
    return conversation;
  });

  app.patch('/api/conversations/:id', async (req, reply): Promise<ConversationDto | void> => {
    const { id } = IdParams.parse(req.params);
    const { archived } = ConversationPatch.parse(req.body);
    if (!s.repo.setArchived(id, archived)) return reply.code(404).send({ error: 'not_found' });
    const conversation = s.repo.getConversation(id)!;
    s.events.broadcast({ type: 'conversation', conversation });
    s.events.broadcast({ type: 'dids' });
    return conversation;
  });

  app.get('/api/conversations/:id/messages', async (req, reply): Promise<MessageDto[] | void> => {
    const { id } = IdParams.parse(req.params);
    const { before, limit } = MessagesQuery.parse(req.query);
    if (!s.repo.getConversation(id)) return reply.code(404).send({ error: 'not_found' });
    return s.repo.listMessages(id, { beforeId: before, limit });
  });

  app.post('/api/conversations/:id/read', async (req, reply) => {
    const { id } = IdParams.parse(req.params);
    const conversation = s.repo.getConversation(id);
    if (!conversation) return reply.code(404).send({ error: 'not_found' });
    if (s.repo.markConversationRead(id)) {
      s.events.broadcast({ type: 'conversation', conversation: s.repo.getConversation(id)! });
      s.events.broadcast({ type: 'dids' });
    }
    return { ok: true };
  });

  // ----------------------------------------------------------------- messages

  /** multipart/form-data: did, to, body and up to 3 "files". */
  app.post('/api/messages', async (req, reply) => {
    const fields: Record<string, string> = {};
    const files: OutgoingFile[] = [];
    for await (const part of req.parts()) {
      if (part.type === 'file') {
        const mime = part.mimetype.toLowerCase();
        if (!SENDABLE.test(mime)) {
          await part.toBuffer().catch(() => undefined);
          throw new SendError('unsupported_attachment');
        }
        files.push({ buffer: await part.toBuffer(), mime });
      } else {
        fields[part.fieldname] = String(part.value);
      }
    }
    const result = await s.sender.queue({
      did: fields.did ?? '',
      to: fields.to ?? '',
      body: fields.body ?? '',
      files,
    });
    return reply.code(202).send(result);
  });

  app.post('/api/messages/:id/retry', async (req) => {
    const { id } = IdParams.parse(req.params);
    return s.sender.retry(id);
  });

  app.get('/api/media/:id', async (req, reply) => {
    const { id } = IdParams.parse(req.params);
    const row = s.repo.getAttachment(id);
    if (!row || row.status !== 'ready' || !row.file_name) return reply.code(404).send({ error: 'not_found' });
    const file = s.media.filePath(row.file_name);
    if (!fs.existsSync(file)) return reply.code(404).send({ error: 'not_found' });
    const mime = row.mime ?? 'application/octet-stream';
    const ext = row.file_name.split('.').pop();
    reply
      .header('Content-Type', mime)
      .header('Cache-Control', 'private, max-age=31536000, immutable')
      // Received files are untrusted: never let one run script on this origin.
      .header('Content-Security-Policy', "default-src 'none'; img-src 'self' data:; media-src 'self'; style-src 'unsafe-inline'; sandbox")
      .header('Content-Disposition', `${isInlineSafe(row.mime) ? 'inline' : 'attachment'}; filename="attachment-${row.id}.${ext}"`);
    return reply.send(fs.createReadStream(file));
  });

  app.post('/api/media/:id/retry', async (req, reply) => {
    const { id } = IdParams.parse(req.params);
    if (!s.repo.resetAttachment(id)) return reply.code(404).send({ error: 'not_found' });
    s.media.kick();
    const row = s.repo.getAttachment(id)!;
    const message = s.repo.getMessage(row.message_id);
    const conversation = message ? s.repo.getConversation(message.conversationId) : null;
    if (message && conversation) s.events.broadcast({ type: 'message', message, conversation });
    return { ok: true };
  });

  // --------------------------------------------------------------------- sync

  app.get('/api/sync/status', async (): Promise<SyncStatusDto> => s.sync.status());

  app.post('/api/sync/now', async () => {
    s.sync.trigger(0);
    return s.sync.status();
  });

  /** A tab reports being shown or hidden, so push notifications skip the device it is on screen on. */
  app.post('/api/presence', async (req) => {
    const { tab, visible } = PresenceBody.parse(req.body);
    return { ok: s.events.setVisibility(tab, visible) };
  });

  app.get('/api/events', (req, reply) => {
    const tab = TabQuery.safeParse(req.query);
    reply.hijack();
    s.events.attach(
      reply.raw,
      tab.success ? { device: tab.data.device, tab: tab.data.tab, visible: tab.data.visible !== '0' } : {},
    );
    reply.raw.write(`data: ${JSON.stringify({ type: 'sync', status: s.sync.status() })}\n\n`);
    req.raw.on('close', () => reply.raw.end());
  });
}
