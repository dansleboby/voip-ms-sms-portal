// The list of a cPanel package's files with their SHA-256, as sms-portal/FILES:
// the updater checks what it unpacked against it before installing anything,
// since an unzip that goes wrong (PharData on PHP 8.1 misreads some zips) can
// write files silently corrupted.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const FOLDERS = ['sms-portal', 'sms-portal-site'];

/** Writes `<root>/sms-portal/FILES`: one "<sha256>  <folder>/<path>" line per file of both folders. */
export function writeFileList(root) {
  const list = path.join(root, 'sms-portal', 'FILES');
  const lines = [];
  for (const folder of FOLDERS) {
    for (const relative of fs.readdirSync(path.join(root, folder), { recursive: true }).map(String).sort()) {
      const file = path.join(root, folder, relative);
      if (file === list || !fs.statSync(file).isFile()) continue;
      const hash = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
      lines.push(`${hash}  ${folder}/${relative.split(path.sep).join('/')}`);
    }
  }
  fs.writeFileSync(list, `${lines.join('\n')}\n`);
}
