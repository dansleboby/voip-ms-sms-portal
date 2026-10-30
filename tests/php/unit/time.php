<?php

// VoIP.ms dates: US Eastern wall-clock time, daylight saving included (server/time.test.ts).

declare(strict_types=1);

require __DIR__ . '/../harness.php';

use SmsPortal\Sync;
use SmsPortal\Time;

const ZONE = 'America/New_York';
const DAY = 86_400_000;

/** "2026-10-02T18:24:20Z" -> epoch milliseconds. */
function utc(string $iso): int
{
    return (new DateTimeImmutable($iso))->getTimestamp() * 1000;
}

test('reads daylight-saving time (observed live: 18:24:20 UTC came back as 14:24:20)', function (): void {
    assertSame(utc('2026-10-02T18:24:20Z'), Time::zonedToEpoch('2026-10-02 14:24:20', ZONE));
});

test('reads standard time', function (): void {
    assertSame(utc('2026-01-15T15:00:00Z'), Time::zonedToEpoch('2026-01-15 10:00:00', ZONE));
});

test('handles the days of the DST changes', function (): void {
    assertSame(utc('2026-03-08T07:30:00Z'), Time::zonedToEpoch('2026-03-08 03:30:00', ZONE));
    assertSame(utc('2026-11-01T17:00:00Z'), Time::zonedToEpoch('2026-11-01 12:00:00', ZONE));
});

test('round-trips', function (): void {
    $t = utc('2026-07-04T03:05:09Z');
    assertSame($t, Time::zonedToEpoch(Time::epochToZonedDateTime($t, ZONE), ZONE));
});

test('gives the Eastern calendar date', function (): void {
    // 2 a.m. UTC is still the evening before in Montréal.
    assertSame('2026-10-02', Time::epochToZonedDate(utc('2026-10-03T02:00:00Z'), ZONE));
});

test('rejects unexpected formats', function (): void {
    assertThrows(InvalidArgumentException::class, fn () => Time::zonedToEpoch('02/10/2026', ZONE));
});

test('moves the clock for tests', function (): void {
    Time::travelTo(1_000_000);
    assertTrue(abs(Time::nowMs() - 1_000_000) < 1000);
});

// Sync windows: VoIP.ms is asked for at most a month at a time (server/sync.ts).

test('covers the whole range with windows of at most N days', function (): void {
    $from = utc('2026-01-01T12:00:00Z');
    $to = $from + 100 * DAY;
    $windows = Sync::splitWindows($from, $to, 30);
    assertSame($from, $windows[0][0]);
    assertSame($to, $windows[count($windows) - 1][1]);
    foreach ($windows as [$a, $b]) {
        assertTrue($b - $a <= 29 * DAY, 'window longer than 29 days');
    }
    for ($i = 1; $i < count($windows); $i++) {
        assertTrue($windows[$i][0] <= $windows[$i - 1][1], "gap before window $i");
    }
});

test('lists every calendar date across a DST change', function (): void {
    $from = Time::zonedToEpoch('2026-03-07 23:30:00', ZONE);
    $to = Time::zonedToEpoch('2026-03-10 00:30:00', ZONE);
    assertSame(['2026-03-07', '2026-03-08', '2026-03-09', '2026-03-10'], Sync::datesBetween($from, $to, ZONE));
});
