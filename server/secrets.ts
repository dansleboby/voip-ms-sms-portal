import crypto from 'node:crypto';
import type { Repo } from './db.js';
import type { VoipMsCredentials } from './voipms/client.js';
import type { CredentialsSource } from '../shared/types.js';

/**
 * VoIP.ms credentials entered in the setup wizard are stored encrypted
 * (AES-256-GCM) with a key derived from APP_PASSWORD, so a copy of the
 * database alone does not reveal the API password. Changing APP_PASSWORD
 * makes them unreadable and the wizard asks for them again.
 */

const CREDENTIALS_KEY = 'voipms.credentials';
const SALT_KEY = 'crypto.salt';

export class CredentialStore {
  private key: Buffer | null = null;

  constructor(
    private readonly repo: Repo,
    private readonly appPassword: string,
    private readonly fromEnv: VoipMsCredentials | null,
  ) {}

  private derivedKey(): Buffer {
    if (this.key) return this.key;
    let salt = this.repo.getSetting(SALT_KEY);
    if (!salt) {
      salt = crypto.randomBytes(16).toString('base64');
      this.repo.setSetting(SALT_KEY, salt);
    }
    this.key = crypto.scryptSync(this.appPassword, Buffer.from(salt, 'base64'), 32);
    return this.key;
  }

  source(): CredentialsSource {
    if (this.fromEnv) return 'env';
    return this.readStored() ? 'db' : null;
  }

  get(): VoipMsCredentials | null {
    return this.fromEnv ?? this.readStored();
  }

  save(credentials: VoipMsCredentials): void {
    if (this.fromEnv) throw new Error('Credentials are provided by environment variables');
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', this.derivedKey(), iv);
    const data = Buffer.concat([cipher.update(JSON.stringify(credentials), 'utf8'), cipher.final()]);
    const payload = {
      iv: iv.toString('base64'),
      tag: cipher.getAuthTag().toString('base64'),
      data: data.toString('base64'),
    };
    this.repo.setSetting(CREDENTIALS_KEY, JSON.stringify(payload));
  }

  clear(): void {
    this.repo.deleteSetting(CREDENTIALS_KEY);
  }

  private readStored(): VoipMsCredentials | null {
    const raw = this.repo.getSetting(CREDENTIALS_KEY);
    if (!raw) return null;
    try {
      const payload = JSON.parse(raw) as { iv: string; tag: string; data: string };
      const decipher = crypto.createDecipheriv('aes-256-gcm', this.derivedKey(), Buffer.from(payload.iv, 'base64'));
      decipher.setAuthTag(Buffer.from(payload.tag, 'base64'));
      const json = Buffer.concat([decipher.update(Buffer.from(payload.data, 'base64')), decipher.final()]).toString('utf8');
      const parsed = JSON.parse(json) as VoipMsCredentials;
      return parsed.username && parsed.password ? parsed : null;
    } catch {
      // Wrong key (APP_PASSWORD changed) or corrupted value.
      return null;
    }
  }
}
