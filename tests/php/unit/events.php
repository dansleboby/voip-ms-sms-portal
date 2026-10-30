<?php

// Live updates for polling tabs (server/events.test.ts). The Docker version
// kept them in memory; here the events and the tabs live in the database,
// since each request is a process of its own.

declare(strict_types=1);

require __DIR__ . '/../harness.php';

use SmsPortal\Events;
use SmsPortal\Repo;
use SmsPortal\Time;

const START = 1_000_000_000;

/** The tabs still counted as open, as the cron job leaves them after its pruning. */
function openTabs(Repo $repo, Events $events): int
{
    $events->prune();
    return (int) $repo->run('SELECT COUNT(*) FROM tabs')->fetchColumn();
}

test('get the events after their cursor, once', function (): void {
    $events = new Events(freshRepo());
    $first = $events->poll(null, 'tab-00000001', null, true);
    assertSame([], $first['events']);
    assertFalse($first['reset']);
    $events->broadcast(['type' => 'dids']);
    $events->broadcast(['type' => 'contacts']);
    $next = $events->poll($first['cursor'], 'tab-00000001', null, true);
    assertSame([['type' => 'dids'], ['type' => 'contacts']], $next['events']);
    assertFalse($next['reset']);
    assertSame(['cursor' => $next['cursor'], 'events' => [], 'reset' => false], $events->poll($next['cursor'], 'tab-00000001', null, true));
});

test('start over with a cursor of another database, a malformed cursor or after falling too far behind', function (): void {
    // The Docker version started over after a restart; here the cursors die with the database they came from.
    $events = new Events(freshRepo());
    $elsewhere = (new Events(freshRepo()))->poll(null, null, null, true)['cursor'];
    assertTrue($events->poll($elsewhere, null, null, true)['reset']);
    $cursor = $events->poll(null, null, null, true)['cursor'];
    foreach (['garbage', "{$cursor}x", preg_replace('/\.\d+$/', '.', $cursor), preg_replace('/\.\d+$/', '.99', $cursor)] as $bad) {
        assertTrue($events->poll($bad, null, null, true)['reset'], "cursor \"$bad\"");
    }
    for ($i = 0; $i < 500; $i++) {
        $events->broadcast(['type' => 'reload']);
    }
    $events->prune();
    assertFalse($events->poll($cursor, null, null, true)['reset']);
    $events->broadcast(['type' => 'reload']);
    // The backlog is trimmed when the cron job prunes it, not on each event.
    $events->prune();
    $behind = $events->poll($cursor, null, null, true);
    assertSame([], $behind['events']);
    assertTrue($behind['reset']);
});

test('count as open tabs until they stop polling', function (): void {
    Time::travelTo(START);
    $repo = freshRepo();
    $events = new Events($repo);
    assertFalse($events->hasOpenTabs());
    $events->poll(null, 'tab-00000001', null, true);
    $events->poll(null, 'tab-00000001', null, true);
    $events->poll(null, 'tab-00000002', null, true);
    assertTrue($events->hasOpenTabs());
    assertSame(2, openTabs($repo, $events));
    Time::travelTo(START + 60_000);
    $events->poll(null, 'tab-00000002', null, true);
    Time::travelTo(START + 120_000);
    assertSame(1, openTabs($repo, $events));
    assertTrue($events->hasOpenTabs());
    Time::travelTo(START + 240_000);
    assertFalse($events->hasOpenTabs());
});

test('hide push notifications on their device while visible and polling', function (): void {
    Time::travelTo(START);
    $repo = freshRepo();
    $events = new Events($repo);
    $events->poll(null, 'tab-00000001', 'device-0001', true);
    assertTrue($events->isOnScreen('device-0001'));
    assertFalse($events->isOnScreen('device-0002'));
    assertTrue($events->setVisibility('tab-00000001', false));
    assertFalse($events->isOnScreen('device-0001'));
    assertFalse($events->setVisibility('tab-00000009', false), 'a tab that never polled');
    $events->poll(null, 'tab-00000001', 'device-0001', true);
    assertTrue($events->isOnScreen('device-0001'));
    // A tab closed without a word stops counting as on screen long before it expires.
    Time::travelTo(START + 20_000);
    assertFalse($events->isOnScreen('device-0001'));
    assertSame(1, openTabs($repo, $events));
});
