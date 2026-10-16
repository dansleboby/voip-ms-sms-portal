<?php

declare(strict_types=1);

namespace SmsPortal;

/**
 * Settings, from config.php next to bootstrap.php, overridden by environment
 * variables of the same name. The names are those of the Docker version.
 */
final class Config
{
    private const DEFAULT_VAPID_SUBJECT = 'https://github.com/dansleboby/voip-ms-sms-portal';

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
    ) {
    }

    public static function load(string $appDir): self
    {
        $file = $appDir . '/config.php';
        $values = is_file($file) ? require $file : [];
        if (!is_array($values)) {
            throw new ConfigError('config.php must return an array of settings, like config.sample.php.');
        }
        $get = static function (string $key) use ($values): mixed {
            $env = getenv($key);
            return $env !== false ? $env : ($values[$key] ?? null);
        };

        $appPassword = (string) ($get('APP_PASSWORD') ?? '');
        if ($appPassword === '') {
            throw new ConfigError(
                is_file($file)
                    ? 'APP_PASSWORD is not set. Choose a password for the web interface and set it in config.php.'
                    : 'config.php is missing. Copy config.sample.php to config.php, in the same folder, and set APP_PASSWORD.',
            );
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
        );
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

    private static function bool(mixed $value): bool
    {
        if (is_bool($value)) {
            return $value;
        }
        return in_array(strtolower(trim((string) $value)), ['1', 'true', 'yes', 'on'], true);
    }
}
