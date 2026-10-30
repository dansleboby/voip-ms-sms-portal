// npm run screenshots: the README's screenshots (docs/screenshots/{en,fr}),
// taken from the demo mode on a fixed date, so that a run rewrites only the
// ones whose look changed. Run it after changing the interface: it lists
// what changed, and git shows it. Takes a Chromium for Playwright, once:
// npx playwright-core install chromium. Pixels depend on the fonts the
// system has: compare runs made on the same machine.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { chromium, type Browser, type BrowserContext, type Locator, type Page } from 'playwright-core';
import { en } from '../web/src/i18n/en.js';
import { fr, type MessageKey } from '../web/src/i18n/fr.js';
import { samePicture } from './png.js';

const root = path.resolve(import.meta.dirname, '..');
/** The demo's "now": a Tuesday evening in Montréal. */
const DEMO_NOW = '2026-09-29T21:30:00-04:00';
/** The browser's, a minute later; it stands still. */
const BROWSER_NOW = new Date(Date.parse(DEMO_NOW) + 60_000);
const DESKTOP = { width: 1280, height: 800 };
const MOBILE = { width: 390, height: 780 };
/** The cron job's line, as shared hosting shows it (the demo server runs as in Docker, with none). */
const CRON_COMMAND = '/usr/local/bin/php /home/you/sms-portal/cron.php';

interface Language {
  code: 'en' | 'fr';
  locale: string;
  messages: Record<MessageKey, string>;
  labels: [string, string];
  hero: string;
  sms: string;
  mms: string;
  emoji: string;
  /** The Team mode's people, the text one of them sends, and a second VoIP.ms account. */
  team: { admin: string; user: string; other: string; text: string; account: string };
}

const LANGUAGES: Language[] = [
  {
    code: 'en',
    locale: 'en-US',
    messages: en,
    labels: ['Personal', 'Work'],
    hero: "We're bringing marshmallows 🔥 and the guitar. See you Saturday!",
    sms: "Perfect, let's meet at the cottage around 10 on Saturday. I'll bring coffee and croissants. Could you grab some firewood?",
    mms: "Here's the view from the dock this morning. The lake was perfectly calm and we even saw a loon go by. Let me know if you want the address for next summer — it's lovely!",
    emoji: 'Hey! 😊',
    team: { admin: 'Julie Fortin', user: 'Marc Gagnon', other: 'Sophie Roy', text: "I'll book the table for Saturday.", account: 'Fortin Bakery' },
  },
  {
    code: 'fr',
    locale: 'fr-CA',
    messages: fr,
    labels: ['Perso', 'Bureau'],
    hero: 'On apporte les guimauves 🔥 et la guitare. À samedi!',
    sms: "Parfait, on se rejoint au chalet vers 10 h samedi. J'apporte le café et les croissants. Peux-tu prendre du bois?",
    mms: "Voici la vue du quai ce matin. Le lac était parfaitement calme et on a même vu passer un huard. Dis-moi si tu veux l'adresse pour l'été prochain, c'est magnifique!",
    emoji: 'Salut! 😊',
    team: { admin: 'Julie Fortin', user: 'Marc Gagnon', other: 'Sophie Roy', text: 'Je réserve la table pour samedi.', account: 'Boulangerie Fortin' },
  },
];

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

/** A demo server of its own, on its own data, as of DEMO_NOW. */
async function startServer(): Promise<{ url: string; stop: () => void }> {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'screenshots-'));
  const port = await freePort();
  const child = spawn('php', ['-S', `127.0.0.1:${port}`, '-t', path.join(root, 'dist/web'), path.join(root, 'php/dev-router.php')], {
    cwd: root,
    env: {
      ...process.env,
      DEMO_NOW,
      APP_PASSWORD: 'demo',
      DEMO_MODE: 'true',
      DATA_DIR: dataDir,
      SMS_PORTAL_DIR: path.join(root, 'php/app'),
      PHP_CLI_SERVER_WORKERS: '4',
      // As in the Docker image: no cron job to set up, until the wizard is shown the shared hosting's.
      SMS_PORTAL_INSTALL: 'docker',
      // The address VoIP.ms would call back: the wizard can then show the webhook turned on.
      PUBLIC_URL: 'https://sms.example.com',
      // No check of the account while shooting: nothing should move.
      POLL_INTERVAL_ACTIVE: '3600',
      POLL_INTERVAL_IDLE: '3600',
      UPDATE_CHECK: 'false',
    },
    // PHP's built-in server logs every request there.
    stdio: 'ignore',
  });
  const url = `http://127.0.0.1:${port}`;
  for (let i = 0; ; i++) {
    try {
      if ((await fetch(`${url}/api/health`)).ok) break;
    } catch {
      // Not listening yet.
    }
    if (i > 150 || child.exitCode !== null) throw new Error('The demo server did not start');
    await new Promise((r) => setTimeout(r, 100));
  }
  return {
    url,
    stop: () => {
      child.kill();
      fs.rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

/**
 * Notifications look allowed and push turned on (headless Chromium has
 * neither). Plain text: tsx would slip its own helpers into a function.
 */
const FAKE_PUSH = `
  Object.defineProperty(Notification, 'permission', { get: () => 'granted' });
  localStorage.setItem('sms-portal:push', 'on');
  const subscription = {
    endpoint: 'https://push.example/screenshots',
    options: { applicationServerKey: null },
    toJSON: () => ({ endpoint: 'https://push.example/screenshots', keys: { p256dh: '', auth: '' } }),
    unsubscribe: async () => true,
  };
  PushManager.prototype.getSubscription = async () => subscription;
`;

class Shooter {
  readonly changed: string[] = [];
  readonly unchanged: string[] = [];
  private readonly dir: string;

  constructor(private readonly lang: Language) {
    this.dir = path.join(root, 'docs/screenshots', lang.code);
    fs.mkdirSync(this.dir, { recursive: true });
  }

  t(key: MessageKey): string {
    return this.lang.messages[key];
  }

  /** Writes the picture if it differs from the one in the repository. */
  async save(name: string, shot: Promise<Buffer>): Promise<void> {
    const file = path.join(this.dir, `${name}.png`);
    const png = await shot;
    if (fs.existsSync(file) && samePicture(fs.readFileSync(file), png)) {
      this.unchanged.push(name);
      return;
    }
    fs.writeFileSync(file, png);
    this.changed.push(name);
  }
}

/** Lets the page finish what a click started (requests, re-renders). */
const settle = (page: Page) => page.waitForTimeout(400);

/** Closes the notices a click left at the bottom of the page. */
async function dismissToasts(page: Page): Promise<void> {
  for (const close of await page.locator('.toast button:last-child').all()) await close.click();
  await page.locator('.toast').first().waitFor({ state: 'detached' });
}

async function shot(target: Page | Locator, options: Parameters<Page['screenshot']>[0] = {}): Promise<Buffer> {
  // Nothing hovered: the pointer goes to the bottom left corner, on no button.
  const page = 'page' in target ? target.page() : target;
  await page.mouse.move(0, (page.viewportSize()?.height ?? 1) - 1);
  return target.screenshot({ animations: 'disabled', caret: 'hide', ...options });
}

async function newContext(browser: Browser, lang: Language, mobile = false, from?: BrowserContext): Promise<BrowserContext> {
  const context = await browser.newContext({
    locale: lang.locale,
    timezoneId: 'America/Toronto',
    colorScheme: 'light',
    viewport: mobile ? MOBILE : DESKTOP,
    deviceScaleFactor: 1,
    isMobile: mobile,
    hasTouch: mobile,
    storageState: from ? await from.storageState() : undefined,
  });
  await context.clock.setFixedTime(BROWSER_NOW);
  await context.addInitScript({ content: FAKE_PUSH });
  // The made-up subscription would not pass the server's checks.
  await context.route('**/api/push/subscriptions', (route) => route.fulfill({ json: { ok: true } }));
  // The server checks hourly so that nothing moves; pages show the default pace, as readers have it.
  await context.route('**/api/session', async (route) => {
    const response = await route.fetch();
    await route.fulfill({ response, json: { ...(await response.json()), pollActiveSeconds: 10, pollIdleSeconds: 60 } });
  });
  return context;
}

async function shoot(browser: Browser, lang: Language): Promise<Shooter> {
  const s = new Shooter(lang);
  const server = await startServer();
  try {
    const context = await newContext(browser, lang);
    const page = await context.newPage();
    const button = (key: MessageKey) => page.getByRole('button', { name: s.t(key), exact: true });

    // The shared hosting version asks for its cron job in the wizard.
    await page.route('**/api/sync/status', async (route) => {
      const response = await route.fetch();
      await route.fulfill({ response, json: { ...(await response.json()), cron: { lastRunAt: null, command: CRON_COMMAND } } });
    });

    await page.goto(server.url);
    await page.locator('input[type=password]').fill('demo');
    await page.locator('button[type=submit]').click();

    // ------------------------------------------------------------- wizard
    const card = page.locator('.setup-card');
    await button('setup.welcome.start').click();
    await button('common.continue').click();
    await page.getByText('203.0.113.10').waitFor();
    await card.locator('[role=status]').waitFor();
    await s.save('setup-ip', shot(card));

    await button('common.continue').click();
    await page.getByText('(819) 555-0123').waitFor();
    const labels = card.locator('.did-label-input');
    for (const [i, label] of lang.labels.entries()) {
      await Promise.all([page.waitForResponse((r) => r.request().method() === 'PATCH'), labels.nth(i).fill(label).then(() => labels.nth(i).blur())]);
    }
    await settle(page);
    await s.save('setup-numbers', shot(card));

    await button('common.continue').click();
    // Receiving texts: the webhook turned on, with Laval still calling the demo's CRM.
    await card.locator('.receiving input[type=radio]').nth(1).click();
    await card.locator('.receiving-number').first().waitFor();
    await settle(page);
    await s.save('setup-receiving', shot(card));
    await button('common.continue').click();
    await button('setup.history.finish').click();
    await page.getByText(s.t('setup.cron.title')).waitFor();
    await s.save('setup-cron', shot(card));
    await button('setup.cron.skip').click();
    await page.unroute('**/api/sync/status');
    await page.getByRole('button', { name: s.t('setup.done.open') }).click();

    // The wizard imports the last 30 days: wait for the four conversations.
    await page.waitForFunction(() => document.querySelectorAll('.conv-item').length === 4);
    const list = page.locator('.conv-list');
    await settle(page);

    // ------------------------------------------------------------- the inbox
    const pane = { x: 0, y: 0, width: 470, height: 640 };
    await s.save('numbers', shot(page, { clip: pane }));
    await page.locator('.rail-item', { hasText: lang.labels[1] }).click();
    await page.waitForFunction(() => document.querySelectorAll('.conv-item').length === 2);
    await settle(page);
    await s.save('filter', shot(page, { clip: pane }));
    await page.locator('.rail-item').first().click();
    await page.waitForFunction(() => document.querySelectorAll('.conv-item').length === 4);

    await list.getByText('Marie Tremblay').click();
    const photo = page.locator('.main img').first();
    await photo.waitFor();
    await page.waitForFunction(() => [...document.querySelectorAll('.main img')].every((img) => (img as HTMLImageElement).complete));
    const box = page.locator('.composer textarea');
    await box.fill(lang.hero);
    await settle(page);
    await s.save('hero', shot(page));

    // ------------------------------------------------------------- the message box
    const composer = page.locator('.composer');
    await box.fill(lang.sms);
    await s.save('composer-sms', shot(composer));

    // The photo Marie sent, attached again.
    const picture = await photo.screenshot({ animations: 'disabled' });
    await composer.locator('input[type=file]').setInputFiles({ name: 'view.png', mimeType: 'image/png', buffer: picture });
    await box.fill(lang.mms);
    await composer.locator('.remove').waitFor();
    await page.waitForFunction(() => !document.querySelector('.composer .spin'));
    // Loaded is not yet drawn: wait until the preview is decoded.
    await composer.locator('img').evaluateAll((images) => Promise.all(images.map((img) => (img as HTMLImageElement).decode())));
    await settle(page);
    await s.save('composer-mms', shot(composer));
    await composer.locator('.remove').click();

    await box.fill(lang.emoji);
    await composer.getByRole('button', { name: s.t('composer.emoji') }).click();
    const emoji = page.locator('.emoji-panel');
    await emoji.getByRole('tab', { name: s.t('emoji.food') }).click();
    await settle(page);
    const panel = (await emoji.boundingBox())!;
    await s.save('emoji', shot(page, { clip: { x: panel.x - 16, y: panel.y - 57, width: 640, height: 470 } }));
    await page.keyboard.press('Escape');
    await box.fill('');

    // ------------------------------------------------------------- new conversation
    const main = page.locator('.main');
    await page.getByRole('button', { name: s.t('nav.newChat') }).click();
    await page.getByPlaceholder(s.t('new.toPlaceholder')).fill('ma');
    await page.locator('.suggestion').nth(1).waitFor();
    await settle(page);
    await s.save('new', shot(main));

    // ------------------------------------------------------------- contacts
    await page.locator('.rail-item', { hasText: s.t('nav.contacts') }).click();
    await page.locator('.contact-item').nth(2).waitFor();
    await settle(page);
    await s.save('contacts', shot(main));
    await page.locator('.contact-item', { hasText: 'Garage Bélanger' }).click();
    const dialog = page.getByRole('dialog');
    await dialog.waitFor();
    await settle(page);
    await s.save('contact-dialog', shot(dialog));
    await dialog.getByRole('button', { name: s.t('common.cancel') }).click();

    // ------------------------------------------------------------- settings
    await page.locator('.rail-item', { hasText: s.t('nav.settings') }).click();
    await page.getByText('(819) 555-0123').waitFor();
    await settle(page);
    await s.save('settings', shot(main));
    const notifications = page.locator('section.section', { has: page.getByRole('heading', { name: s.t('settings.notifications') }) });
    await notifications.scrollIntoViewIfNeeded();
    await settle(page);
    await s.save('push', shot(notifications));

    // ------------------------------------------------------------- archive
    await page.locator('.rail-item').first().click();
    await list.getByText('32665').click();
    await page.getByRole('button', { name: s.t('thread.archive'), exact: true }).click();
    await page.getByRole('button', { name: s.t('nav.archived') }).click();
    await page.locator('.conv-item', { hasText: '32665' }).click();
    await dismissToasts(page);
    await settle(page);
    await s.save('archived', shot(page));
    await page.getByRole('button', { name: s.t('thread.unarchive'), exact: true }).click();
    await page.locator('.toast').first().waitFor();
    await dismissToasts(page);

    // ------------------------------------------------------------- dark theme
    await page.locator('.rail-item').first().click();
    await page.emulateMedia({ colorScheme: 'dark' });
    await list.getByText('Garage Bélanger').click();
    await page.locator('.main h2', { hasText: 'Garage Bélanger' }).waitFor();
    await settle(page);
    await s.save('dark', shot(page));

    // ------------------------------------------------------------- phone
    const phone = await newContext(browser, lang, true, context);
    const mobile = await phone.newPage();
    await mobile.goto(server.url);
    await mobile.waitForFunction(() => document.querySelectorAll('.conv-item').length === 4);
    await settle(mobile);
    await s.save('mobile-list', shot(mobile));
    await mobile.locator('.conv-item', { hasText: 'Marie Tremblay' }).click();
    await mobile.locator('.main img').first().waitFor();
    await mobile.waitForFunction(() => [...document.querySelectorAll('.main img')].every((img) => (img as HTMLImageElement).complete));
    await settle(mobile);
    await s.save('mobile-thread', shot(mobile));
    await phone.close();
    await context.close();
  } finally {
    server.stop();
  }
  return s;
}

/**
 * Calls the API from the page, with its session; fails loudly on an error: a
 * screenshot of an error would pass unnoticed. (Playwright's own requests drop
 * the session cookie, Secure because PUBLIC_URL is https.)
 */
async function call(page: Page, method: string, path: string, body?: object, form = false): Promise<any> {
  const result = await page.evaluate(
    async ({ method, path, body, form }) => {
      let init: RequestInit = { method };
      if (body && form) {
        const data = new FormData();
        for (const [key, value] of Object.entries(body)) data.set(key, String(value));
        init = { method, body: data };
      } else if (body) {
        init = { method, body: JSON.stringify(body), headers: { 'content-type': 'application/json' } };
      }
      const res = await fetch(path, init);
      return { status: res.status, text: await res.text() };
    },
    { method, path, body, form },
  );
  if (result.status >= 300) throw new Error(`${method} ${path}: ${result.status} ${result.text}`);
  return result.text ? JSON.parse(result.text) : null;
}

/** Signs in through the sign-in page: with an email in the Team mode, with APP_PASSWORD otherwise. */
async function signIn(page: Page, url: string, password: string, email?: string): Promise<void> {
  await page.goto(url);
  if (email) await page.locator('input[type=email]').fill(email);
  await page.locator('input[type=password]').fill(password);
  await Promise.all([
    page.waitForResponse((r) => r.url().endsWith('/api/auth/login') && r.ok()),
    page.locator('button[type=submit]').click(),
  ]);
}

/**
 * The Team mode, on a demo server of its own: started afresh, its clock is
 * still at DEMO_NOW, so the times shown come out the same every run. The
 * owner sets it up through the API (the wizard has its screenshots), then an
 * admin and a user each show what they see.
 */
async function shootTeam(browser: Browser, lang: Language, s: Shooter): Promise<void> {
  const server = await startServer();
  try {
    const owner = await newContext(browser, lang);
    const ownerPage = await owner.newPage();
    await signIn(ownerPage, server.url, 'demo');
    const api = (method: string, path: string, body?: object) => call(ownerPage, method, path, body);
    const dids = (await api('GET', '/api/setup/dids')) as { did: string }[];
    const [perso, bureau] = [dids[0]!.did, dids[1]!.did];
    for (const [i, label] of lang.labels.entries()) await api('PATCH', `/api/dids/${dids[i]!.did}`, { label });
    await api('POST', '/api/setup/import', { days: 30 });
    await api('POST', '/api/setup/complete');
    for (let i = 0; ; i++) {
      // A tab's poll: the import goes on after each answer.
      await api('GET', '/api/events/poll?tab=tab-00000099&visible=1');
      const status = await api('GET', '/api/sync/status');
      const conversations = (await api('GET', '/api/conversations')) as unknown[];
      if (status.importing === null && conversations.length === 4) break;
      if (i > 100) throw new Error('The history import did not finish');
      await new Promise((r) => setTimeout(r, 200));
    }

    const password = 'demo password';
    await api('POST', '/api/team', { email: 'julie@example.com', name: lang.team.admin, password });
    const numbers = (did: string, canSend: boolean) => ({ did, canSend });
    await api('POST', '/api/users', {
      email: 'marc@example.com',
      name: lang.team.user,
      password,
      role: 'user',
      numbers: [numbers(perso, false), numbers(bureau, true)],
    });
    await api('POST', '/api/users', { email: 'sophie@example.com', name: lang.team.other, password, role: 'user', numbers: [numbers(bureau, true)] });
    await owner.close();

    const julie = await newContext(browser, lang);
    // A documentation address in the activity log, instead of the test server's.
    await julie.route('**/api/activity*', async (route) => {
      const response = await route.fetch();
      const body = await response.json();
      for (const entry of body.entries) entry.ip &&= '203.0.113.24';
      await route.fulfill({ response, json: body });
    });
    const settings = await julie.newPage();
    await signIn(settings, server.url, password, 'julie@example.com');
    // Julie answers Marie from the personal number, which Marc may only read.
    const sent = await call(settings, 'POST', '/api/messages', { did: perso, to: '4385550142', body: lang.team.text }, true);
    const conversation = sent.conversation.id as number;
    for (let i = 0; ; i++) {
      const thread = (await call(settings, 'GET', `/api/conversations/${conversation}/messages?limit=1`)) as { status: string }[];
      if (thread[0]?.status === 'sent') break;
      if (i > 100) throw new Error('The text was not sent');
      await new Promise((r) => setTimeout(r, 100));
    }

    const marc = await newContext(browser, lang);
    const page = await marc.newPage();
    await signIn(page, server.url, password, 'marc@example.com');
    await page.goto(`${server.url}/c/${conversation}`);
    await page.locator('.read-only-note').waitFor();
    await page.waitForFunction(() => [...document.querySelectorAll('.main img')].every((img) => (img as HTMLImageElement).complete));
    await settle(page);
    await s.save('team-thread', shot(page));
    await marc.close();

    // An admin's Settings: another VoIP.ms account, the users, and the activity log.
    await settings.goto(`${server.url}/settings`);
    const section = (key: MessageKey) => settings.locator('section.section', { has: settings.getByRole('heading', { name: s.t(key), exact: true }) });
    await section('accounts.title').getByRole('button', { name: s.t('accounts.add') }).click();
    const dialog = settings.getByRole('dialog');
    const fields = dialog.locator('input');
    await fields.nth(0).fill(lang.team.account);
    await fields.nth(1).fill('fortin@example.com');
    await fields.nth(2).fill('api password');
    await dialog.locator('button[type=submit]').click();
    await dialog.locator('.did-row').waitFor();
    await settle(settings);
    await s.save('account-added', shot(dialog));
    await dialog.getByRole('button', { name: s.t('common.done') }).click();

    await settings.reload();
    const users = section('team.users');
    await users.locator('.contact-item').nth(2).waitFor();
    await users.evaluate((el) => el.scrollIntoView({ block: 'start' }));
    await settle(settings);
    await s.save('team', shot(users));
    const activity = section('activity.title');
    await activity.locator('.row').nth(6).waitFor();
    await activity.evaluate((el) => el.scrollIntoView({ block: 'start' }));
    await settle(settings);
    // Its latest seven entries: the rest is more of the same.
    const box = (await activity.boundingBox())!;
    const last = (await activity.locator('.row').nth(6).boundingBox())!;
    await s.save('activity', shot(settings, { clip: { x: box.x, y: box.y, width: box.width, height: last.y + last.height - box.y + 1 } }));
    await julie.close();
  } finally {
    server.stop();
  }
}

const browser = await chromium.launch();
let changes = 0;
try {
  for (const lang of LANGUAGES) {
    const s = await shoot(browser, lang);
    await shootTeam(browser, lang, s);
    changes += s.changed.length;
    const total = s.changed.length + s.unchanged.length;
    console.log(`${lang.code}: ${total} screenshots, ${s.changed.length ? `changed: ${s.changed.join(', ')}` : 'none changed'}`);
  }
} finally {
  await browser.close();
}
if (changes) console.log('Look them over with git diff --stat docs/screenshots (or an image diff), and commit the ones that are right.');
