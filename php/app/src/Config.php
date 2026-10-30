<?php

declare(strict_types=1);

namespace SmsPortal;

/**
 * Settings, from config.php next to bootstrap.php, overridden by environment
 * variables of the same name (the Docker image's way).
 */
final class Config
{
    private const DEFAULT_VAPID_SUBJECT = 'https://github.com/dansleboby/voip-ms-sms-portal';
    /** Every release publishes its release.json; this address always leads to the newest one. */
    private const DEFAULT_UPDATE_MANIFEST_URL = 'https://github.com/dansleboby/voip-ms-sms-portal/releases/latest/download/release.json';

    /**
     * @param array{username: string, password: string}|null $voipmsEnv
     */
    public function __construct(
        public readonly string $appDir,
        public readonly string $appPassword,
        public readonly ?array $voipmsEnv,
        public readonly int $pollActiveMs,
        public readonly int $pollIdleMs,
        public readonly string $voipmsTimezone,
        public readonly float $sessionDays,
        public readonly bool $demo,
        public readonly string $dataDir,
        public readonly string $vapidSubject,
        public readonly ?string $publicOrigin,
        /** Only for tests: a stand-in for the VoIP.ms API. */
        public readonly string $voipmsApiUrl,
        /** Whether Settings looks for new releases. */
        public readonly bool $updateCheck,
        /** Where the newest release is described (release.json). */
        public readonly string $updateManifestUrl,
        /** @var list<string>|null the only numbers of the account the portal uses (ALLOWED_DIDS); null for all of them */
        public readonly ?array $allowedDids = null,
        /** @var list<string> numbers of the account the portal leaves alone (EXCLUDED_DIDS) */
        public readonly array $excludedDids = [],
        /** "docker" in the Docker image (SMS_PORTAL_INSTALL), "php" otherwise. */
        public readonly string $install = 'php',
        /** @var list<string> settings that were read, but not as written */
        public readonly array $warnings = [],
    ) {
    }

    public static function load(string $appDir): self
    {
        $file = $appDir . '/config.php';
        $values = is_file($file) ? require $file : [];
        if (!is_array($values)) {
            throw new ConfigError('config.php must return an array of settings, like config.sample.php.');
        }
        $warnings = [];
        $get = static function (string $key) use ($values, &$warnings): mixed {
            $env = getenv($key);
            if ($env === false) {
                return $values[$key] ?? null;
            }
            // Docker Compose strips quotes around values in .env files, but --env-file (Docker,
            // Podman) keeps them: KEY="value" arrives with its quotes, which would then end up in
            // the password sent to VoIP.ms.
            $value = trim($env);
            if (strlen($value) >= 2 && preg_match('/^(["\']).*\1$/s', $value)) {
                $warnings[$key] = "$key was wrapped in quotes, which were removed. Remove them from the settings file to silence this warning.";
                return substr($value, 1, -1);
            }
            return $env;
        };

        $docker = $get('SMS_PORTAL_INSTALL') === 'docker';
        $appPassword = (string) ($get('APP_PASSWORD') ?? '');
        if ($appPassword === '') {
            throw new ConfigError(match (true) {
                $docker => 'APP_PASSWORD is not set. Choose a password for the web interface and give it to the container (in .env with Docker Compose).',
                is_file($file) => 'APP_PASSWORD is not set. Choose a password for the web interface and set it in config.php.',
                default => 'config.php is missing. Copy config.sample.php to config.php, in the same folder, and set APP_PASSWORD.',
            });
        }

        $username = trim((string) ($get('VOIPMS_API_USERNAME') ?? ''));
        $password = (string) ($get('VOIPMS_API_PASSWORD') ?? '');
        if (($username === '') !== ($password === '')) {
            throw new ConfigError('Set both VOIPMS_API_USERNAME and VOIPMS_API_PASSWORD, or neither (to use the setup wizard).');
        }

        $timezone = trim((string) ($get('VOIPMS_TIMEZONE') ?? '')) ?: 'America/New_York';
        try {
            new \DateTimeZone($timezone);
        } catch (\Exception) {
            throw new ConfigError("VOIPMS_TIMEZONE \"$timezone\" is not a valid IANA time zone.");
        }

        $vapidSubject = trim((string) ($get('VAPID_SUBJECT') ?? '')) ?: self::DEFAULT_VAPID_SUBJECT;
        if (!preg_match('~^(mailto:\S+@\S+|https://\S+)$~', $vapidSubject)) {
            throw new ConfigError("VAPID_SUBJECT must be a mailto: address or an https:// URL, got \"$vapidSubject\".");
        }

        $publicOrigin = null;
        $publicUrl = trim((string) ($get('PUBLIC_URL') ?? ''));
        if ($publicUrl !== '') {
            $publicOrigin = Origin::of($publicUrl)
                ?? throw new ConfigError("PUBLIC_URL must be the address of the app, like https://sms.example.com, got \"$publicUrl\".");
        }

        $dataDir = (string) ($get('DATA_DIR') ?? '') ?: $appDir . '/data';

        return new self(
            appDir: $appDir,
            appPassword: $appPassword,
            voipmsEnv: $username !== '' ? ['username' => $username, 'password' => $password] : null,
            pollActiveMs: self::seconds($get('POLL_INTERVAL_ACTIVE'), 10, 3, 'POLL_INTERVAL_ACTIVE'),
            pollIdleMs: self::seconds($get('POLL_INTERVAL_IDLE'), 60, 10, 'POLL_INTERVAL_IDLE'),
            voipmsTimezone: $timezone,
            sessionDays: (float) ($get('SESSION_DAYS') ?? 30),
            demo: self::bool($get('DEMO_MODE')),
            dataDir: rtrim($dataDir, '/'),
            vapidSubject: $vapidSubject,
            publicOrigin: $publicOrigin,
            voipmsApiUrl: (string) ($get('VOIPMS_API_URL') ?? '') ?: 'https://voip.ms/api/v1/rest.php',
            updateCheck: $get('UPDATE_CHECK') === null || trim((string) $get('UPDATE_CHECK')) === '' || self::bool($get('UPDATE_CHECK')),
            updateManifestUrl: self::url($get('UPDATE_MANIFEST_URL'), self::DEFAULT_UPDATE_MANIFEST_URL, 'UPDATE_MANIFEST_URL'),
            allowedDids: self::didList($get('ALLOWED_DIDS'), 'ALLOWED_DIDS'),
            excludedDids: self::didList($get('EXCLUDED_DIDS'), 'EXCLUDED_DIDS') ?? [],
            install: $docker ? 'docker' : 'php',
            warnings: array_values($warnings),
        );
    }

    /**
     * A list of numbers, in config.php or as text ("514 555-0100, 450-555-0199").
     *
     * @return list<string>|null their 10 digits, or null when empty
     */
    private static function didList(mixed $value, string $name): ?array
    {
        $entries = is_array($value) ? $value : preg_split('/[,;\n]/', (string) ($value ?? ''));
        $dids = [];
        foreach ($entries as $entry) {
            $entry = trim((string) $entry);
            if ($entry === '') {
                continue;
            }
            $did = Phone::normalize($entry);
            if (!preg_match('/^\d{10}$/', $did)) {
                throw new ConfigError("$name: \"$entry\" is not a 10-digit phone number.");
            }
            $dids[] = $did;
        }
        return $dids ? array_values(array_unique($dids)) : null;
    }

    private static function seconds(mixed $value, int $fallback, int $min, string $name): int
    {
        if ($value === null || trim((string) $value) === '') {
            return $fallback * 1000;
        }
        if (!is_numeric($value) || (float) $value < $min) {
            throw new ConfigError("$name: expected a number of seconds >= $min, got \"$value\".");
        }
        return (int) round((float) $value * 1000);
    }

    private static function url(mixed $value, string $fallback, string $name): string
    {
        $url = trim((string) ($value ?? ''));
        if ($url === '') {
            return $fallback;
        }
        if (!preg_match('~^https?://\S+$~', $url)) {
            throw new ConfigError("$name must be an http(s) address, got \"$url\".");
        }
        return $url;
    }

    private static function bool(mixed $value): bool
    {
        if (is_bool($value)) {
            return $value;
        }
        return in_array(strtolower(trim((string) $value)), ['1', 'true', 'yes', 'on'], true);
    }
}
