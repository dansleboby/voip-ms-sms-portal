import { describe, expect, it } from 'vitest';
import { isInlineSafe } from './media.js';
import { parseVCards } from './vcard.js';

describe('parseVCards', () => {
  it('unfolds long lines and keeps only North American numbers', () => {
    const text = [
      'BEGIN:VCARD',
      'VERSION:4.0',
      'FN:Jean-Fran',
      ' çois Côté',
      'item1.TEL;type=CELL:tel:+1-514-555-0100',
      'TEL;TYPE=HOME:+44 20 7946 0958',
      'END:VCARD',
    ].join('\n');
    expect(parseVCards(text)).toEqual([{ name: 'Jean-François Côté', phones: ['5145550100'] }]);
  });

  it('falls back to N then ORG for the name', () => {
    const text = 'BEGIN:VCARD\nN:Doe;Jane;;;\nTEL:4385550100\nEND:VCARD\nBEGIN:VCARD\nORG:Pizzeria Roma;Livraison\nTEL:4505550100\nEND:VCARD';
    expect(parseVCards(text).map((c) => c.name)).toEqual(['Jane Doe', 'Pizzeria Roma']);
  });
});

describe('isInlineSafe', () => {
  it('only lets pictures, video and audio render inline', () => {
    expect(isInlineSafe('image/jpeg')).toBe(true);
    expect(isInlineSafe('video/mp4')).toBe(true);
    expect(isInlineSafe('image/svg+xml')).toBe(false);
    expect(isInlineSafe('text/html')).toBe(false);
    expect(isInlineSafe(null)).toBe(false);
  });
});

describe('media downloads', () => {
  it('back off after a failure instead of retrying on every poll', async () => {
    const { openDatabase, Repo } = await import('./db.js');
    const { MediaStore } = await import('./media.js');
    const { silentLogger } = await import('./logger.js');
    const fs = await import('node:fs');
    const os = await import('node:os');
    const path = await import('node:path');
    const repo = new Repo(openDatabase(':memory:'));
    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      return new Response('error code: 522', { status: 522 });
    }) as unknown as typeof fetch;
    const store = new MediaStore(fs.mkdtempSync(path.join(os.tmpdir(), 'media-')), repo, { log: silentLogger, fetch: fetchImpl });
    await store.init();
    const conversationId = repo.getOrCreateConversation('4506575294', '4383980707');
    const messageId = repo.insertMessage({ conversationId, kind: 'mms', remoteId: '1', direction: 'in', body: '', sentAt: 0, status: 'received' });
    const id = repo.insertAttachment(messageId, 0, { remoteUrl: 'https://voip.ms/media/x/media.png', status: 'pending' });
    const settle = async () => {
      for (let i = 0; i < 50; i++) await new Promise((r) => setTimeout(r, 5));
    };
    store.kick();
    await settle();
    store.kick();
    store.kick();
    await settle();
    expect(calls).toBe(1);
    const row = repo.getAttachment(id)!;
    expect(row).toMatchObject({ status: 'pending', attempts: 1 });
    expect(row.next_attempt_at).toBeGreaterThan(Date.now());
    repo.updateAttachment(id, { status: 'failed' });
    expect(repo.resetAttachment(id)).toBe(true);
    expect(repo.getAttachment(id)).toMatchObject({ status: 'pending', attempts: 0, next_attempt_at: 0 });
  });
});
