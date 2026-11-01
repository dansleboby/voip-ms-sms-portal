<?php

// What the Docker image stored before 2.0, when it ran the Node server: its
// key came from scrypt, and the PHP server must still read with it what
// that one wrote (VoIP.ms credentials, the owner of the push subscriptions).

declare(strict_types=1);

require __DIR__ . '/../harness.php';

use SmsPortal\Credentials;
use SmsPortal\Events;
use SmsPortal\Push;
use SmsPortal\Scrypt;

/** Made by Node 1.8: crypto.scryptSync('hunter2', salt, 32), then its CredentialStore and PushService with that key. */
const SALT = 'AAECAwQFBgcICQoLDA0ODw==';
const NODE_CREDENTIALS = '{"iv":"AAECAwQFBgcICQoL","tag":"TDWmPNaoff+wKdxm6MCqkA==","data":"xBsJ9Gg1TKOPOqmvCeVnGO+IiOMCbreO4ILIRCpB3oySEa9opYe56+j0mQKieiM/MEk+b5E="}';
const NODE_PUSH_OWNER = '_gReXaNNJdRAFoYg2nVvE2NB7ppLQCDxTj_BTt5pz8k';

function nodeDatabase(): SmsPortal\Repo
{
    $repo = freshRepo();
    $repo->setSetting('crypto.salt', SALT);
    $repo->setSetting('voipms.credentials', NODE_CREDENTIALS);
    $repo->setSetting('push.owner', NODE_PUSH_OWNER);
    $repo->savePushSubscription(['endpoint' => 'https://fcm.googleapis.com/fcm/send/abc', 'p256dh' => 'key', 'auth' => 'auth', 'device' => 'device-0001', 'lang' => 'fr']);
    return $repo;
}

test('derives scrypt keys like RFC 7914 and Node', function (): void {
    assertSame(
        '77d6576238657b203b19ca42c18a0497f16b4844e3074ae8dfdffa3fede21442fcd0069ded0948f8326a753a0fc81f17e8d3e0fb2e0d3628cf35e20c38d18906',
        bin2hex(Scrypt::derive('', '', 16, 1, 1, 64)),
    );
    // Node's defaults (N 16384, r 8, p 1), as its CredentialStore called it.
    assertSame('c82fc216ae0ee83285a3ef4cf4dd5d754fe7d0bd00bcf9cc64be33ce199b4c0d', bin2hex(Scrypt::derive('hunter2', base64_decode(SALT))));
});

test('reads the credentials the Node server stored, then stores them its own way', function (): void {
    $repo = nodeDatabase();
    $expected = ['username' => 'me@example.com', 'password' => 'api-secret'];
    assertSame($expected, (new Credentials($repo, 'hunter2', null))->get());
    $stored = json_decode((string) $repo->getSetting('voipms.credentials'), true);
    assertSame('pbkdf2-sha256', $stored['kdf']);
    // From now on, without scrypt.
    assertSame($expected, (new Credentials($repo, 'hunter2', null))->get());
    assertSame('db', (new Credentials($repo, 'hunter2', null))->source());
});

test('with another APP_PASSWORD, gives up once and remembers it', function (): void {
    $repo = nodeDatabase();
    assertSame(null, (new Credentials($repo, 'other password', null))->get());
    $stored = json_decode((string) $repo->getSetting('voipms.credentials'), true);
    assertTrue(isset($stored['triedWith']), 'the attempt is remembered');
    $started = microtime(true);
    assertSame(null, (new Credentials($repo, 'other password', null))->get());
    assertTrue(microtime(true) - $started < 1, 'no second scrypt');
    // The right password still reads them.
    assertSame('me@example.com', (new Credentials($repo, 'hunter2', null))->get()['username'] ?? null);
});

test('keeps the push subscriptions of the same APP_PASSWORD, and only those', function (): void {
    foreach (['hunter2' => 1, 'other password' => 0] as $password => $kept) {
        $repo = nodeDatabase();
        $credentials = new Credentials($repo, $password, null);
        $push = new Push(
            $repo,
            new Events($repo),
            'mailto:me@example.com',
            fn () => $credentials->fingerprint('push-subscriptions'),
            fn () => $credentials->legacyFingerprint('push-subscriptions'),
        );
        $push->checkOwner();
        assertSame($kept, count($repo->listPushSubscriptions()), $password);
        assertSame($credentials->fingerprint('push-subscriptions'), $repo->getSetting('push.owner'));
    }
});
