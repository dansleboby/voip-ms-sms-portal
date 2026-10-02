import { locale, t } from '../i18n';
import { formatPhone } from '../../../shared/phone';
import type { ContactRef, DidDto } from '../../../shared/types';

const DAY = 24 * 60 * 60 * 1000;

function startOfDay(ms: number): number {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

export function formatTime(ms: number): string {
  return new Intl.DateTimeFormat(locale(), { hour: 'numeric', minute: '2-digit' }).format(ms);
}

/** Compact stamp for the conversation list: time today, "Yesterday", weekday this week, then a date. */
export function formatListDate(ms: number, now = Date.now()): string {
  const today = startOfDay(now);
  if (ms >= today) return formatTime(ms);
  if (ms >= today - DAY) return t('thread.yesterday');
  if (ms >= today - 6 * DAY) return new Intl.DateTimeFormat(locale(), { weekday: 'short' }).format(ms);
  const sameYear = new Date(ms).getFullYear() === new Date(now).getFullYear();
  return new Intl.DateTimeFormat(locale(), sameYear ? { day: 'numeric', month: 'short' } : { dateStyle: 'medium' }).format(ms);
}

/** Separator between days inside a thread. */
export function formatDayHeader(ms: number, now = Date.now()): string {
  const today = startOfDay(now);
  if (ms >= today) return t('thread.today');
  if (ms >= today - DAY) return t('thread.yesterday');
  const sameYear = new Date(ms).getFullYear() === new Date(now).getFullYear();
  const text = new Intl.DateTimeFormat(locale(), {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    ...(sameYear ? {} : { year: 'numeric' }),
  }).format(ms);
  return text.charAt(0).toUpperCase() + text.slice(1);
}

export function isSameDay(a: number, b: number): boolean {
  return startOfDay(a) === startOfDay(b);
}

export function displayName(phone: string, contact: ContactRef | null | undefined): string {
  return contact?.name || formatPhone(phone);
}

export function didName(did: DidDto | undefined, fallback: string): string {
  return did?.label || formatPhone(did?.did ?? fallback);
}

/** Up to two initials, or null when the name is a phone number. */
export function initials(name: string): string | null {
  if (!/\p{L}/u.test(name)) return null;
  const words = name.trim().split(/\s+/).filter((w) => /\p{L}/u.test(w));
  const letters = words.length > 1 ? [words[0]!, words[words.length - 1]!] : words.slice(0, 1);
  return letters.map((w) => [...w][0]!.toUpperCase()).join('');
}

const AVATAR_COLORS = ['#1a73e8', '#e37400', '#1e8e3e', '#d93025', '#9334e6', '#12a4af', '#e52592', '#7cb342'];

/** Stable color per phone number. */
export function avatarColor(seed: string): string {
  let h = 0;
  for (const c of seed) h = (h * 31 + c.charCodeAt(0)) | 0;
  return AVATAR_COLORS[Math.abs(h) % AVATAR_COLORS.length]!;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} o`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} Ko`;
  return `${(bytes / 1024 / 1024).toFixed(1)} Mo`;
}

/** Splits text into plain and link segments for safe rendering. */
export function linkify(text: string): { text: string; href?: string }[] {
  const parts: { text: string; href?: string }[] = [];
  const re = /\b(https?:\/\/[^\s<]+[^\s<.,;:!?)\]'"»])|\b(www\.[^\s<]+[^\s<.,;:!?)\]'"»])/gi;
  let last = 0;
  for (const m of text.matchAll(re)) {
    if (m.index! > last) parts.push({ text: text.slice(last, m.index) });
    const url = m[0];
    parts.push({ text: url, href: url.startsWith('http') ? url : `https://${url}` });
    last = m.index! + url.length;
  }
  if (last < text.length) parts.push({ text: text.slice(last) });
  return parts;
}

/** True for messages made only of 1-3 emoji, shown larger like in Google Messages. */
export function isEmojiOnly(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed || trimmed.length > 16) return false;
  const stripped = trimmed.replace(/\p{Extended_Pictographic}|\p{Emoji_Modifier}|‍|️|\s/gu, '');
  if (stripped.length) return false;
  const count = [...trimmed.matchAll(/\p{Extended_Pictographic}/gu)].length;
  return count > 0 && count <= 3;
}
