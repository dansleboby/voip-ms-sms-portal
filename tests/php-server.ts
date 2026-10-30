import { spawn } from 'node:child_process';
import path from 'node:path';
import { Client, startBackend, waitFor, type Backend } from './backends.js';
import type { SyncStatusDto } from '../shared/types.js';

/**
 * The PHP server out of demo mode, against a fake VoIP.ms over HTTP
 * (tests/fake-voipms.ts), with what its tests need on top of
 * tests/backends.ts: its services in PHP, and checks of VoIP.ms on demand.
 */

const root = path.resolve(import.meta.dirname, '..');

/** A PHP server and its settings, which php() and cron() need too. */
export interface PhpBackend extends Backend {
  env: Record<string, string>;
}

/** `env` adds to or replaces the settings: VoIP.ms credentials, PUBLIC_URL, a DATA_DIR to keep... */
export async function startPhp(voipmsUrl: string, env: Record<string, string> = {}): Promise<PhpBackend> {
  const settings = {
    APP_PASSWORD: 'hunter2',
    DEMO_MODE: 'false',
    POLL_INTERVAL_ACTIVE: '3',
    VOIPMS_API_URL: `${voipmsUrl}/api/v1/rest.php`,
    ...env,
  };
  return Object.assign(await startBackend(settings), { env: settings });
}

const literal = (value: string) => `'${value.replace(/[\\']/g, '\\$&')}'`;

/**
 * Runs a PHP command on the server's data and settings. Not synchronously:
 * the fake VoIP.ms it may call runs in this process, and must answer.
 */
function runPhp(backend: PhpBackend, args: string[], env: Record<string, string> = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('php', ['-d', 'display_errors=stderr', ...args], { env: { ...process.env, ...backend.env, DATA_DIR: backend.dataDir, ...env } });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
    child.on('error', reject);
    child.on('close', (status) => (status === 0 ? resolve(stdout) : reject(new Error(`PHP failed (${status}): ${stderr}${stdout}`))));
  });
}

/**
 * Runs PHP code with the server's own services ($app, booted as for a
 * request) on its data, for what the API neither shows nor sets up; resolves
 * to what the code returns.
 */
export async function php<T = unknown>(backend: PhpBackend, code: string): Promise<T> {
  const script = `require ${literal(path.join(root, 'php/app/bootstrap.php'))};
    $app = SmsPortal\\App::boot(${literal(path.join(root, 'php/app'))});
    echo json_encode((function () use ($app) { ${code} })());`;
  return JSON.parse(await runPhp(backend, ['-r', script])) as T;
}

/** One run of the cron job (php/app/cron.php), as the host's scheduler starts it; `env` changes settings for that run. */
export async function cron(backend: PhpBackend, env: Record<string, string> = {}): Promise<void> {
  await runPhp(backend, [path.join(root, 'php/app/cron.php')], env);
}

/**
 * Has VoIP.ms checked, and waits for the end of a check that started after
 * the call: the PHP server checks after answering, and skips a check while
 * another one runs.
 */
export async function checkNow(client: Client): Promise<void> {
  const since = Date.now();
  await waitFor(async () => {
    const status = (await client.get('/api/sync/status')).json as SyncStatusDto;
    if (status.state === 'syncing') return false;
    if ((status.lastCheckAt ?? 0) >= since) return true;
    await client.post('/api/sync/now');
    return false;
  });
}

/** A text as the web client sends it. */
export function sendForm(client: Client, fields: Record<string, string>) {
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) form.set(k, v);
  return client.post('/api/messages', form);
}
