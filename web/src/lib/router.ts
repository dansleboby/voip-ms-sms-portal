import { useSyncExternalStore } from 'react';

/** Tiny history-API router: the app has a handful of flat routes. */

export type Route =
  | { name: 'home' }
  | { name: 'conversation'; id: number }
  | { name: 'new'; phone?: string }
  | { name: 'contacts' }
  | { name: 'settings' }
  | { name: 'setup' };

export function parseRoute(path: string, search = ''): Route {
  const conv = /^\/c\/(\d+)\/?$/.exec(path);
  if (conv) return { name: 'conversation', id: Number(conv[1]) };
  if (path.startsWith('/new')) {
    const phone = new URLSearchParams(search).get('to') ?? undefined;
    return { name: 'new', phone };
  }
  if (path.startsWith('/contacts')) return { name: 'contacts' };
  if (path.startsWith('/settings')) return { name: 'settings' };
  if (path.startsWith('/setup')) return { name: 'setup' };
  return { name: 'home' };
}

export function routePath(route: Route): string {
  switch (route.name) {
    case 'conversation':
      return `/c/${route.id}`;
    case 'new':
      return route.phone ? `/new?to=${encodeURIComponent(route.phone)}` : '/new';
    case 'contacts':
      return '/contacts';
    case 'settings':
      return '/settings';
    case 'setup':
      return '/setup';
    default:
      return '/';
  }
}

const listeners = new Set<() => void>();
let snapshot = location.pathname + location.search;
window.addEventListener('popstate', () => {
  snapshot = location.pathname + location.search;
  listeners.forEach((l) => l());
});

export function navigate(route: Route, options: { replace?: boolean } = {}): void {
  const path = routePath(route);
  if (path === location.pathname + location.search) return;
  if (options.replace) history.replaceState(null, '', path);
  else history.pushState(null, '', path);
  snapshot = path;
  listeners.forEach((l) => l());
}

export function useRoute(): Route {
  const path = useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => snapshot,
  );
  const [pathname, search] = path.split('?');
  return parseRoute(pathname ?? '/', search ? `?${search}` : '');
}
