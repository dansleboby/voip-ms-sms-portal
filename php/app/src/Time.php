<?php

declare(strict_types=1);

namespace SmsPortal;

/**
 * VoIP.ms dates are wall-clock "YYYY-MM-DD HH:mm:ss" in US Eastern time
 * (DST-aware), and it filters by calendar dates in that zone
 * (server/time.ts). Times are epoch milliseconds everywhere else.
 */
final class Time
{
    public const DAY_MS = 86_400_000;

    /** The clock moved by this much: by tests, and by DEMO_NOW for screenshots that come out the same every time. */
    private static ?int $offsetMs = null;

    public static function nowMs(): int
    {
        self::$offsetMs ??= self::demoOffset();
        return (int) floor(microtime(true) * 1000) + self::$offsetMs;
    }

    /** Moves the clock to $epochMs (null: back to the real time). For tests. */
    public static function travelTo(?int $epochMs): void
    {
        self::$offsetMs = $epochMs === null ? 0 : $epochMs - (int) floor(microtime(true) * 1000);
    }

    /** DEMO_NOW ("2026-09-29T21:30:00-04:00"), in demo mode only. */
    private static function demoOffset(): int
    {
        $now = getenv('DEMO_NOW');
        if ($now === false || $now === '' || !in_array(strtolower(trim((string) getenv('DEMO_MODE'))), ['1', 'true', 'yes', 'on'], true)) {
            return 0;
        }
        $at = strtotime($now);
        if ($at === false) {
            throw new \InvalidArgumentException("DEMO_NOW must be a date and time, like 2026-09-29T21:30:00-04:00, got \"$now\".");
        }
        return $at * 1000 - (int) floor(microtime(true) * 1000);
    }

    /** "2026-10-02 14:24:20" in $timeZone -> epoch milliseconds. */
    public static function zonedToEpoch(string $local, string $timeZone): int
    {
        if (!preg_match('/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})$/', trim($local), $m)) {
            throw new \InvalidArgumentException("Unexpected VoIP.ms date: \"$local\"");
        }
        $date = \DateTimeImmutable::createFromFormat('!Y-m-d H:i:s', "$m[1] $m[2]", new \DateTimeZone($timeZone));
        if ($date === false) {
            throw new \InvalidArgumentException("Unexpected VoIP.ms date: \"$local\"");
        }
        return $date->getTimestamp() * 1000;
    }

    /** Calendar date ("YYYY-MM-DD") of an instant in $timeZone. */
    public static function epochToZonedDate(int $epochMs, string $timeZone): string
    {
        return self::zoned($epochMs, $timeZone)->format('Y-m-d');
    }

    /** Wall-clock "YYYY-MM-DD HH:mm:ss" of an instant in $timeZone. */
    public static function epochToZonedDateTime(int $epochMs, string $timeZone): string
    {
        return self::zoned($epochMs, $timeZone)->format('Y-m-d H:i:s');
    }

    private static function zoned(int $epochMs, string $timeZone): \DateTimeImmutable
    {
        $seconds = intdiv($epochMs - (($epochMs % 1000) + 1000) % 1000, 1000);
        return (new \DateTimeImmutable('@' . $seconds))->setTimezone(new \DateTimeZone($timeZone));
    }
}
