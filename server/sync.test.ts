import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { openDatabase, Repo } from './db.js';
import { EventHub } from './events.js';
import { silentLogger } from './logger.js';
import { MediaStore } from './media.js';
import { SyncEngine } from './sync.js';
import { zonedToEpoch } from './time.js';
import { FakeVoipMs } from './test/fake-client.js';
import type { ServerEvent } from '../shared/types.js';

const TZ = 'America/New_York';
const NOW = zonedToEpoch('2026-10-02 15:00:00', TZ);

function setup() {
  const repo = new Repo(openDatabase(':memory:'));
  const events = new EventHub();
  const broadcast: ServerEvent[] = [];
  events.broadcast = (e) => void broadcast.push(e);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-test-'));
  const media = new MediaStore(dir, repo, { log: silentLogger, fetch: (async () => new Response('x')) as unknown as typeof fetch });
  media.kick = () => {};
  const client = new FakeVoipMs();
  client.defaultDate = '2026-10-02 14:24:20';
  const sync = new SyncEngine({
    repo,
    events,
    media,
    getClient: () => client,
    isEnabled: () => true,
    timeZone: TZ,
    pollActiveMs: 10_000,
    pollIdleMs: 60_000,
    log: silentLogger,
    now: () => NOW,
  });
  return { repo, client, sync, broadcast };
}

describe('SyncEngine', () => {
  let ctx: ReturnType<typeof setup>;
  beforeEach(() => {
    ctx = setup();
  });

  it('treats the very first sync as a quiet baseline', async () => {
    ctx.client.push({ direction: 'in', body: 'Old news', date: '2026-10-02 09:00:00' });
    await ctx.sync.syncRecent();
    const [conversation] = ctx.repo.listConversations();
    expect(conversation).toMatchObject({ phone: '4383980707', did: '4506575294', unreadCount: 0 });
    expect(ctx.broadcast.some((e) => e.type === 'message')).toBe(false);
    expect(ctx.broadcast.some((e) => e.type === 'reload')).toBe(true);
  });

  it('stores new incoming messages as unread, once', async () => {
    await ctx.sync.syncRecent();
    ctx.client.push({ direction: 'in', body: 'Salut!', date: '2026-10-02 14:59:00' });
    await ctx.sync.syncRecent();
    await ctx.sync.syncRecent();
    const conversations = ctx.repo.listConversations();
    expect(conversations).toHaveLength(1);
    expect(conversations[0]!.unreadCount).toBe(1);
    const messages = ctx.repo.listMessages(conversations[0]!.id);
    expect(messages).toHaveLength(1);
    expect(messages[0]!.sentAt).toBe(zonedToEpoch('2026-10-02 14:59:00', TZ));
    expect(ctx.broadcast.filter((e) => e.type === 'message')).toHaveLength(1);
  });

  it('keeps SMS and MMS ids apart', async () => {
    ctx.client.push({ kind: 'sms', id: '42', direction: 'in', body: 'sms' });
    ctx.client.push({ kind: 'mms', id: '42', direction: 'in', body: 'mms', media: ['https://voip.ms/media/a/media.png'] });
    await ctx.sync.syncRecent();
    const [conversation] = ctx.repo.listConversations();
    const messages = ctx.repo.listMessages(conversation!.id);
    expect(messages.map((m) => m.kind).sort()).toEqual(['mms', 'sms']);
    const mms = messages.find((m) => m.kind === 'mms')!;
    expect(mms.attachments).toEqual([expect.objectContaining({ status: 'pending', url: null })]);
  });

  it('records messages sent from elsewhere and follows carrier status', async () => {
    await ctx.sync.syncRecent();
    const sent = ctx.client.push({ direction: 'out', body: 'Sent from my phone' });
    await ctx.sync.syncRecent();
    sent.carrierStatus = 'Delivered';
    await ctx.sync.syncRecent();
    const [conversation] = ctx.repo.listConversations();
    expect(conversation!.unreadCount).toBe(0);
    const [message] = ctx.repo.listMessages(conversation!.id);
    expect(message).toMatchObject({ direction: 'out', status: 'sent', carrierStatus: 'Delivered' });
  });

  it('attaches a remote message to a local send that failed ambiguously', async () => {
    await ctx.sync.syncRecent();
    const conversationId = ctx.repo.getOrCreateConversation('4506575294', '4383980707');
    const localId = ctx.repo.insertMessage({
      conversationId,
      kind: 'sms',
      remoteId: null,
      direction: 'out',
      body: 'Did this go through?',
      sentAt: zonedToEpoch('2026-10-02 14:50:00', TZ),
      status: 'sent',
    });
    ctx.repo.updateMessage(localId, { status: 'failed', error: 'http_error' });
    ctx.client.push({ direction: 'out', body: 'Did this go through?', date: '2026-10-02 14:50:02', id: '777' });
    await ctx.sync.syncRecent();
    const messages = ctx.repo.listMessages(conversationId);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ id: localId, status: 'sent', error: null });
  });

  it('widens the window after a downtime', async () => {
    ctx.repo.setSetting('sync.lastSuccessAt', String(NOW - 10 * 86_400_000));
    await ctx.sync.syncRecent();
    const sms = ctx.client.queries.find((q) => q.kind === 'sms')!;
    expect(sms.query.from).toBe('2026-09-21');
    expect(sms.query.to).toBe('2026-10-03');
  });

  it('reports errors and recovers', async () => {
    ctx.client.failNext.getMessages = 'ip_not_enabled';
    await ctx.sync.syncRecent();
    expect(ctx.sync.status()).toMatchObject({ state: 'error', lastError: 'ip_not_enabled' });
    await ctx.sync.syncRecent();
    expect(ctx.sync.status()).toMatchObject({ state: 'idle', lastError: null });
  });

  it('does not let a history import swallow texts newer than the last poll', async () => {
    await ctx.sync.syncRecent();
    ctx.repo.setSetting('sync.lastSuccessAt', String(NOW - 5 * 60_000));
    ctx.client.push({ direction: 'in', body: 'Just arrived', date: '2026-10-02 14:58:00' });
    ctx.client.push({ direction: 'in', body: 'Old one', date: '2026-08-01 10:00:00', contact: '5145550000' });
    await ctx.sync.importHistory(90);
    const byPhone = new Map(ctx.repo.listConversations().map((c) => [c.phone, c]));
    expect(byPhone.get('4383980707')!.unreadCount).toBe(1);
    expect(byPhone.get('5145550000')!.unreadCount).toBe(0);
    expect(ctx.broadcast.some((e) => e.type === 'message' && e.message.body === 'Just arrived')).toBe(true);
  });

  it('never adopts a message that is still waiting to be sent, nor one of another kind', async () => {
    await ctx.sync.syncRecent();
    const conversationId = ctx.repo.getOrCreateConversation('4506575294', '4383980707');
    const sentAt = zonedToEpoch('2026-10-02 14:50:00', TZ);
    const queued = ctx.repo.insertMessage({ conversationId, kind: 'sms', remoteId: null, direction: 'out', body: 'ok', sentAt, status: 'sending' });
    const failedMms = ctx.repo.insertMessage({ conversationId, kind: 'mms', remoteId: null, direction: 'out', body: 'ok', sentAt, status: 'failed' });
    ctx.client.push({ kind: 'sms', direction: 'out', body: 'ok', date: '2026-10-02 14:50:30' });
    await ctx.sync.syncRecent();
    expect(ctx.repo.getMessage(queued)!.status).toBe('sending');
    expect(ctx.repo.getMessage(failedMms)!.status).toBe('failed');
    expect(ctx.repo.listMessages(conversationId)).toHaveLength(3);
  });

  it('imports history quietly', async () => {
    ctx.client.push({ direction: 'in', body: 'Summer', date: '2026-07-15 10:00:00' });
    ctx.client.push({ direction: 'in', body: 'Spring', date: '2026-04-15 10:00:00', contact: '5145550000' });
    await ctx.sync.importHistory(200);
    const conversations = ctx.repo.listConversations();
    expect(conversations).toHaveLength(2);
    expect(conversations.every((c) => c.unreadCount === 0)).toBe(true);
    expect(ctx.sync.status().importing).toBeNull();
  });
});
