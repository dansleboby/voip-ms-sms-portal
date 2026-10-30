<?php

// For tests/voipms-client-php.test.ts: one call of the PHP version's VoIP.ms client.
// Usage: php voipms-client.php <API URL> <method> <arguments, as a JSON list>
// Prints {"result": ...}, or {"error": "<VoIP.ms status>"} for a VoipMsError.

declare(strict_types=1);

require __DIR__ . '/../../php/app/bootstrap.php';

use SmsPortal\VoipMs\RestClient;
use SmsPortal\VoipMs\VoipMsError;

[, $url, $method, $arguments] = $argv;
$client = new RestClient('me@example.com', 'api-secret', $url);
try {
    echo json_encode(['result' => $client->$method(...json_decode($arguments, true))], JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
} catch (VoipMsError $e) {
    echo json_encode(['error' => $e->errorCode]);
}
