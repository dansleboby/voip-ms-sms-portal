/** Per-browser preferences in localStorage; storage may be unavailable (private mode), so every access is guarded. */

type PrefKey = 'lang' | 'theme' | 'did' | 'notify' | 'sound' | `draft:${string}`;

const PREFIX = 'sms-portal:';

export const prefs = {
  get(key: PrefKey): string | null {
    try {
      return localStorage.getItem(PREFIX + key);
    } catch {
      return null;
    }
  },
  set(key: PrefKey, value: string | null): void {
    try {
      if (value === null) localStorage.removeItem(PREFIX + key);
      else localStorage.setItem(PREFIX + key, value);
    } catch {
      // Ignore: preferences are a convenience.
    }
  },
};
