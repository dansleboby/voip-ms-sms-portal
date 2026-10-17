// Prepares a release in the working tree: bumps the version in package.json
// (and its lockfile) and turns the changelog's "Unreleased" section into
// that version's, dated today. Merging the result to main publishes it
// (.github/workflows/release.yml).
//
//   npm run release:prepare -- minor        # or major, patch, or 1.4.0

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const changelogPath = path.join(root, 'CHANGELOG.md');
const { version: current } = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

const arg = process.argv[2];
const [major, minor, patch] = current.split('.').map(Number);
const next =
  arg === 'major' ? `${major + 1}.0.0`
  : arg === 'minor' ? `${major}.${minor + 1}.0`
  : arg === 'patch' ? `${major}.${minor}.${patch + 1}`
  : /^\d+\.\d+\.\d+$/.test(arg ?? '') ? arg
  : null;
if (!next) {
  console.error('Usage: npm run release:prepare -- <major|minor|patch|X.Y.Z>');
  process.exit(1);
}

const changelog = fs.readFileSync(changelogPath, 'utf8');
const unreleased = /^## Unreleased\n([\s\S]*?)(?=^## |(?![\s\S]))/m.exec(changelog);
if (!unreleased || !/^- /m.test(unreleased[1])) {
  console.error('CHANGELOG.md needs an "## Unreleased" section listing the changes first.');
  process.exit(1);
}
if (new RegExp(`^## ${next.replaceAll('.', '\\.')} `, 'm').test(changelog)) {
  console.error(`CHANGELOG.md already has a ${next} section.`);
  process.exit(1);
}

const today = new Date().toISOString().slice(0, 10);
fs.writeFileSync(changelogPath, changelog.replace(/^## Unreleased$/m, `## ${next} (${today})`));
execFileSync('npm', ['version', next, '--no-git-tag-version'], { cwd: root, stdio: 'ignore' });
console.log(`${current} -> ${next}. Commit, open a pull request, and merging it publishes the release.`);
