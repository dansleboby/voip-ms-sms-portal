<?php

// For tests/webpush-php.test.ts: encrypts and signs with the PHP version's WebPush.
// Usage: php webpush.php <p256dh> <auth> <payload> <endpoint>

declare(strict_types=1);

require __DIR__ . '/../../php/app/bootstrap.php';

[, $p256dh, $auth, $payload, $endpoint] = $argv;
$vapid = SmsPortal\WebPush::generateVapidKeys();
echo json_encode([
    'body' => SmsPortal\Base64Url::encode(SmsPortal\WebPush::encrypt($payload, $p256dh, $auth)),
    'vapid' => $vapid,
    'authorization' => SmsPortal\WebPush::vapidAuthorization($endpoint, $vapid, 'mailto:me@example.com'),
]);
