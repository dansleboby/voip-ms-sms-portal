<?php

// The activity log the admins see.

declare(strict_types=1);

require __DIR__ . '/../harness.php';

use SmsPortal\Activity;
use SmsPortal\Http\Request;
use SmsPortal\Time;

function request(?array $user): Request
{
    $req = new Request('POST', '/api/x', [], [], [], '203.0.113.7', true);
    $req->user = $user;
    return $req;
}

test('records who did what, from where, the latest first', function (): void {
    $activity = new Activity(freshRepo());
    $activity->record(request(['sessionId' => 's', 'userId' => null, 'email' => null, 'name' => null, 'role' => 'owner']), 'team_enabled', 'julie@example.com');
    $activity->record(request(['sessionId' => 's', 'userId' => 4, 'email' => 'julie@example.com', 'name' => null, 'role' => 'admin']), 'user_changed', 'marc@example.com', ['changes' => ['numbers']]);
    $activity->recordAs(null, request(null), 'sign_in_failed', 'marc@example.com');
    $page = $activity->page(null);
    assertFalse($page['more']);
    assertSame(['sign_in_failed', 'user_changed', 'team_enabled'], array_column($page['entries'], 'action'));
    [$failed, $changed, $enabled] = $page['entries'];
    assertSame(null, $failed['actor']);
    assertSame('203.0.113.7', $failed['ip']);
    // A user without a name goes by their email; the owner has neither.
    assertSame(['userId' => 4, 'name' => 'julie@example.com'], $changed['actor']);
    assertSame(['changes' => ['numbers']], $changed['detail']);
    assertSame(['userId' => null, 'name' => null], $enabled['actor']);
    assertSame(null, $enabled['detail']);
});

test('pages through it, and forgets what is older than its keeping time', function (): void {
    $activity = new Activity(freshRepo());
    $start = Time::nowMs();
    Time::travelTo($start - (Activity::KEEP_DAYS + 1) * Time::DAY_MS);
    $activity->recordAs(null, request(null), 'sign_in_failed', 'old@example.com');
    Time::travelTo($start);
    for ($i = 0; $i < Activity::PAGE + 5; $i++) {
        $activity->recordAs(null, request(null), 'sign_in_failed', "user$i@example.com");
    }
    $first = $activity->page(null);
    assertSame(Activity::PAGE, count($first['entries']));
    assertTrue($first['more']);
    $second = $activity->page($first['entries'][Activity::PAGE - 1]['id']);
    assertSame(['user4@example.com', 'user3@example.com', 'user2@example.com', 'user1@example.com', 'user0@example.com'], array_column($second['entries'], 'target'));
    assertFalse($second['more'], 'the oldest one is gone');
    Time::travelTo(null);
});
