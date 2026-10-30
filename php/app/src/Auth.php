<?php

declare(strict_types=1);

namespace SmsPortal;

/**
 * Who is signed in. The owner signs in with APP_PASSWORD, the only way in
 * the simple mode; in the Team mode, users sign in with their email and
 * their own password (Passwords).
 *
 * Each sign-in is a row of the sessions table. The cookie holds the
 * session's id, signed with a secret and a digest of APP_PASSWORD: changing
 * APP_PASSWORD signs everyone out, and the table alone (which keeps only a
 * hash of each id) signs nobody in.
 */
final class Auth
{
    public const COOKIE = 'vsp_session';
    private const SECRET_KEY = 'session.secret';
    /** '1' once the owner turned the Team mode on (it does not turn off). */
    public const TEAM_KEY = 'team.enabled';
    /** A session's last activity is written at most this often. */
    private const TOUCH_MS = 60_000;

    private string $secret;
    private string $passwordDigest;

    public function __construct(private readonly Repo $repo, string $appPassword, private readonly float $sessionDays)
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

    public function mode(): string
    {
        return $this->repo->getSetting(self::TEAM_KEY) === '1' ? 'team' : 'simple';
    }

    /** APP_PASSWORD: the owner's. */
    public function checkPassword(string $candidate): bool
    {
        return hash_equals($this->passwordDigest, hash('sha256', $candidate, true));
    }

    /** The id stored for a session id carried by a cookie. */
    public static function storedSessionId(string $cookieId): string
    {
        return Base64Url::encode(hash('sha256', $cookieId, true));
    }

    private function sign(string $id): string
    {
        return Base64Url::encode(hash_hmac('sha256', $id . $this->passwordDigest, $this->secret, true));
    }

    /** Signs someone in (null: the owner); returns the cookie's value. */
    public function open(?int $userId, ?string $userAgent, ?int $now = null): string
    {
        $now ??= Time::nowMs();
        $this->repo->pruneSessions($now - $this->maxAgeSeconds() * 1000);
        $id = Base64Url::encode(random_bytes(24));
        $this->repo->createSession(self::storedSessionId($id), $userId, $userAgent === null ? null : mb_substr($userAgent, 0, 300), $now);
        return $id . '.' . $this->sign($id);
    }

    /**
     * Who a cookie signs in, if anyone.
     *
     * @return ?array{sessionId: string, userId: ?int, email: ?string, name: ?string, role: string}
     */
    public function verify(?string $token, ?int $now = null): ?array
    {
        $now ??= Time::nowMs();
        if ($token === null || $token === '') {
            return null;
        }
        $dot = strpos($token, '.');
        if ($dot === false || $dot === 0) {
            return null;
        }
        $id = substr($token, 0, $dot);
        if (!hash_equals($this->sign($id), substr($token, $dot + 1))) {
            return null;
        }
        $sessionId = self::storedSessionId($id);
        $session = $this->repo->getSession($sessionId);
        if ($session === null) {
            return null;
        }
        if ($now - $session['created_at'] > $this->maxAgeSeconds() * 1000) {
            $this->repo->deleteSession($sessionId);
            return null;
        }
        $user = ['sessionId' => $sessionId, 'userId' => null, 'email' => null, 'name' => null, 'role' => 'owner'];
        if ($session['user_id'] !== null) {
            $row = $this->repo->getUserRow((int) $session['user_id']);
            // Users only exist in the Team mode, and a disabled one is out.
            if ($row === null || $row['disabled_at'] !== null || $this->mode() !== 'team') {
                return null;
            }
            $user = ['sessionId' => $sessionId, 'userId' => $row['id'], 'email' => $row['email'], 'name' => $row['name'], 'role' => $row['role']];
        }
        if ($now - $session['last_seen_at'] > self::TOUCH_MS) {
            $this->repo->touchSession($sessionId, $now);
        }
        return $user;
    }

    public function close(string $sessionId): void
    {
        $this->repo->deleteSession($sessionId);
    }

    /** What the person signed in as $user (verify) sees and may do; null for nobody. */
    public function viewer(?array $user): ?Viewer
    {
        if ($user === null) {
            return null;
        }
        if ($user['userId'] === null) {
            return new Viewer(Viewer::OWNER);
        }
        return new Viewer($user['userId'], $user['role'] === 'user' ? $this->repo->userNumbers($user['userId']) : null);
    }

    /**
     * The same for a Viewer key, out of any request (push notifications): null
     * for a user deleted, disabled, or out since the Team mode is off.
     */
    public function viewerForKey(int $key): ?Viewer
    {
        if ($key === Viewer::OWNER) {
            return new Viewer(Viewer::OWNER);
        }
        $row = $this->repo->getUserRow($key);
        if ($row === null || $row['disabled_at'] !== null || $this->mode() !== 'team') {
            return null;
        }
        return $this->viewer(['userId' => $row['id'], 'role' => $row['role']]);
    }
}
