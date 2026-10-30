import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import type net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client, freePort, startBackend, type Backend } from './backends.js';
import { writeFileList } from '../scripts/package-files.mjs';

/**
 * New versions: the server reads the release.json of the newest release
 * (scripts/release-manifest.mjs), says whether to update, and installs it
 * in place on shared hosting.
 */

const root = path.resolve(import.meta.dirname, '..');
const { version } = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')) as { version: string };

/** Serves release.json and the package, as GitHub's release downloads would. */
class FakeReleases {
  manifest: unknown = null;
  /** Status of release.json when there is no manifest (404: nothing published). */
  status = 404;
  files = new Map<string, Buffer>();
  hits = 0;
  url = '';
  private server = http.createServer((req, res) => {
    if (req.url === '/release.json') {
      this.hits++;
      if (this.manifest === null) return void res.writeHead(this.status).end();
      return void res.writeHead(200, { 'content-type': 'application/json' }).end(typeof this.manifest === 'string' ? this.manifest : JSON.stringify(this.manifest));
    }
    const file = this.files.get(req.url ?? '');
    res.writeHead(file ? 200 : 404).end(file);
  });

  async start() {
    await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', resolve));
    this.url = `http://127.0.0.1:${(this.server.address() as net.AddressInfo).port}`;
  }

  stop() {
    this.server.closeAllConnections();
    return new Promise((resolve) => this.server.close(resolve));
  }

  /** `php`: the oldest PHP the release runs on, as release.json says from 1.8.1 on. */
  release(v: string, zip: Buffer | null = null, sha256 = zip ? crypto.createHash('sha256').update(zip).digest('hex') : '0'.repeat(64), php?: string) {
    if (zip) this.files.set(`/sms-portal-cpanel-${v}.zip`, zip);
    this.manifest = {
      version: v,
      publishedAt: '2026-10-17T12:00:00Z',
      url: `https://github.com/dansleboby/voip-ms-sms-portal/releases/tag/v${v}`,
      notes: '- **New.** Something `better`.',
      ...(php ? { php } : {}),
      cpanel: { url: `${this.url}/sms-portal-cpanel-${v}.zip`, sha256, size: zip?.length ?? 0 },
      docker: { image: `ghcr.io/dansleboby/voip-ms-sms-portal:${v}` },
    };
  }
}

describe('Update check', () => {
  const releases = new FakeReleases();
  let backend: Backend;
  let client: Client;

  beforeAll(async () => {
    await releases.start();
    backend = await startBackend({ UPDATE_MANIFEST_URL: `${releases.url}/release.json` });
    client = new Client(backend.url);
  }, 30_000);

  afterAll(async () => {
    await backend?.stop();
    await releases.stop();
  });

  it('needs a session', async () => {
    expect((await client.get('/api/update')).status).toBe(401);
    expect((await client.post('/api/update/install')).status).toBe(401);
    await client.login();
  });

  it('says when nothing is published yet', async () => {
    const status = (await client.get('/api/update')).json;
    expect(status).toMatchObject({ current: version, enabled: true, latest: null, available: false, error: null });
    expect(status.install).toBe('php');
  });

  it('offers a newer release, with its notes', async () => {
    releases.release('9.9.9');
    // Answers are kept for hours: ask again.
    const status = (await client.get('/api/update?refresh=1')).json;
    expect(status).toMatchObject({
      available: true,
      latest: { version: '9.9.9', url: 'https://github.com/dansleboby/voip-ms-sms-portal/releases/tag/v9.9.9', notes: '- **New.** Something `better`.' },
      error: null,
    });
    expect(status.checkedAt).toBeGreaterThan(Date.now() - 10_000);
    const hits = releases.hits;
    await client.get('/api/update');
    expect(releases.hits).toBe(hits);
  });

  it('installs only where it can', async () => {
    const status = (await client.get('/api/update')).json;
    expect(status.canInstall).toBe(false);
    const install = await client.post('/api/update/install');
    expect(install.status).toBe(409);
    // A checkout of the project updates with git, not with a package.
    expect(install.json.error).toBe('not_packaged');
    expect(status.blocked).toBe('not_packaged');
  });

  it('keeps the last answer when the release cannot be read, and reports why', async () => {
    releases.manifest = '{"version": "not a version"}';
    const status = (await client.get('/api/update?refresh=1')).json;
    expect(status).toMatchObject({ error: 'invalid_manifest', latest: { version: '9.9.9' } });
    releases.manifest = null;
    releases.status = 500;
    expect((await client.get('/api/update?refresh=1')).json.error).toBe('unreachable');
    releases.status = 404;
    expect((await client.get('/api/update?refresh=1')).json).toMatchObject({ error: null, latest: null, available: false });
  });

  it('asks nothing when update checks are off', async () => {
    const off = await startBackend({ UPDATE_MANIFEST_URL: `${releases.url}/release.json`, UPDATE_CHECK: 'false' });
    try {
      const offClient = new Client(off.url);
      await offClient.login();
      const hits = releases.hits;
      expect((await offClient.get('/api/update?refresh=1')).json).toMatchObject({ enabled: false, latest: null, available: false });
      expect(releases.hits).toBe(hits);
    } finally {
      await off.stop();
    }
  });

  it('leaves updates to a new image in Docker, which runs its own cron job', async () => {
    // As the image sets it; --env-file keeps the quotes of a value written "docker".
    const docker = await startBackend({ UPDATE_MANIFEST_URL: `${releases.url}/release.json`, SMS_PORTAL_INSTALL: '"docker"' });
    try {
      const dockerClient = new Client(docker.url);
      await dockerClient.login();
      expect((await dockerClient.get('/api/update')).json).toMatchObject({ install: 'docker', canInstall: false, blocked: null });
      expect(await dockerClient.post('/api/update/install')).toMatchObject({ status: 409, json: { error: 'install_unsupported' } });
      expect((await dockerClient.get('/api/sync/status')).json.cron).toBeUndefined();
    } finally {
      await docker.stop();
    }
  });
});

/** A cPanel install in a home folder: the sms-portal folder and the site next to it. */
function install(home: string, v: string) {
  const app = path.join(home, 'sms-portal');
  const site = path.join(home, 'sms-portal-site');
  fs.cpSync(path.join(root, 'php/app'), app, { recursive: true, filter: (src) => !src.endsWith('/data') && !src.endsWith('config.php') });
  fs.writeFileSync(path.join(app, 'VERSION'), `${v}\n`);
  fs.cpSync(path.join(root, 'php/www'), site, { recursive: true });
  fs.mkdirSync(path.join(site, 'assets'));
  fs.writeFileSync(path.join(site, 'index.html'), `<!doctype html><title>${v}</title><script src="/assets/app-${v}.js"></script>`);
  fs.writeFileSync(path.join(site, `assets/app-${v}.js`), `console.log(${JSON.stringify(v)})`);
  return { app, site };
}

/** The zip of a release, as scripts/build-cpanel.mjs makes it; `after` changes it once its file list is written. */
function packageZip(v: string, extra: (dir: string) => void = () => {}, after: (dir: string) => void = () => {}): Buffer {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'package-'));
  install(dir, v);
  fs.writeFileSync(path.join(dir, 'INSTALL.txt'), 'Install');
  extra(dir);
  writeFileList(dir);
  after(dir);
  const zip = path.join(dir, 'package.zip');
  execFileSync('zip', ['-qrX', zip, 'sms-portal', 'sms-portal-site', 'INSTALL.txt'], { cwd: dir });
  const bytes = fs.readFileSync(zip);
  fs.rmSync(dir, { recursive: true, force: true });
  return bytes;
}

// Hosts without PHP's zip extension, or with ZipArchive disabled, unpack with PharData instead.
describe.each(['ZipArchive', 'PharData'])('PHP server: installing an update with %s', (extractor) => {
  const releases = new FakeReleases();
  let home: string;
  let app: string;
  let site: string;
  let server: ChildProcess;
  let client: Client;

  beforeAll(async () => {
    await releases.start();
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'home-'));
    ({ app, site } = install(home, '1.0.0'));
    // What the update must leave alone, or remove.
    fs.writeFileSync(path.join(app, 'config.php'), "<?php // mine\nreturn [];\n");
    fs.writeFileSync(path.join(app, 'src/Obsolete.php'), '<?php');
    fs.mkdirSync(path.join(site, '.well-known/acme-challenge'), { recursive: true });
    fs.writeFileSync(path.join(site, '.well-known/acme-challenge/token'), 'cpanel ssl');
    // Unreadable by the web server, as an update made under a strict umask left it before 1.6.1.
    fs.chmodSync(path.join(site, 'index.html'), 0o600);

    // A random one could be a port the other test files' connections hold: php -S would quit at once.
    const port = await freePort();
    // The site's api.php finds sms-portal next to it, as on a host.
    // Some hosts also print PHP's warnings, as this one will about ZipArchive: responses must stay clean JSON.
    const options = extractor === 'PharData' ? ['-d', 'disable_classes=ZipArchive', '-d', 'display_errors=1'] : [];
    // Under the strictest umask some hosts give PHP: the files it writes must still be readable by the web server.
    const php = ['php', ...options, '-S', `127.0.0.1:${port}`, '-t', site, path.join(site, 'api.php')];
    server = spawn('sh', ['-c', 'umask 077 && exec "$@"', 'sh', ...php], {
      env: { ...process.env, APP_PASSWORD: 'hunter2', DEMO_MODE: 'true', UPDATE_MANIFEST_URL: `${releases.url}/release.json`, SMS_PORTAL_DIR: '' },
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let output = '';
    server.stderr?.on('data', (chunk: Buffer) => (output += chunk));
    client = new Client(`http://127.0.0.1:${port}`);
    for (let i = 0; ; i++) {
      try {
        if ((await fetch(`${client.base}/api/health`)).ok) break;
      } catch {
        // Not listening yet.
      }
      if (i > 100) throw new Error(`php -S did not start: ${output.slice(-2000)}`);
      await new Promise((r) => setTimeout(r, 50));
    }
    await client.login();
  }, 30_000);

  afterAll(async () => {
    server?.kill();
    await releases.stop();
    fs.rmSync(home, { recursive: true, force: true });
  });

  const read = (file: string) => fs.readFileSync(file, 'utf8');

  it('can install, when the files are its own', async () => {
    releases.release('9.9.9', packageZip('9.9.9'));
    expect((await client.get('/api/update?refresh=1')).json).toMatchObject({ current: '1.0.0', available: true, canInstall: true, blocked: null });
  });

  it('refuses a download that does not match the release, changing nothing', async () => {
    releases.release('9.9.9', packageZip('9.9.9'), 'f'.repeat(64));
    expect(await client.post('/api/update/install')).toMatchObject({ status: 502, json: { error: 'checksum_mismatch' } });
    expect(read(path.join(app, 'VERSION')).trim()).toBe('1.0.0');
    expect(read(path.join(site, 'index.html'))).toContain('1.0.0');
  });

  it('refuses a package that writes outside its folders', async () => {
    const evil = packageZip('9.9.9');
    const file = path.join(home, 'evil.zip');
    fs.writeFileSync(file, evil);
    execFileSync('php', ['-r', '$z = new ZipArchive(); $z->open($argv[1]); $z->addFromString("../escaped.txt", "x"); $z->close();', file]);
    releases.release('9.9.9', fs.readFileSync(file));
    expect(await client.post('/api/update/install')).toMatchObject({ status: 502, json: { error: 'invalid_package' } });
    expect(fs.existsSync(path.join(home, 'escaped.txt'))).toBe(false);
    expect(fs.existsSync(path.join(app, 'escaped.txt'))).toBe(false);
  });

  it('refuses a package whose files differ from its list, as an unzip gone wrong leaves them', async () => {
    releases.release('9.9.9', packageZip('9.9.9', () => {}, (dir) => fs.appendFileSync(path.join(dir, 'sms-portal/src/App.php'), '// corrupted')));
    expect(await client.post('/api/update/install')).toMatchObject({ status: 502, json: { error: 'invalid_package' } });
    releases.release('9.9.9', packageZip('9.9.9', () => {}, (dir) => fs.writeFileSync(path.join(dir, 'sms-portal-site/extra.php'), '<?php')));
    expect(await client.post('/api/update/install')).toMatchObject({ status: 502, json: { error: 'invalid_package' } });
    expect(read(path.join(app, 'VERSION')).trim()).toBe('1.0.0');
  });

  it('waits for a newer PHP when the release needs one, saying which, changing nothing', async () => {
    const zip = packageZip('9.9.9');
    releases.release('9.9.9', zip, undefined, '99.0');
    const status = (await client.get('/api/update?refresh=1')).json;
    expect(status).toMatchObject({ available: true, canInstall: false, blocked: 'php_too_old', php: { required: '99.0', running: expect.stringMatching(/^8\./) } });
    expect(await client.post('/api/update/install')).toMatchObject({ status: 409, json: { error: 'php_too_old' } });
    expect(read(path.join(app, 'VERSION')).trim()).toBe('1.0.0');
    // The PHP this server runs, or an older one, is fine.
    releases.release('9.9.9', zip, undefined, '8.4');
    expect((await client.get('/api/update?refresh=1')).json).toMatchObject({ canInstall: true, blocked: null });
    expect((await client.get('/api/update')).json.php).toBeUndefined();
  });

  it('refuses a package of another version', async () => {
    releases.release('9.9.9', packageZip('9.9.8'));
    expect(await client.post('/api/update/install')).toMatchObject({ status: 502, json: { error: 'invalid_package' } });
  });

  it('installs the new version and keeps settings, data and foreign files', async () => {
    releases.release(
      '9.9.9',
      packageZip('9.9.9', (dir) => {
        // A package never carries these, but if it did they must not land.
        fs.writeFileSync(path.join(dir, 'sms-portal/config.php'), "<?php return ['APP_PASSWORD' => 'theirs'];");
        fs.mkdirSync(path.join(dir, 'sms-portal/data'));
        fs.writeFileSync(path.join(dir, 'sms-portal/data/portal.db'), 'not a database');
        // A folder the previous version did not have.
        fs.mkdirSync(path.join(dir, 'sms-portal-site/fonts'));
        fs.writeFileSync(path.join(dir, 'sms-portal-site/fonts/new.woff2'), 'font');
      }),
    );
    const res = await client.post('/api/update/install');
    expect(res).toMatchObject({ status: 200, json: { version: '9.9.9' } });

    expect((await client.get('/api/session')).json).toMatchObject({ version: '9.9.9', authenticated: true });
    expect((await client.get('/api/conversations')).status).toBe(200);
    expect(read(path.join(site, 'index.html'))).toContain('9.9.9');
    expect(fs.existsSync(path.join(site, 'assets/app-9.9.9.js'))).toBe(true);
    // The previous build's assets and classes are gone; the host's own files are not.
    expect(fs.existsSync(path.join(site, 'assets/app-1.0.0.js'))).toBe(false);
    expect(fs.existsSync(path.join(app, 'src/Obsolete.php'))).toBe(false);
    expect(read(path.join(site, '.well-known/acme-challenge/token'))).toBe('cpanel ssl');
    expect(read(path.join(app, 'config.php'))).toContain('// mine');
    expect(read(path.join(app, 'data/portal.db'))).not.toBe('not a database');
    // What it replaced is kept, for going back by hand.
    expect(read(path.join(app, 'data/update/backup/sms-portal-site/index.html'))).toContain('1.0.0');
    expect(read(path.join(app, 'data/update/backup/sms-portal/VERSION')).trim()).toBe('1.0.0');
    expect(fs.readdirSync(site).some((f) => f.endsWith('.update-new'))).toBe(false);
    // Readable by the web server, as extracting the zip by hand would leave them.
    const mode = (file: string) => (fs.statSync(file).mode & 0o777).toString(8);
    expect(mode(path.join(site, 'index.html'))).toBe('644');
    expect(mode(path.join(site, 'assets/app-9.9.9.js'))).toBe('644');
    expect(mode(path.join(site, 'fonts'))).toBe('755');
    expect(mode(path.join(site, 'fonts/new.woff2'))).toBe('644');
    expect(mode(path.join(app, 'src/App.php'))).toBe('644');

    expect((await client.get('/api/update')).json).toMatchObject({ current: '9.9.9', available: false });
    expect((await client.post('/api/update/install')).json).toEqual({ error: 'up_to_date' });
  });
});
