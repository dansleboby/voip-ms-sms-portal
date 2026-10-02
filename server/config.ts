import path from 'node:path';

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
  trustProxy: boolean;
  sessionDays: number;
  /** Serves a fake VoIP.ms account with sample data instead of calling the real API. */
  demo: boolean;
  logLevel: string;
  /** Built web client to serve; absent in development (Vite serves it). */
  webDir: string;
}

export class ConfigError extends Error {}

function seconds(value: string | undefined, fallback: number, min: number): number {
  if (value === undefined || value.trim() === '') return fallback * 1000;
  const n = Number(value);
  if (!Number.isFinite(n) || n < min) throw new ConfigError(`Expected a number of seconds >= ${min}, got "${value}"`);
  return Math.round(n * 1000);
}

function bool(value: string | undefined): boolean {
  return value !== undefined && ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase());
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
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

  return {
    port: Number(env.PORT ?? 8080),
    host: env.HOST ?? '0.0.0.0',
    dataDir: path.resolve(env.DATA_DIR ?? 'data'),
    appPassword,
    voipmsEnv: username ? { username, password } : null,
    pollActiveMs: seconds(env.POLL_INTERVAL_ACTIVE, 10, 3),
    pollIdleMs: seconds(env.POLL_INTERVAL_IDLE, 60, 10),
    voipmsTimezone,
    trustProxy: bool(env.TRUST_PROXY),
    sessionDays: Number(env.SESSION_DAYS ?? 30),
    demo: bool(env.DEMO_MODE),
    logLevel: env.LOG_LEVEL ?? 'info',
    webDir: path.resolve(env.WEB_DIR ?? 'dist/web'),
  };
}
