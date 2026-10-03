/*
 * Service worker: displays push notifications and opens the conversation
 * when one is clicked. It does not cache anything; the app always loads
 * from the server.
 */

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { body: event.data ? event.data.text() : '' };
  }
  const work = [
    self.registration.showNotification(data.title || 'SMS', {
      body: data.body || '',
      tag: data.tag,
      // A new text in the same conversation replaces the notification but still alerts.
      renotify: Boolean(data.tag),
      icon: '/icon-192.png',
      badge: '/badge-96.png',
      timestamp: data.timestamp,
      data: { url: data.url || '/' },
    }),
  ];
  // Unread count on the app icon (iPhone, Windows, macOS; Android counts notifications itself).
  if (typeof data.unread === 'number' && 'setAppBadge' in self.navigator) {
    const badge = data.unread > 0 ? self.navigator.setAppBadge(data.unread) : self.navigator.clearAppBadge();
    work.push(badge.catch(() => undefined));
  }
  event.waitUntil(Promise.all(work));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const path = (event.notification.data && event.notification.data.url) || '/';
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      const client = windows.find((c) => c.visibilityState === 'visible') || windows[0];
      if (client) {
        await client.focus().catch(() => undefined);
        client.postMessage({ type: 'open', url: path });
        return;
      }
      await self.clients.openWindow(new URL(path, self.location.origin).href);
    })(),
  );
});

// The browser renewed the subscription: hand the new one to the server.
self.addEventListener('pushsubscriptionchange', (event) => {
  event.waitUntil(
    (async () => {
      const old = event.oldSubscription;
      let subscription = event.newSubscription;
      if (!subscription) {
        const key =
          (old && old.options && old.options.applicationServerKey) ||
          (await fetch('/api/push/key').then((r) => r.json())).publicKey;
        subscription = await self.registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
      }
      await fetch('/api/push/subscriptions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...subscription.toJSON(), replaces: old ? old.endpoint : undefined }),
      });
    })(),
  );
});
