// Builds the package for shared hosting (cPanel): dist/sms-portal-cpanel-<version>.zip,
// two folders to extract side by side in the home folder:
//   sms-portal/       the PHP server, its settings and data (never served)
//   sms-portal-site/  the subdomain's document root (web client, .htaccess, api.php)
// Run through "npm run build:cpanel", which builds the web client first.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const { version } = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const web = path.join(root, 'dist/web');
if (!fs.existsSync(path.join(web, 'index.html'))) {
  console.error('dist/web is missing: run "npm run build:web" first.');
  process.exit(1);
}

const out = path.join(root, 'dist/cpanel');
fs.rmSync(out, { recursive: true, force: true });

const app = path.join(out, 'sms-portal');
// Settings and data of a local test run stay out of the package.
const local = new Set(['config.php', 'data'].map((name) => path.join(root, 'php/app', name)));
fs.cpSync(path.join(root, 'php/app'), app, { recursive: true, filter: (src) => !local.has(src) });
fs.writeFileSync(path.join(app, 'VERSION'), `${version}\n`);

const site = path.join(out, 'sms-portal-site');
fs.cpSync(web, site, { recursive: true });
fs.cpSync(path.join(root, 'php/www'), site, { recursive: true });
fs.writeFileSync(
  path.join(site, 'assets/.htaccess'),
  `# Built files carry their content's fingerprint in their name: kept for a year.
<IfModule mod_headers.c>
    Header set Cache-Control "public, max-age=31536000, immutable"
</IfModule>
`,
);
fs.copyFileSync(path.join(root, 'php/INSTALL.txt'), path.join(out, 'INSTALL.txt'));

const zip = path.join(root, 'dist', `sms-portal-cpanel-${version}.zip`);
fs.rmSync(zip, { force: true });
execFileSync('zip', ['-qrX', zip, 'sms-portal', 'sms-portal-site', 'INSTALL.txt'], { cwd: out });
console.log(`${path.relative(root, zip)} (${Math.round(fs.statSync(zip).size / 1024)} KB)`);
