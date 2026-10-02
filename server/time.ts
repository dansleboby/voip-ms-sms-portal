/**
 * VoIP.ms returns dates as "YYYY-MM-DD HH:mm:ss" in US Eastern time (DST-aware),
 * and filters by calendar dates in that same zone. Its `timezone` parameter is a
 * fixed offset from EST that ignores daylight saving, so we never send it and
 * convert with the IANA zone instead.
 */

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string): Intl.DateTimeFormat {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    formatters.set(timeZone, f);
  }
  return f;
}

function zonedParts(epochMs: number, timeZone: string): Record<string, number> {
  const parts: Record<string, number> = {};
  for (const p of formatter(timeZone).formatToParts(new Date(epochMs))) {
    if (p.type !== 'literal') parts[p.type] = Number(p.value);
  }
  return parts;
}

/** Offset of `timeZone` from UTC at the given instant, in milliseconds. */
function offsetMs(epochMs: number, timeZone: string): number {
  const p = zonedParts(epochMs, timeZone);
  const asUtc = Date.UTC(p.year!, p.month! - 1, p.day!, p.hour!, p.minute!, p.second!);
  return asUtc - (epochMs - (((epochMs % 1000) + 1000) % 1000));
}

/** "2026-10-02 14:24:20" (wall clock in `timeZone`) -> epoch milliseconds. */
export function zonedToEpoch(local: string, timeZone: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})$/.exec(local.trim());
  if (!m) throw new Error(`Unexpected VoIP.ms date: "${local}"`);
  const naive = Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!, +m[4]!, +m[5]!, +m[6]!);
  const first = offsetMs(naive, timeZone);
  const guess = naive - first;
  const second = offsetMs(guess, timeZone);
  return second === first ? guess : naive - second;
}

/** Calendar date ("YYYY-MM-DD") of an instant in `timeZone`. */
export function epochToZonedDate(epochMs: number, timeZone: string): string {
  const p = zonedParts(epochMs, timeZone);
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}

/** Wall-clock "YYYY-MM-DD HH:mm:ss" of an instant in `timeZone` (the format VoIP.ms uses). */
export function epochToZonedDateTime(epochMs: number, timeZone: string): string {
  const p = zonedParts(epochMs, timeZone);
  const pad = (n: number | undefined) => String(n).padStart(2, '0');
  return `${p.year}-${pad(p.month)}-${pad(p.day)} ${pad(p.hour)}:${pad(p.minute)}:${pad(p.second)}`;
}

export const DAY_MS = 24 * 60 * 60 * 1000;
