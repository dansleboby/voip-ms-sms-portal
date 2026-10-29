import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { Auth } from './auth.js';
import { accountKey, openDatabase, Repo } from './db.js';
import { CredentialStore } from './secrets.js';

describe('Auth', () => {
  const repo = new Repo(openDatabase(':memory:'));

  it('checks the password and verifies its own tokens', () => {
    const auth = new Auth(repo, 'pw', 30);
    expect(auth.checkPassword('pw')).toBe(true);
    expect(auth.checkPassword('PW')).toBe(false);
    const token = auth.issue();
    expect(auth.verify(token)).toBe(true);
    expect(auth.verify(token.slice(0, -2) + 'xx')).toBe(false);
    expect(auth.verify(undefined)).toBe(false);
  });

  it('expires tokens', () => {
    const auth = new Auth(repo, 'pw', 1);
    const issued = Date.now() - 2 * 86_400_000;
    expect(auth.verify(auth.issue(issued))).toBe(false);
  });

  it('invalidates sessions when APP_PASSWORD changes', () => {
    const token = new Auth(repo, 'old', 30).issue();
    expect(new Auth(repo, 'new', 30).verify(token)).toBe(false);
  });
});

describe('CredentialStore', () => {
  it('encrypts with a key derived from APP_PASSWORD', () => {
    const repo = new Repo(openDatabase(':memory:'));
    const store = new CredentialStore(repo, 'app-pw', null);
    store.save({ username: 'me@example.com', password: 'api-pw' });
    expect(repo.getSetting('voipms.credentials')).not.toContain('api-pw');
    expect(store.get()).toEqual({ username: 'me@example.com', password: 'api-pw' });
    expect(store.source()).toBe('db');
    expect(new CredentialStore(repo, 'other-pw', null).get()).toBeNull();
  });

  it('prefers environment credentials', () => {
    const repo = new Repo(openDatabase(':memory:'));
    const store = new CredentialStore(repo, 'app-pw', { username: 'env@example.com', password: 'p' });
    expect(store.source()).toBe('env');
    expect(() => store.save({ username: 'x', password: 'y' })).toThrow();
  });
});

describe('database migrations', () => {
  it('puts the numbers of a 1.x database under the first VoIP.ms account, keeping its settings', () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mig-')), 'portal.db');
    // The schema of 1.8, the last one with a single account.
    const old = openDatabase(file, 10);
    old.prepare("INSERT INTO dids (did, color) VALUES ('4506575294', '#1a73e8')").run();
    old.prepare("INSERT INTO settings (key, value) VALUES ('sync.lastSuccessAt', '1700000000000')").run();
    old.close();
    const repo = new Repo(openDatabase(file));
    expect(repo.listAccounts()).toEqual([{ id: 1, label: null, numbers: 1 }]);
    expect(repo.listDids()).toEqual([expect.objectContaining({ did: '4506575294', accountId: 1 })]);
    // The first account reads the keys 1.x wrote, so going back to 1.x still finds them.
    expect(repo.getSetting(accountKey(1, 'sync.lastSuccessAt'))).toBe('1700000000000');
    expect(accountKey(2, 'sync.lastSuccessAt')).toBe('account.2.sync.lastSuccessAt');
  });

  it('unescapes quotes in bodies stored by earlier versions', async () => {
    const fs = await import('node:fs');
    const os = await import('node:os');
    const path = await import('node:path');
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mig-')), 'portal.db');
    const first = openDatabase(file, 2);
    first.prepare("INSERT INTO dids (did, color) VALUES ('4506575294', '#1a73e8')").run();
    const conversationId = Number(first.prepare("INSERT INTO conversations (did, phone) VALUES ('4506575294', '4383980707')").run().lastInsertRowid);
    const id = Number(
      first
        .prepare("INSERT INTO messages (conversation_id, kind, remote_id, direction, body, sent_at, status, created_at) VALUES (?, 'sms', '9', 'in', ?, 0, 'received', 0)")
        .run(conversationId, "l\\\\\\'accès").lastInsertRowid,
    );
    first.prepare('UPDATE conversations SET last_message_id = ?, last_message_at = 0 WHERE id = ?').run(id, conversationId);
    first.close();
    const reopened = new Repo(openDatabase(file));
    expect(reopened.getMessage(id)!.body).toBe("l'accès");
    // Later migrations index the cleaned body for accent-insensitive search.
    expect(reopened.listConversations({ query: "L'ACCES" }).map((c) => c.id)).toEqual([conversationId]);
  });

  /** A database at the schema before blank bodies were emptied, holding one of each. */
  function withBlankBodies(): { file: string; ids: { blank: number; text: number; emoji: number } } {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mig-')), 'portal.db');
    const db = openDatabase(file, 9);
    db.prepare("INSERT INTO dids (did, color) VALUES ('4506575294', '#1a73e8')").run();
    const conversationId = Number(db.prepare("INSERT INTO conversations (did, phone) VALUES ('4506575294', '4383980707')").run().lastInsertRowid);
    const insert = db.prepare(
      "INSERT INTO messages (conversation_id, kind, remote_id, direction, body, search_text, sent_at, status, created_at) VALUES (?, 'mms', ?, 'in', ?, ?, 0, 'received', 0)",
    );
    const add = (remoteId: string, body: string) => Number(insert.run(conversationId, remoteId, body, body).lastInsertRowid);
    const ids = { blank: add('1', '\n\n\n \u200b\r\n'), text: add('2', ' Allo\n'), emoji: add('3', '🎤') };
    db.close();
    return { file, ids };
  }

  it('empties bodies stored as only line breaks or invisible characters', () => {
    const { file, ids } = withBlankBodies();
    const repo = new Repo(openDatabase(file));
    expect(repo.getMessage(ids.blank)!.body).toBe('');
    expect(repo.getMessage(ids.text)!.body).toBe(' Allo\n');
    expect(repo.getMessage(ids.emoji)!.body).toBe('🎤');
  });

  it.runIf(spawnSync('php', ['-v']).status === 0 || process.env.REQUIRE_PHP)('empties them the same way on the PHP server', () => {
    const { file, ids } = withBlankBodies();
    const run = spawnSync('php', ['-r', 'require $argv[1]; SmsPortal\\Db::open($argv[2]);', path.resolve('php/app/bootstrap.php'), file], { encoding: 'utf8' });
    expect(run.stderr + run.stdout).toBe('');
    const repo = new Repo(openDatabase(file));
    expect(repo.getMessage(ids.blank)!.body).toBe('');
    expect(repo.getMessage(ids.text)!.body).toBe(' Allo\n');
    expect(repo.getMessage(ids.emoji)!.body).toBe('🎤');
  });
});
