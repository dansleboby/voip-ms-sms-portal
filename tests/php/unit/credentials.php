<?php

// The VoIP.ms credentials entered in the setup wizard.

declare(strict_types=1);

require __DIR__ . '/../harness.php';

use SmsPortal\Credentials;

test('encrypts with a key derived from APP_PASSWORD', function (): void {
    $repo = freshRepo();
    $store = new Credentials($repo, 'app-pw', null);
    $store->save(['username' => 'me@example.com', 'password' => 'api-pw']);
    assertFalse(str_contains((string) $repo->getSetting('voipms.credentials'), 'api-pw'), 'the password is stored in clear');
    assertSame(['username' => 'me@example.com', 'password' => 'api-pw'], $store->get());
    assertSame('db', $store->source());
    assertSame(null, (new Credentials($repo, 'other-pw', null))->get());
});

test('prefers environment credentials', function (): void {
    $store = new Credentials(freshRepo(), 'app-pw', ['username' => 'env@example.com', 'password' => 'p']);
    assertSame('env', $store->source());
    assertThrows(LogicException::class, fn () => $store->save(['username' => 'x', 'password' => 'y']));
});
