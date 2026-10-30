<?php

declare(strict_types=1);

namespace SmsPortal;

/**
 * Users' passwords, hashed with PBKDF2-SHA256, which PHP has built in.
 * Stored as "pbkdf2-sha256$<iterations>$<salt>$<hash>", base64url.
 */
final class Passwords
{
    private const SCHEME = 'pbkdf2-sha256';
    /** OWASP's 2023 figure for PBKDF2-SHA256: about half a second on a modest host, at sign-in only. */
    public const ITERATIONS = 600_000;
    private const KEY_BYTES = 32;

    public static function hash(string $password, int $iterations = self::ITERATIONS): string
    {
        $salt = random_bytes(16);
        $hash = hash_pbkdf2('sha256', $password, $salt, $iterations, self::KEY_BYTES, true);
        return self::SCHEME . '$' . $iterations . '$' . Base64Url::encode($salt) . '$' . Base64Url::encode($hash);
    }

    public static function verify(string $password, string $stored): bool
    {
        $parts = explode('$', $stored);
        if (count($parts) !== 4 || $parts[0] !== self::SCHEME || !ctype_digit($parts[1]) || (int) $parts[1] < 1) {
            return false;
        }
        $salt = Base64Url::decode($parts[2]);
        $expected = Base64Url::decode($parts[3]);
        if ($salt === null || $expected === null || $expected === '') {
            return false;
        }
        return hash_equals($expected, hash_pbkdf2('sha256', $password, $salt, (int) $parts[1], strlen($expected), true));
    }
}
