// The API for "npm run dev": the PHP server under PHP's built-in server, as
// the tests run it, on PORT (8080), while Vite serves the client on 5173 and
// passes /api along. Like the Docker image, it runs the cron job every 10
// seconds. Settings come from the environment (DEMO_MODE, APP_PASSWORD...);
// data goes to ./data unless DATA_DIR says otherwise.

import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
if (spawnSync('php', ['-v']).status !== 0) {
  console.error('PHP 8.1 or later must be on the PATH: the server is written in PHP.');
  process.exit(1);
}

const web = path.join(root, 'dist/web');
fs.mkdirSync(web, { recursive: true });
const env = {
  ...process.env,
  SMS_PORTAL_DIR: path.join(root, 'php/app'),
  DATA_DIR: path.resolve(root, process.env.DATA_DIR ?? 'data'),
  // Tabs poll while the server answers other requests.
  PHP_CLI_SERVER_WORKERS: process.env.PHP_CLI_SERVER_WORKERS ?? '4',
};
const port = process.env.PORT ?? '8080';

const check = spawnSync('php', [path.join(root, 'php/app/cron.php'), '--check'], { env, stdio: 'inherit' });
if (check.status !== 0) process.exit(1);

const server = spawn('php', ['-S', `127.0.0.1:${port}`, '-t', web, path.join(root, 'php/dev-router.php')], { env, stdio: 'inherit' });
const cron = setInterval(() => spawn('php', [path.join(root, 'php/app/cron.php')], { env, stdio: 'inherit' }), 10_000);
server.on('exit', (code) => {
  clearInterval(cron);
  process.exit(code ?? 0);
});
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.kill(signal));
