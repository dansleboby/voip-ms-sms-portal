import { api } from '../api';
import { getLang } from '../i18n';
import { prefs } from './prefs';
import { navigate, parseRoute } from './router';

/**
 * Web Push: notifications from the server when no tab shows the app
 * (closed app, locked phone, hidden tab). Each browser has a random device
 * id, shared by its push subscription and its open tabs, so the server can
 * skip the device where the app is on screen.
 */

function randomId(): string {
  // crypto.randomUUID needs a secure context; the device id is also used over plain http.
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('');
}

export function deviceId(): string {
  let id = prefs.get('device');
  if (!id || !/^[\w-]{8,64}$/.test(id)) {
    id = randomId();
    prefs.set('device', id);
  }
  return id;
}

/** Id of this tab's event stream, to report its visibility. */
export const tabId = randomId();

export type PushSupport = 'ok' | 'insecure' | 'ios-install' | 'unsupported';

export function pushSupport(): PushSupport {
  if (!window.isSecureContext) return 'insecure';
  const ios = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const standalone = window.matchMedia('(display-mode: standalone)').matches;
  if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) {
    // Safari on iPhone only offers push to apps added to the home screen.
    return ios && !standalone ? 'ios-install' : 'unsupported';
  }
  return 'ok';
}

let registration: Promise<ServiceWorkerRegistration | null> | null = null;

/** Registers /sw.js once; resolves with null where service workers are unavailable. */
export function serviceWorker(): Promise<ServiceWorkerRegistration | null> {
  if (!registration) {
    registration =
      'serviceWorker' in navigator && window.isSecureContext
        ? navigator.serviceWorker
            .register('/sw.js')
            .then(() => navigator.serviceWorker.ready)
            .catch(() => null)
        : Promise.resolve(null);
    // Clicking a notification focuses an open tab and asks it to show the conversation.
    navigator.serviceWorker?.addEventListener('message', (event: MessageEvent<{ type?: string; url?: string }>) => {
      if (event.data?.type === 'open' && event.data.url?.startsWith('/')) {
        const [pathname, search] = event.data.url.split('?');
        navigate(parseRoute(pathname ?? '/', search ? `?${search}` : ''));
      }
    });
  }
  return registration;
}

async function currentSubscription(): Promise<PushSubscription | null> {
  const reg = await serviceWorker();
  return reg ? reg.pushManager.getSubscription() : null;
}

/** True when this browser is subscribed (as last seen); the page then leaves hidden-tab alerts to push. */
export function pushEnabledHere(): boolean {
  return prefs.get('push') === 'on' && 'Notification' in window && Notification.permission === 'granted';
}

function sameKey(subscription: PushSubscription, publicKey: string): boolean {
  const current = subscription.options.applicationServerKey;
  if (!current) return true;
  const bytes = new Uint8Array(current);
  const expected = base64UrlToBytes(publicKey);
  return bytes.length === expected.length && bytes.every((b, i) => b === expected[i]);
}

function base64UrlToBytes(value: string): Uint8Array<ArrayBuffer> {
  const base64 = value.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(value.length / 4) * 4, '=');
  return Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
}

async function register(subscription: PushSubscription): Promise<void> {
  await api.savePushSubscription({ ...(subscription.toJSON() as object), device: deviceId(), lang: getLang() });
}

/** Asks for permission (must run from a click) and subscribes this browser. */
export async function enablePush(): Promise<'ok' | 'denied'> {
  const permission = Notification.permission === 'default' ? await Notification.requestPermission() : Notification.permission;
  if (permission !== 'granted') return 'denied';
  const reg = await serviceWorker();
  if (!reg) throw new Error('service_worker_unavailable');
  const { publicKey } = await api.pushKey();
  let subscription = await reg.pushManager.getSubscription();
  if (subscription && !sameKey(subscription, publicKey)) {
    await subscription.unsubscribe();
    subscription = null;
  }
  subscription ??= await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: base64UrlToBytes(publicKey) });
  await register(subscription);
  prefs.set('push', 'on');
  return 'ok';
}

export async function disablePush(): Promise<void> {
  prefs.set('push', null);
  const subscription = await currentSubscription().catch(() => null);
  if (!subscription) return;
  await api.unsubscribePush(subscription.endpoint).catch(() => undefined);
  await subscription.unsubscribe().catch(() => undefined);
}

export async function sendTestPush(): Promise<void> {
  const subscription = await currentSubscription();
  if (!subscription) throw new Error('not_subscribed');
  await api.testPush(subscription.endpoint);
}

/**
 * On startup: re-sends the subscription (the server may have lost it, or the
 * language changed) and renews it if the server's key changed.
 */
export async function refreshPush(): Promise<void> {
  if (pushSupport() !== 'ok') return;
  const reg = await serviceWorker();
  if (!reg || prefs.get('push') !== 'on') return;
  if (Notification.permission !== 'granted') {
    prefs.set('push', null);
    return;
  }
  const subscription = await reg.pushManager.getSubscription();
  const { publicKey } = await api.pushKey();
  if (!subscription || !sameKey(subscription, publicKey)) {
    await enablePush();
    return;
  }
  await register(subscription);
}

/** Removes the notifications of a conversation once it is on screen. */
export async function clearNotifications(conversationId: number): Promise<void> {
  const reg = await serviceWorker();
  if (!reg) return;
  for (const n of await reg.getNotifications({ tag: `conversation-${conversationId}` })) n.close();
}
