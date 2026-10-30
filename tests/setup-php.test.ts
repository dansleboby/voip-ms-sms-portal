import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { freePort, phpAvailable } from './backends.js';

const root = path.resolve(import.meta.dirname, '..');

/**
 * A first install on shared hosting that misses a step answers with what to
 * do, which the sign-in page shows: it read "Lost connection to the server".
 */
describe.runIf(phpAvailable || process.env.REQUIRE_PHP)('PHP server missing a setup step', () => {
  const servers: ChildProcess[] = [];
  const dirs: string[] = [];

  afterAll(() => {
    for (const server of servers) server.kill();
    for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
  });

  /** Starts the PHP server as on a host, with `env` in place of the test run's own settings. */
  async function start(env: Record<string, string>): Promise<string> {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'setup-php-'));
    dirs.push(dir);
    const port = await freePort();
    const { APP_PASSWORD: _password, SMS_PORTAL_DIR: _dir, ...rest } = process.env;
    const server = spawn('php', ['-S', `127.0.0.1:${port}`, '-t', dir, path.join(root, 'php/dev-router.php')], {
      env: { ...rest, DATA_DIR: path.join(dir, 'data'), ...env },
      stdio: 'ignore',
    });
    servers.push(server);
    const url = `http://127.0.0.1:${port}`;
    for (let i = 0; ; i++) {
      try {
        await fetch(`${url}/api/health`);
        return url;
      } catch {
        // Not listening yet.
      }
      if (i > 100) throw new Error('php -S did not start');
      await new Promise((r) => setTimeout(r, 50));
    }
  }

  const answer = async (url: string, init?: RequestInit) => {
    const res = await fetch(url, init);
    return { status: res.status, json: (await res.json()) as unknown };
  };

  it('says that APP_PASSWORD is not set, before and at sign-in', async () => {
    const url = await start({ SMS_PORTAL_DIR: path.join(root, 'php/app') });
    const expected = { status: 500, json: { error: 'config_error', message: expect.stringContaining('APP_PASSWORD') } };
    expect(await answer(`${url}/api/session`)).toEqual(expected);
    const login = { method: 'POST', headers: { 'content-type': 'application/json', origin: url }, body: JSON.stringify({ password: 'x' }) };
    expect(await answer(`${url}/api/auth/login`, login)).toEqual(expected);
  });

  it('asks for the PHP that package.json names, which release.json announces', () => {
    const { engines } = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')) as { engines: { php: string } };
    const [, major, minor] = /^>=(\d+)\.(\d+)$/.exec(engines.php)!;
    for (const file of ['php/www/api.php', 'php/app/bootstrap.php']) {
      const code = fs.readFileSync(path.join(root, file), 'utf8');
      expect(code, file).toContain(`PHP_VERSION_ID < ${Number(major) * 10000 + Number(minor) * 100})`);
      expect(code, file).toContain(`needs PHP ${major}.${minor} or later`);
    }
  });

  it('says where the sms-portal folder should be when the site cannot find it', async () => {
    const url = await start({ SMS_PORTAL_DIR: path.join(os.tmpdir(), 'no-such-folder'), APP_PASSWORD: 'x' });
    expect(await answer(`${url}/api/session`)).toEqual({
      status: 500,
      json: { error: 'config_error', message: expect.stringContaining('sms-portal folder was not found') },
    });
  });
});
