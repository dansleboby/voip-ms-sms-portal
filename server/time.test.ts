import { describe, expect, it } from 'vitest';
import { epochToZonedDate, epochToZonedDateTime, zonedToEpoch } from './time.js';
import { datesBetween, splitWindows } from './sync.js';

const TZ = 'America/New_York';

describe('VoIP.ms dates', () => {
  it('reads daylight-saving time (observed live: 18:24:20 UTC came back as 14:24:20)', () => {
    expect(new Date(zonedToEpoch('2026-10-02 14:24:20', TZ)).toISOString()).toBe('2026-10-02T18:24:20.000Z');
  });

  it('reads standard time', () => {
    expect(new Date(zonedToEpoch('2026-01-15 10:00:00', TZ)).toISOString()).toBe('2026-01-15T15:00:00.000Z');
  });

  it('handles the days of the DST changes', () => {
    expect(new Date(zonedToEpoch('2026-03-08 03:30:00', TZ)).toISOString()).toBe('2026-03-08T07:30:00.000Z');
    expect(new Date(zonedToEpoch('2026-11-01 12:00:00', TZ)).toISOString()).toBe('2026-11-01T17:00:00.000Z');
  });

  it('round-trips', () => {
    const t = Date.UTC(2026, 6, 4, 3, 5, 9);
    expect(zonedToEpoch(epochToZonedDateTime(t, TZ), TZ)).toBe(t);
  });

  it('gives the Eastern calendar date', () => {
    expect(epochToZonedDate(Date.UTC(2026, 9, 3, 2, 0, 0), TZ)).toBe('2026-10-02');
  });

  it('rejects unexpected formats', () => {
    expect(() => zonedToEpoch('02/10/2026', TZ)).toThrow();
  });
});

describe('sync windows', () => {
  const DAY = 86_400_000;

  it('covers the whole range with windows of at most N days', () => {
    const from = Date.UTC(2026, 0, 1, 12);
    const to = from + 100 * DAY;
    const windows = splitWindows(from, to, 30);
    expect(windows[0]![0]).toBe(from);
    expect(windows.at(-1)![1]).toBe(to);
    for (const [a, b] of windows) expect(b - a).toBeLessThanOrEqual(29 * DAY);
    for (let i = 1; i < windows.length; i++) expect(windows[i]![0]).toBeLessThanOrEqual(windows[i - 1]![1]);
  });

  it('lists every calendar date across a DST change', () => {
    const from = zonedToEpoch('2026-03-07 23:30:00', TZ);
    const to = zonedToEpoch('2026-03-10 00:30:00', TZ);
    expect(datesBetween(from, to, TZ)).toEqual(['2026-03-07', '2026-03-08', '2026-03-09', '2026-03-10']);
  });
});
