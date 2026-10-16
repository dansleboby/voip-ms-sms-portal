<?php

declare(strict_types=1);

namespace SmsPortal;

/**
 * Single password (APP_PASSWORD) and a signed, stateless session cookie;
 * same format and secret as the Docker version (server/auth.ts), so a
 * sign-in survives moving the database. The signature covers a digest of
 * the password: changing APP_PASSWORD signs everyone out.
 */
final class Auth
{
    public const COOKIE = 'vsp_session';
    private const SECRET_KEY = 'session.secret';

    private string $secret;
    private string $passwordDigest;

    public function __construct(Repo $repo, string $appPassword, private readonly float $sessionDays)
    {
        $secret = $repo->getSetting(self::SECRET_KEY);
        if ($secret === null) {
            $secret = base64_encode(random_bytes(32));
            $repo->setSetting(self::SECRET_KEY, $secret);
        }
        $this->secret = base64_decode($secret);
        $this->passwordDigest = hash('sha256', $appPassword, true);
    }

    public function maxAgeSeconds(): int
    {
        return (int) round($this->sessionDays * 24 * 60 * 60);
    }

    public function checkPassword(string $candidate): bool
    {
        return hash_equals($this->passwordDigest, hash('sha256', $candidate, true));
    }

    private function sign(string $payload): string
    {
        return Base64Url::encode(hash_hmac('sha256', $payload . $this->passwordDigest, $this->secret, true));
    }

    public function issue(?int $now = null): string
    {
        $payload = (string) ($now ?? Time::nowMs());
        return $payload . '.' . $this->sign($payload);
    }

    public function verify(?string $token, ?int $now = null): bool
    {
        $now ??= Time::nowMs();
        if ($token === null || $token === '') {
            return false;
        }
        $dot = strpos($token, '.');
        if ($dot === false || $dot === 0) {
            return false;
        }
        $payload = substr($token, 0, $dot);
        if (!preg_match('/^\d{1,16}$/', $payload)) {
            return false;
        }
        $issuedAt = (int) $payload;
        if ($issuedAt > $now + 60_000 || $now - $issuedAt > $this->maxAgeSeconds() * 1000) {
            return false;
        }
        return hash_equals($this->sign($payload), substr($token, $dot + 1));
    }
}
