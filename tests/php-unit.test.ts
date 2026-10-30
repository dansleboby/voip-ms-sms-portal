import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The PHP server's own classes, tested in PHP (tests/php/harness.php): each
 * file of tests/php/unit runs in one php process, and each of its cases
 * shows up here as a test.
 */

const dir = path.join(import.meta.dirname, 'php/unit');

for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.php')).sort()) {
  const run = spawnSync('php', ['-d', 'zend.assertions=1', path.join(dir, file)], { encoding: 'utf8', timeout: 120_000 });
  const lines = (run.stdout ?? '').split('\n').filter((l) => l.startsWith('{'));
  const results = lines.map((l) => JSON.parse(l) as { name: string; ok: boolean; error?: string });

  describe(`PHP ${file}`, () => {
    it('runs', () => {
      // A file that crashes before its cases run says why here.
      expect(run.error?.message ?? (run.status === 0 ? '' : `exit ${run.status}: ${run.stderr}${run.stdout.split('\n').filter((l) => !l.startsWith('{')).join('\n')}`)).toBe('');
      expect(results.length).toBeGreaterThan(0);
    });
    for (const result of results) {
      it(result.name, () => {
        expect(result.error ?? '').toBe('');
      });
    }
  });
}
