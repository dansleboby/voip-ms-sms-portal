import type { Repo } from './db.js';
import type { InstallKind, ReleaseDto, UpdateStatusDto } from '../shared/types.js';

/**
 * Tells Settings whether a newer version was published, from the
 * release.json every release carries (scripts/release-manifest.mjs).
 * Fetched at most every 6 hours unless asked; the answer is kept in the
 * settings table. The Docker and source installs update by hand: Settings
 * gives the commands.
 */

const LATEST_KEY = 'update.latest';
const CHECKED_KEY = 'update.checkedAt';
const ERROR_KEY = 'update.error';
const CACHE_MS = 6 * 60 * 60 * 1000;
const MAX_NOTES = 20_000;

/** The parts of release.json a server reads. */
export interface ReleaseManifest extends ReleaseDto {
  cpanel: { url: string; sha256: string; size: number } | null;
}

/** release.json as published, or null when it does not have the expected shape. */
export function parseManifest(data: unknown): ReleaseManifest | null {
  if (typeof data !== 'object' || data === null) return null;
  const m = data as Record<string, unknown>;
  if (typeof m.version !== 'string' || !/^\d+\.\d+\.\d+$/.test(m.version)) return null;
  if (typeof m.url !== 'string' || !/^https?:\/\//.test(m.url)) return null;
  const cpanel = m.cpanel as Record<string, unknown> | undefined;
  const validZip =
    typeof cpanel?.url === 'string' && /^https?:\/\//.test(cpanel.url) && typeof cpanel.sha256 === 'string' && /^[0-9a-f]{64}$/.test(cpanel.sha256);
  return {
    version: m.version,
    publishedAt: typeof m.publishedAt === 'string' ? m.publishedAt : null,
    url: m.url,
    notes: typeof m.notes === 'string' ? m.notes.slice(0, MAX_NOTES) : '',
    cpanel: validZip ? { url: cpanel.url as string, sha256: cpanel.sha256 as string, size: Number(cpanel.size) || 0 } : null,
  };
}

/** True when version `a` comes after `b` ("1.10.0" after "1.9.2"); false for anything that is not X.Y.Z. */
export function isNewer(a: string, b: string): boolean {
  const pa = /^(\d+)\.(\d+)\.(\d+)$/.exec(a);
  const pb = /^(\d+)\.(\d+)\.(\d+)$/.exec(b);
  if (!pa || !pb) return false;
  for (let i = 1; i <= 3; i++) {
    if (Number(pa[i]) !== Number(pb[i])) return Number(pa[i]) > Number(pb[i]);
  }
  return false;
}

export interface UpdateDeps {
  repo: Repo;
  version: string;
  enabled: boolean;
  manifestUrl: string;
  install: Exclude<InstallKind, 'php'>;
  fetch?: typeof fetch;
  now?: () => number;
}

export class UpdateChecker {
  private readonly now: () => number;

  constructor(private readonly deps: UpdateDeps) {
    this.now = deps.now ?? Date.now;
  }

  /** Checks again when the last answer is stale, or when asked to. */
  async status(refresh = false): Promise<UpdateStatusDto> {
    const { repo } = this.deps;
    const checkedAt = Number(repo.getSetting(CHECKED_KEY) ?? 0) || null;
    if (this.deps.enabled && (refresh || !checkedAt || this.now() - checkedAt > CACHE_MS)) await this.check();
    const stored = repo.getSetting(LATEST_KEY);
    const latest = stored ? parseManifest(JSON.parse(stored)) : null;
    return {
      current: this.deps.version,
      install: this.deps.install,
      enabled: this.deps.enabled,
      latest: latest && { version: latest.version, publishedAt: latest.publishedAt, url: latest.url, notes: latest.notes },
      available: latest !== null && isNewer(latest.version, this.deps.version),
      checkedAt: Number(repo.getSetting(CHECKED_KEY) ?? 0) || null,
      error: repo.getSetting(ERROR_KEY),
      canInstall: false,
      blocked: null,
    };
  }

  private async check(): Promise<void> {
    const { repo } = this.deps;
    let error: string | null = null;
    try {
      const res = await (this.deps.fetch ?? fetch)(this.deps.manifestUrl, {
        headers: { 'user-agent': `voip-ms-sms-portal/${this.deps.version}`, accept: 'application/json' },
        signal: AbortSignal.timeout(15_000),
      });
      if (res.status === 404) {
        // No release published yet.
        repo.deleteSetting(LATEST_KEY);
      } else if (!res.ok) {
        error = 'unreachable';
      } else {
        const manifest = parseManifest(await res.json().catch(() => null));
        if (manifest) repo.setSetting(LATEST_KEY, JSON.stringify(manifest));
        else error = 'invalid_manifest';
      }
    } catch {
      error = 'unreachable';
    }
    repo.setSetting(CHECKED_KEY, String(this.now()));
    if (error) repo.setSetting(ERROR_KEY, error);
    else repo.deleteSetting(ERROR_KEY);
  }
}
