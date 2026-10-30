<?php

// Settings, as environment variables (Docker) or config.php (shared hosting).

declare(strict_types=1);

require __DIR__ . '/../harness.php';

use SmsPortal\Config;
use SmsPortal\ConfigError;

/** Config::load with these environment variables, and nothing else set. */
function loadWith(array $env): Config
{
    foreach (['APP_PASSWORD', 'VOIPMS_API_USERNAME', 'VOIPMS_API_PASSWORD', 'VAPID_SUBJECT', 'SMS_PORTAL_INSTALL', 'DEMO_MODE'] as $key) {
        putenv($key);
    }
    foreach ($env as $key => $value) {
        putenv("$key=$value");
    }
    return Config::load(tempDir());
}

test('refuses to start without APP_PASSWORD', function (): void {
    assertThrows(ConfigError::class, fn () => loadWith([]));
    assertThrows(ConfigError::class, fn () => loadWith(['APP_PASSWORD' => '']));
});

test('removes the quotes that --env-file keeps around values, and says so', function (): void {
    $config = loadWith(['APP_PASSWORD' => '"s3cret"', 'VOIPMS_API_USERNAME' => "'me@example.com'", 'VOIPMS_API_PASSWORD' => 'pass"word"']);
    assertSame('s3cret', $config->appPassword);
    // Quotes inside a value are part of it.
    assertSame(['username' => 'me@example.com', 'password' => 'pass"word"'], $config->voipmsEnv);
    assertSame(2, count($config->warnings));
    assertTrue(str_starts_with($config->warnings[0], 'APP_PASSWORD was wrapped in quotes'));
});

test('checks VAPID_SUBJECT', function (): void {
    assertSame('mailto:me@example.com', loadWith(['APP_PASSWORD' => 'x', 'VAPID_SUBJECT' => 'mailto:me@example.com'])->vapidSubject);
    assertThrows(ConfigError::class, fn () => loadWith(['APP_PASSWORD' => 'x', 'VAPID_SUBJECT' => 'me@example.com']));
});

test('knows it runs in the Docker image', function (): void {
    assertSame('php', loadWith(['APP_PASSWORD' => 'x'])->install);
    assertSame('docker', loadWith(['APP_PASSWORD' => 'x', 'SMS_PORTAL_INSTALL' => 'docker'])->install);
});
