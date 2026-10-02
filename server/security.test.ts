import { describe, expect, it } from 'vitest';
import { Auth } from './auth.js';
import { openDatabase, Repo } from './db.js';
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
