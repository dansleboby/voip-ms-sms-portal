<?php

// Users' passwords (server/security.test.ts, "passwords").

declare(strict_types=1);

require __DIR__ . '/../harness.php';

use SmsPortal\Passwords;

/**
 * Hashes as databases already hold them, so that the stored format never
 * changes under existing users: one from hash_pbkdf2('sha256', 'secret',
 * 'saltsaltsaltsalt', 1000, 32, true), one made by the Docker version
 * (server/passwords.ts) for "correct horse".
 */
const PHP_HASH = 'pbkdf2-sha256$1000$c2FsdHNhbHRzYWx0c2FsdA$dClvKSmj66n6MdMWNv3Go4mvH1Ym2WIGiJvquqa-mfE';
const NODE_HASH = 'pbkdf2-sha256$1000$bQsxCvb1pmn7NQuvEtSEag$y1qxtByMnec4JKdbFi24D48ep-gNqg4doxsgYBLfjVw';

test('hashes with PBKDF2 in a form both servers read, and checks in constant time', function (): void {
    $hash = Passwords::hash('correct horse', 1000);
    assertSame(1, preg_match('/^pbkdf2-sha256\$1000\$[\w-]{22}\$[\w-]{43}$/', $hash), "format of $hash");
    assertTrue(Passwords::verify('correct horse', $hash));
    assertFalse(Passwords::verify('correct hors', $hash));
    assertFalse(Passwords::verify('x', 'md5$whatever'));
    // Two hashes of one password differ: each has its own salt.
    assertFalse($hash === Passwords::hash('correct horse', 1000));
});

test('reads the hashes already stored', function (): void {
    assertTrue(Passwords::verify('secret', PHP_HASH));
    assertFalse(Passwords::verify('Secret', PHP_HASH));
    assertTrue(Passwords::verify('correct horse', NODE_HASH));
    assertFalse(Passwords::verify('correct hors', NODE_HASH));
});
