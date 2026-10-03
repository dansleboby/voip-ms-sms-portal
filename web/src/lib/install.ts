import { useSyncExternalStore } from 'react';

/**
 * Installing the app on the home screen. Chrome and Edge on Android fire
 * `beforeinstallprompt`, which lets the page open the native install dialog
 * from its own button; Safari on iPhone has no such event, so the page can
 * only explain the Share → "Add to Home Screen" steps.
 */

interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

let deferred: BeforeInstallPromptEvent | null = null;
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((l) => l());

// Registered at load: the event fires once, soon after the page opens.
window.addEventListener('beforeinstallprompt', (event) => {
  // Keeps Chrome's own mini-infobar away; the page offers it at a better moment.
  event.preventDefault();
  deferred = event as BeforeInstallPromptEvent;
  notify();
});
window.addEventListener('appinstalled', () => {
  deferred = null;
  notify();
});

/** True when the browser can show its install dialog right now. */
export function useCanInstall(): boolean {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => deferred !== null,
  );
}

/** Opens the native install dialog; resolves with true when the user installed the app. */
export async function promptInstall(): Promise<boolean> {
  const event = deferred;
  if (!event) return false;
  deferred = null;
  notify();
  await event.prompt();
  return (await event.userChoice).outcome === 'accepted';
}

/** Running from the home screen icon rather than a browser tab. */
export function isInstalled(): boolean {
  return window.matchMedia('(display-mode: standalone)').matches || (navigator as { standalone?: boolean }).standalone === true;
}

export function isIos(): boolean {
  return /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
}

/**
 * Unread count on the installed app's icon, where the platform has the
 * Badging API (iPhone and iPad 16.4+, Chrome and Edge on Windows and macOS).
 * Android shows its own dot for unread notifications instead.
 */
export function setIconBadge(count: number): void {
  if (!('setAppBadge' in navigator)) return;
  (count > 0 ? navigator.setAppBadge(count) : navigator.clearAppBadge()).catch(() => undefined);
}

/** Phones and tablets: where installing the app and push notifications matter most. */
export function isTouchDevice(): boolean {
  return window.matchMedia('(pointer: coarse)').matches;
}
