import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { buildApp } from '../server/app.js';
import { loadConfig } from '../server/config.js';

/**
 * The two servers of the project, started in demo mode on a free port, for
 * tests that check they answer the same API: the Node one (Docker) and
 * the PHP one (shared hosting, through PHP's built-in server and
 * php/dev-router.php, which does what php/www/.htaccess does on a host).
 */

export interface Backend {
  name: 'node' | 'php';
  url: string;
  dataDir: string;
  stop(): Promise<void>;
}

const root = path.resolve(import.meta.dirname, '..');

/** Settings both get: demo account, checks every 3 s while a tab is open. */
const ENV = { APP_PASSWORD: 'hunter2', DEMO_MODE: 'true', POLL_INTERVAL_ACTIVE: '3' };

export const phpAvailable = spawnSync('php', ['-v']).status === 0;

/** CI sets REQUIRE_PHP so that a missing PHP fails the run instead of skipping half of it. */
export const backendNames: Backend['name'][] = phpAvailable || process.env.REQUIRE_PHP ? ['node', 'php'] : ['node'];

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as net.AddressInfo;
      server.close(() => resolve(port));
    });
    server.on('error', reject);
  });
}

/** A DATA_DIR in `env` is left in place when the server stops (to start another one on the same data). */
export async function startBackend(name: Backend['name'], env: Record<string, string> = {}): Promise<Backend> {
  const dataDir = env.DATA_DIR ?? fs.mkdtempSync(path.join(os.tmpdir(), `contract-${name}-`));
  const cleanUp = () => env.DATA_DIR === undefined && fs.rmSync(dataDir, { recursive: true, force: true });
  const settings = { ...ENV, ...env, DATA_DIR: dataDir };

  if (name === 'node') {
    const config = loadConfig({ ...settings, WEB_DIR: path.join(dataDir, 'no-web') });
    const { app, services } = await buildApp(config, { logger: false });
    await app.listen({ port: 0, host: '127.0.0.1' });
    services.sync.start();
    const { port } = app.server.address() as net.AddressInfo;
    return {
      name,
      url: `http://127.0.0.1:${port}`,
      dataDir,
      stop: async () => {
        await app.close();
        cleanUp();
      },
    };
  }

  const port = await freePort();
  const webRoot = path.join(dataDir, 'www');
  fs.mkdirSync(webRoot, { recursive: true });
  const child: ChildProcess = spawn('php', ['-S', `127.0.0.1:${port}`, '-t', webRoot, path.join(root, 'php/dev-router.php')], {
    env: { ...process.env, ...settings, SMS_PORTAL_DIR: path.join(root, 'php/app'), PHP_CLI_SERVER_WORKERS: '4' },
    stdio: 'ignore',
  });
  const url = `http://127.0.0.1:${port}`;
  for (let i = 0; ; i++) {
    try {
      if ((await fetch(`${url}/api/health`)).ok) break;
    } catch {
      // Not listening yet.
    }
    if (i > 100) throw new Error('php -S did not start');
    await new Promise((r) => setTimeout(r, 50));
  }
  return {
    name,
    url,
    dataDir,
    stop: async () => {
      const exited = new Promise((r) => child.once('exit', r));
      child.kill('SIGTERM');
      await exited;
      cleanUp();
    },
  };
}

/** Runs the PHP version's cron job against a backend's data. */
export function runCron(backend: Backend, env: Record<string, string> = {}): void {
  const result = spawnSync('php', [path.join(root, 'php/app/cron.php')], {
    env: { ...process.env, ...ENV, DATA_DIR: backend.dataDir, ...env },
    encoding: 'utf8',
  });
  if (result.status !== 0) throw new Error(`cron.php failed: ${result.stderr}`);
}

/** A browser of sorts: keeps the session cookie, sends JSON, reads JSON. */
export class Client {
  cookie = '';

  constructor(readonly base: string) {}

  async request(method: string, url: string, body?: unknown, headers: Record<string, string> = {}): Promise<{ status: number; headers: Headers; json: any }> {
    const init: RequestInit = { method, headers: { ...headers, ...(this.cookie ? { cookie: this.cookie } : {}) } };
    if (body instanceof FormData) {
      init.body = body;
    } else if (body !== undefined) {
      init.body = JSON.stringify(body);
      (init.headers as Record<string, string>)['content-type'] = 'application/json';
    }
    const res = await fetch(this.base + url, init);
    const setCookie = res.headers.get('set-cookie');
    if (setCookie) this.cookie = setCookie.split(';')[0]!;
    const text = await res.text();
    let json: unknown = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = text;
    }
    return { status: res.status, headers: res.headers, json };
  }

  get(url: string) {
    return this.request('GET', url);
  }

  post(url: string, body?: unknown, headers?: Record<string, string>) {
    return this.request('POST', url, body, headers);
  }

  async login(password = 'hunter2') {
    const res = await this.post('/api/auth/login', { password });
    if (res.status !== 200) throw new Error(`login failed: ${res.status}`);
    return res;
  }
}

export async function waitFor<T>(check: () => Promise<T | null | undefined | false>, timeoutMs = 15_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error('Timed out waiting');
    await new Promise((r) => setTimeout(r, 100));
  }
}
