// Writes what a release publishes next to the cPanel zip (run after "npm run build:cpanel"):
//   dist/release-notes.md  the changelog section of this version, for the release page
//   dist/release.json      what running servers read to offer the update (Settings > Updates):
//                          version, notes, the PHP it needs, and the zip with its SHA-256
// Every release carries a release.json, so .../releases/latest/download/release.json
// always describes the newest one.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const { version, engines } = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
// The oldest PHP the release runs on (engines.php, ">=8.1"): servers on an older one do not install it.
const php = /^>=\s*(\d+\.\d+)$/.exec(engines?.php ?? '')?.[1];
if (!php) {
  console.error('package.json must give the oldest PHP the release runs on, as engines.php (">=8.1").');
  process.exit(1);
}
const repository = process.env.GITHUB_REPOSITORY ?? 'dansleboby/voip-ms-sms-portal';
const tag = `v${version}`;

const changelog = fs.readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8');
const section = new RegExp(`^## ${version.replaceAll('.', '\\.')} .*\\n([\\s\\S]*?)(?=^## |(?![\\s\\S]))`, 'm').exec(changelog);
if (!section) {
  console.error(`CHANGELOG.md has no section for ${version}: run "npm run release:prepare" first.`);
  process.exit(1);
}
const notes = section[1].trim();

const zipName = `sms-portal-cpanel-${version}.zip`;
const zip = fs.readFileSync(path.join(root, 'dist', zipName));

const manifest = {
  version,
  publishedAt: new Date().toISOString(),
  url: `https://github.com/${repository}/releases/tag/${tag}`,
  notes,
  php,
  cpanel: {
    url: `https://github.com/${repository}/releases/download/${tag}/${zipName}`,
    sha256: crypto.createHash('sha256').update(zip).digest('hex'),
    size: zip.length,
  },
  docker: { image: `ghcr.io/${repository.toLowerCase()}:${version}` },
};
fs.writeFileSync(path.join(root, 'dist/release.json'), `${JSON.stringify(manifest, null, 2)}\n`);
fs.writeFileSync(path.join(root, 'dist/release-notes.md'), `${notes}\n`);
console.log(`dist/release.json for ${version} (${zipName}, sha256 ${manifest.cpanel.sha256.slice(0, 12)}…)`);
