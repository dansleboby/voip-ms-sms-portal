import { prefs } from './prefs';

export type Theme = 'system' | 'light' | 'dark';

export function getTheme(): Theme {
  const value = prefs.get('theme');
  return value === 'light' || value === 'dark' ? value : 'system';
}

export function applyTheme(theme: Theme = getTheme()): void {
  prefs.set('theme', theme === 'system' ? null : theme);
  if (theme === 'system') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.dataset.theme = theme;
  const dark = theme === 'dark' || (theme === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', dark ? '#1b1b1c' : '#f8fafd');
}
