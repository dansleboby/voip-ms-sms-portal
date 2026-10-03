import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Version of the app, from its package.json. Read from the file rather than
 * npm_package_version, which only exists under "npm start": the Docker image
 * runs node directly.
 */
export function readVersion(from = path.dirname(fileURLToPath(import.meta.url))): string {
  for (let dir = from; ; dir = path.dirname(dir)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')) as { name?: string; version?: string };
      if (pkg.name === 'voip-ms-sms-portal' && pkg.version) return pkg.version;
    } catch {
      // No package.json here: keep going up.
    }
    if (path.dirname(dir) === dir) return 'unknown';
  }
}

export const VERSION = readVersion();
