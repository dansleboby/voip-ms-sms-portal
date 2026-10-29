<?php

declare(strict_types=1);

namespace SmsPortal;

/**
 * VoIP.ms credentials entered in the setup wizard are stored encrypted
 * (AES-256-GCM) with a key derived from APP_PASSWORD, so a copy of the
 * database alone does not reveal the API password (server/secrets.ts).
 *
 * The Docker version derives that key with scrypt, which PHP lacks: this
 * one uses PBKDF2. Credentials stored by the other version therefore read
 * as missing, and the wizard asks for them again.
 *
 * Each VoIP.ms account has its own; VOIPMS_API_USERNAME/PASSWORD only stand
 * for the first one.
 */
final class Credentials
{
    private const KEY = 'voipms.credentials';
    private const SALT_KEY = 'crypto.salt';
    private const KDF = 'pbkdf2-sha256';
    /** Slow enough to make guessing APP_PASSWORD from a stolen database costly, quick enough for each sync. */
    private const ITERATIONS = 100_000;

    private ?string $key = null;

    /**
     * @param array{username: string, password: string}|null $fromEnv
     */
    public function __construct(private readonly Repo $repo, private readonly string $appPassword, private readonly ?array $fromEnv)
    {
    }

    private function derivedKey(): string
    {
        if ($this->key === null) {
            $salt = $this->repo->getSetting(self::SALT_KEY);
            if ($salt === null) {
                $salt = base64_encode(random_bytes(16));
                $this->repo->setSetting(self::SALT_KEY, $salt);
            }
            $this->key = hash_pbkdf2('sha256', $this->appPassword, base64_decode($salt), self::ITERATIONS, 32, true);
        }
        return $this->key;
    }

    /**
     * "env", "db" or null. Unless $verify, stored credentials count without
     * being decrypted, which costs a key derivation.
     */
    public function source(bool $verify = true, int $accountId = Repo::PRIMARY_ACCOUNT): ?string
    {
        if ($accountId === Repo::PRIMARY_ACCOUNT && $this->fromEnv !== null) {
            return 'env';
        }
        return ($verify ? $this->readStored($accountId) !== null : $this->present($accountId)) ? 'db' : null;
    }

    /** @return array{username: string, password: string}|null */
    public function get(int $accountId = Repo::PRIMARY_ACCOUNT): ?array
    {
        return ($accountId === Repo::PRIMARY_ACCOUNT ? $this->fromEnv : null) ?? $this->readStored($accountId);
    }

    /** Whether there are credentials, without paying for the key derivation when they come from the settings. */
    public function present(int $accountId = Repo::PRIMARY_ACCOUNT): bool
    {
        return ($accountId === Repo::PRIMARY_ACCOUNT && $this->fromEnv !== null)
            || $this->repo->getSetting(Repo::accountKey($accountId, self::KEY)) !== null;
    }

    public function save(array $credentials, int $accountId = Repo::PRIMARY_ACCOUNT): void
    {
        if ($accountId === Repo::PRIMARY_ACCOUNT && $this->fromEnv !== null) {
            throw new \LogicException('Credentials are provided by the settings file');
        }
        $iv = random_bytes(12);
        $tag = '';
        $data = openssl_encrypt(json_encode($credentials), 'aes-256-gcm', $this->derivedKey(), OPENSSL_RAW_DATA, $iv, $tag);
        $this->repo->setSetting(Repo::accountKey($accountId, self::KEY), json_encode([
            'kdf' => self::KDF,
            'iv' => base64_encode($iv),
            'tag' => base64_encode($tag),
            'data' => base64_encode((string) $data),
        ]));
    }

    public function clear(int $accountId = Repo::PRIMARY_ACCOUNT): void
    {
        $this->repo->deleteSetting(Repo::accountKey($accountId, self::KEY));
    }

    /** Changes with APP_PASSWORD; safe to store, as it goes through the same slow derivation. */
    public function fingerprint(string $label): string
    {
        return Base64Url::encode(hash_hmac('sha256', $label, $this->derivedKey(), true));
    }

    private function readStored(int $accountId): ?array
    {
        $raw = $this->repo->getSetting(Repo::accountKey($accountId, self::KEY));
        if ($raw === null) {
            return null;
        }
        $payload = json_decode($raw, true);
        if (!is_array($payload) || ($payload['kdf'] ?? null) !== self::KDF) {
            return null;
        }
        $json = openssl_decrypt(
            base64_decode((string) ($payload['data'] ?? '')),
            'aes-256-gcm',
            $this->derivedKey(),
            OPENSSL_RAW_DATA,
            base64_decode((string) ($payload['iv'] ?? '')),
            base64_decode((string) ($payload['tag'] ?? '')),
        );
        // Wrong key (APP_PASSWORD changed) or corrupted value.
        $parsed = $json === false ? null : json_decode($json, true);
        if (!is_array($parsed) || empty($parsed['username']) || empty($parsed['password'])) {
            return null;
        }
        return ['username' => (string) $parsed['username'], 'password' => (string) $parsed['password']];
    }
}
