import { useSyncExternalStore } from 'react';
import { en } from './en';
import { fr, type MessageKey } from './fr';
import { prefs } from '../lib/prefs';

export type Lang = 'fr' | 'en';
const dictionaries: Record<Lang, Record<MessageKey, string>> = { fr, en };

export function detectLang(): Lang {
  const chosen = prefs.get('lang');
  if (chosen === 'fr' || chosen === 'en') return chosen;
  return navigator.language.toLowerCase().startsWith('fr') ? 'fr' : 'en';
}

let current: Lang = detectLang();
const listeners = new Set<() => void>();

export function setLang(choice: Lang | 'auto'): void {
  prefs.set('lang', choice === 'auto' ? null : choice);
  current = detectLang();
  document.documentElement.lang = current;
  listeners.forEach((l) => l());
}

export function getLang(): Lang {
  return current;
}

/** BCP 47 locale for Intl formatting. */
export function locale(): string {
  return current === 'fr' ? 'fr-CA' : 'en-CA';
}

export function t(key: MessageKey, params?: Record<string, string | number>): string {
  let text = dictionaries[current][key] ?? fr[key] ?? key;
  if (params) {
    for (const [k, v] of Object.entries(params)) text = text.replaceAll(`{${k}}`, String(v));
  }
  return text;
}

/** Message for a server/VoIP.ms error code. */
export function errorText(code: string): string {
  const key = `error.${code}` as MessageKey;
  return key in fr ? t(key) : t('error.unknown', { code });
}

/** Re-renders the calling component when the language changes. */
export function useLang(): Lang {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => current,
  );
}

document.documentElement.lang = current;
