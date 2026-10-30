<?php

// Sign-ins and their sessions (server/security.test.ts, "Auth").

declare(strict_types=1);

require __DIR__ . '/../harness.php';

use SmsPortal\Auth;
use SmsPortal\Passwords;
use SmsPortal\Time;

/** The fields of $session the case is about, as toMatchObject() checks them. */
function pick(?array $session, string ...$keys): ?array
{
    return $session === null ? null : array_intersect_key($session, array_flip($keys));
}

test('checks the password and verifies its own sessions', function (): void {
    $repo = freshRepo();
    $auth = new Auth($repo, 'pw', 30);
    assertTrue($auth->checkPassword('pw'));
    assertFalse($auth->checkPassword('PW'));
    $token = $auth->open(null, 'Firefox');
    assertSame(['userId' => null, 'role' => 'owner'], pick($auth->verify($token), 'userId', 'role'));
    assertSame(null, $auth->verify(substr($token, 0, -2) . 'xx'));
    assertSame(null, $auth->verify(null));
    // The table keeps a hash of the id: a stolen row signs nobody in.
    [$id] = explode('.', $token);
    assertSame(null, $repo->getSession($id));
});

test('expires sessions, and ends them on sign-out', function (): void {
    $auth = new Auth(freshRepo(), 'pw', 1);
    assertSame(null, $auth->verify($auth->open(null, null, Time::nowMs() - 2 * Time::DAY_MS)));
    $token = $auth->open(null, null);
    $auth->close($auth->verify($token)['sessionId']);
    assertSame(null, $auth->verify($token));
});

test('signs everyone out when APP_PASSWORD changes', function (): void {
    $repo = freshRepo();
    $token = (new Auth($repo, 'old', 30))->open(null, null);
    assertSame(null, (new Auth($repo, 'new', 30))->verify($token));
});

test('only lets users in while the Team mode is on and their account is enabled', function (): void {
    $repo = freshRepo();
    $auth = new Auth($repo, 'pw', 30);
    $id = $repo->createUser('ana@example.com', 'Ana', Passwords::hash('x', 1000), 'user');
    $token = $auth->open($id, null);
    assertSame(null, $auth->verify($token));
    $repo->setSetting(Auth::TEAM_KEY, '1');
    assertSame(['userId' => $id, 'email' => 'ana@example.com', 'role' => 'user'], pick($auth->verify($token), 'userId', 'email', 'role'));
    $repo->updateUser($id, ['disabled' => true]);
    assertSame(null, $auth->verify($token));
});
