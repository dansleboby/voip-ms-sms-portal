<?php

// VoIP.ms dates: US Eastern wall-clock time, daylight saving included (server/time.test.ts).

declare(strict_types=1);

require __DIR__ . '/../harness.php';

use SmsPortal\Time;

const ZONE = 'America/New_York';

test('reads daylight-saving time (observed live: 18:24:20 UTC came back as 14:24:20)', function (): void {
    assertSame(strtotime('2026-10-02T18:24:20Z') * 1000, Time::zonedToEpoch('2026-10-02 14:24:20', ZONE));
});

test('moves the clock for tests', function (): void {
    Time::travelTo(1_000_000);
    assertTrue(abs(Time::nowMs() - 1_000_000) < 1000);
});
