import path from 'node:path';
import { normalizePhone } from '../shared/phone.js';
import type { InstallKind, LiveUpdates } from '../shared/types.js';

/** Every release publishes its release.json; this address always leads to the newest one. */
export const DEFAULT_UPDATE_MANIFEST_URL = 'https://github.com/dansleboby/voip-ms-sms-portal/releases/latest/download/release.json';

export interface Config {
  port: number;
  host: string;
  dataDir: string;
  /** Static password protecting the whole interface. */
  appPassword: string;
  /** Credentials from the environment; when null they are entered in the setup wizard. */
  voipmsEnv: { username: string; password: string } | null;
  /** Polling period while at least one browser tab is open. */
  pollActiveMs: number;
  /** Polling period when nobody is looking. */
  pollIdleMs: number;
  /** IANA zone VoIP.ms uses for the dates it returns (Eastern time, DST-aware). */
  voipmsTimezone: string;
  /** Fastify trustProxy: false, or the addresses/subnets of trusted proxies. */
  trustProxy: false | string;
  sessionDays: number;
  /** Serves a fake VoIP.ms account with sample data instead of calling the real API. */
  demo: boolean;
  logLevel: string;
  /** Built web client to serve; absent in development (Vite serves it). */
  webDir: string;
  /** Contact sent to push services with each notification (VAPID "sub" claim). */
  vapidSubject: string;
  /**
   * Origin the app is reached at ("https://sms.example.com"), for reverse
   * proxies that do not pass the original Host or protocol along.
   */
  publicOrigin: string | null;
  /** Transport the web client uses for live updates; the server always answers both. */
  liveUpdates: LiveUpdates;
  /** Whether Settings looks for new releases (UPDATE_CHECK). */
  updateCheck: boolean;
  /** Where the newest release is described (release.json). */
  updateManifestUrl: string;
  /** The only numbers of the account the portal uses (ALLOWED_DIDS); null for all of them. */
  allowedDids: string[] | null;
  /** Numbers of the account the portal leaves alone (EXCLUDED_DIDS). */
  excludedDids: string[];
  /** "docker" in the image (SMS_PORTAL_INSTALL), "source" otherwise. */
  install: Exclude<InstallKind, 'php'>;
  /** Problems worth logging once the logger exists (e.g. settings that had to be cleaned up). */
  warnings: string[];
}

export class ConfigError extends Error {}

function seconds(value: string | undefined, fallback: number, min: number): number {
  if (value === undefined || value.trim() === '') return fallback * 1000;
  const n = Number(value);
  if (!Number.isFinite(n) || n < min) throw new ConfigError(`Expected a number of seconds >= ${min}, got "${value}"`);
  return Math.round(n * 1000);
}

/**
 * TRUST_PROXY=true trusts proxies on private networks only (Docker networks,
 * localhost), so a client reaching the port directly cannot spoof
 * X-Forwarded-For. An explicit list of addresses/subnets is also accepted.
 */
function trustProxy(value: string | undefined): false | string {
  const v = value?.trim().toLowerCase() ?? '';
  if (v === '' || ['0', 'false', 'no', 'off'].includes(v)) return false;
  if (['1', 'true', 'yes', 'on'].includes(v)) return 'loopback, linklocal, uniquelocal';
  return value!.trim();
}

/** "514 555-0100, +1 450-555-0199" -> ["5145550100", "4505550199"]; null when empty. */
function didList(name: string, value: string | undefined): string[] | null {
  const entries = (value ?? '').split(/[,;\n]/).map((entry) => entry.trim()).filter(Boolean);
  if (entries.length === 0) return null;
  const dids = entries.map((entry) => {
    const did = normalizePhone(entry);
    if (!/^\d{10}$/.test(did)) throw new ConfigError(`${name}: "${entry}" is not a 10-digit phone number.`);
    return did;
  });
  return [...new Set(dids)];
}

function bool(value: string | undefined): boolean {
  return value !== undefined && ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase());
}

/** Settings read by loadConfig; only these are cleaned up. */
const SETTINGS = [
  'APP_PASSWORD',
  'VOIPMS_API_USERNAME',
  'VOIPMS_API_PASSWORD',
  'POLL_INTERVAL_ACTIVE',
  'POLL_INTERVAL_IDLE',
  'VOIPMS_TIMEZONE',
  'TRUST_PROXY',
  'SESSION_DAYS',
  'DEMO_MODE',
  'LOG_LEVEL',
  'DATA_DIR',
  'WEB_DIR',
  'HOST',
  'PORT',
  'VAPID_SUBJECT',
  'PUBLIC_URL',
  'LIVE_UPDATES',
  'UPDATE_CHECK',
  'UPDATE_MANIFEST_URL',
  'ALLOWED_DIDS',
  'EXCLUDED_DIDS',
];

/**
 * Docker Compose strips quotes around values in .env files, but
 * `--env-file` (Docker, Podman) keeps them: KEY="value" arrives with its
 * quotes, which then end up in the password sent to VoIP.ms.
 */
function unquoteSettings(env: NodeJS.ProcessEnv, warnings: string[]): NodeJS.ProcessEnv {
  const clean = { ...env };
  for (const key of SETTINGS) {
    const value = env[key]?.trim();
    const quoted = value !== undefined && value.length >= 2 && /^(["']).*\1$/s.test(value);
    if (quoted) {
      clean[key] = value.slice(1, -1);
      warnings.push(`${key} was wrapped in quotes, which were removed. Remove them from the settings file to silence this warning.`);
    }
  }
  return clean;
}

export function loadConfig(rawEnv: NodeJS.ProcessEnv = process.env): Config {
  const warnings: string[] = [];
  const env = unquoteSettings(rawEnv, warnings);
  const appPassword = env.APP_PASSWORD ?? '';
  if (appPassword.length === 0) {
    throw new ConfigError(
      'APP_PASSWORD is not set. Choose a password for the web interface and pass it as the APP_PASSWORD environment variable.',
    );
  }

  const username = env.VOIPMS_API_USERNAME?.trim() ?? '';
  const password = env.VOIPMS_API_PASSWORD ?? '';
  if ((username === '') !== (password === '')) {
    throw new ConfigError('Set both VOIPMS_API_USERNAME and VOIPMS_API_PASSWORD, or neither (to use the setup wizard).');
  }

  const voipmsTimezone = env.VOIPMS_TIMEZONE?.trim() || 'America/New_York';
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: voipmsTimezone });
  } catch {
    throw new ConfigError(`VOIPMS_TIMEZONE "${voipmsTimezone}" is not a valid IANA time zone.`);
  }

  const vapidSubject = env.VAPID_SUBJECT?.trim() || 'https://github.com/dansleboby/voip-ms-sms-portal';
  if (!/^(mailto:\S+@\S+|https:\/\/\S+)$/.test(vapidSubject)) {
    throw new ConfigError(`VAPID_SUBJECT must be a mailto: address or an https:// URL, got "${vapidSubject}".`);
  }

  let publicOrigin: string | null = null;
  const publicUrl = env.PUBLIC_URL?.trim();
  if (publicUrl) {
    try {
      const url = new URL(publicUrl);
      if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error();
      publicOrigin = url.origin;
    } catch {
      throw new ConfigError(`PUBLIC_URL must be the address of the app, like https://sms.example.com, got "${publicUrl}".`);
    }
  }

  const liveUpdates = env.LIVE_UPDATES?.trim().toLowerCase() || 'stream';
  if (liveUpdates !== 'stream' && liveUpdates !== 'poll') {
    throw new ConfigError(`LIVE_UPDATES must be "stream" or "poll", got "${env.LIVE_UPDATES}".`);
  }

  const updateManifestUrl = env.UPDATE_MANIFEST_URL?.trim() || DEFAULT_UPDATE_MANIFEST_URL;
  if (!/^https?:\/\/\S+$/.test(updateManifestUrl)) {
    throw new ConfigError(`UPDATE_MANIFEST_URL must be an http(s) address, got "${updateManifestUrl}".`);
  }

  return {
    port: Number(env.PORT ?? 8080),
    host: env.HOST ?? '0.0.0.0',
    dataDir: path.resolve(env.DATA_DIR ?? 'data'),
    appPassword,
    voipmsEnv: username ? { username, password } : null,
    pollActiveMs: seconds(env.POLL_INTERVAL_ACTIVE, 10, 3),
    pollIdleMs: seconds(env.POLL_INTERVAL_IDLE, 60, 10),
    voipmsTimezone,
    trustProxy: trustProxy(env.TRUST_PROXY),
    sessionDays: Number(env.SESSION_DAYS ?? 30),
    demo: bool(env.DEMO_MODE),
    logLevel: env.LOG_LEVEL ?? 'info',
    webDir: path.resolve(env.WEB_DIR ?? 'dist/web'),
    vapidSubject,
    publicOrigin,
    liveUpdates,
    updateCheck: env.UPDATE_CHECK === undefined || env.UPDATE_CHECK.trim() === '' || bool(env.UPDATE_CHECK),
    updateManifestUrl,
    allowedDids: didList('ALLOWED_DIDS', env.ALLOWED_DIDS),
    excludedDids: didList('EXCLUDED_DIDS', env.EXCLUDED_DIDS) ?? [],
    install: env.SMS_PORTAL_INSTALL === 'docker' ? 'docker' : 'source',
    warnings,
  };
}
