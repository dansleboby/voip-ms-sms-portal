<?php

// Web Push: the payload encrypted for the browser, the request signed for the
// push service.

declare(strict_types=1);

require __DIR__ . '/../harness.php';

use SmsPortal\Base64Url;
use SmsPortal\WebPush;

/** RFC 8291 §5 and Appendix A. */
const RFC = [
    'plaintext' => 'When I grow up, I want to be a watermelon',
    'asPrivate' => 'yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw',
    'asPublic' => 'BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8',
    'uaPrivate' => 'q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94',
    'uaPublic' => 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
    'auth' => 'BTBZMqHH6r4Tts7J_aSIgg',
    'salt' => 'DGv6ra1nlYgDCS1FRnbzlw',
    'result' => 'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27ml'
        . 'mlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPT'
        . 'pK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN',
];

function b64(string $value): string
{
    return Base64Url::decode($value) ?? fail("not base64url: $value");
}

/** A browser's subscription keys: a P-256 pair and the auth secret, raw and as the browser hands them over. */
function browserKeys(): array
{
    $key = openssl_pkey_new(['curve_name' => 'prime256v1', 'private_key_type' => OPENSSL_KEYTYPE_EC]);
    $ec = openssl_pkey_get_details($key)['ec'];
    $pad = static fn (string $n) => str_pad($n, 32, "\0", STR_PAD_LEFT);
    $public = "\x04" . $pad($ec['x']) . $pad($ec['y']);
    $auth = random_bytes(16);
    return ['private' => $pad($ec['d']), 'public' => $public, 'authSecret' => $auth, 'p256dh' => Base64Url::encode($public), 'auth' => Base64Url::encode($auth)];
}

function publicPem(string $point): string
{
    $der = hex2bin('3059301306072a8648ce3d020106082a8648ce3d030107034200') . $point;
    return "-----BEGIN PUBLIC KEY-----\n" . chunk_split(base64_encode($der), 64, "\n") . "-----END PUBLIC KEY-----\n";
}

function privatePem(string $scalar, string $point): string
{
    $der = hex2bin('30770201010420') . $scalar . hex2bin('a00a06082a8648ce3d030107a144034200') . $point;
    return "-----BEGIN EC PRIVATE KEY-----\n" . chunk_split(base64_encode($der), 64, "\n") . "-----END EC PRIVATE KEY-----\n";
}

/** What a browser does on receipt (RFC 8291 §3.4), to check messages end to end. */
function decryptPayload(string $body, string $uaPrivate, string $uaPublic, string $authSecret): string
{
    $salt = substr($body, 0, 16);
    $idlen = ord($body[20]);
    $asPublic = substr($body, 21, $idlen);
    $ciphertext = substr($body, 21 + $idlen);
    $secret = openssl_pkey_derive(publicPem($asPublic), privatePem($uaPrivate, $uaPublic), 32);
    assertTrue(is_string($secret), 'ECDH');
    $ikm = hash_hkdf('sha256', $secret, 32, "WebPush: info\0" . $uaPublic . $asPublic, $authSecret);
    $cek = hash_hkdf('sha256', $ikm, 16, "Content-Encoding: aes128gcm\0", $salt);
    $nonce = hash_hkdf('sha256', $ikm, 12, "Content-Encoding: nonce\0", $salt);
    $padded = openssl_decrypt(substr($ciphertext, 0, -16), 'aes-128-gcm', $cek, OPENSSL_RAW_DATA, $nonce, substr($ciphertext, -16));
    assertTrue(is_string($padded), 'the browser cannot decrypt the message');
    return substr($padded, 0, (int) strrpos($padded, "\x02"));
}

/** A JWT's ES256 signature (r and s side by side) in the DER form openssl_verify reads. */
function signatureDer(string $raw): string
{
    $integer = static function (string $n): string {
        $n = ltrim($n, "\0");
        if ($n === '' || ord($n[0]) & 0x80) {
            $n = "\0" . $n;
        }
        return "\x02" . chr(strlen($n)) . $n;
    };
    $sequence = $integer(substr($raw, 0, 32)) . $integer(substr($raw, 32));
    return "\x30" . chr(strlen($sequence)) . $sequence;
}

test('matches the RFC 8291 example byte for byte', function (): void {
    $body = WebPush::encrypt(RFC['plaintext'], RFC['uaPublic'], RFC['auth'], b64(RFC['salt']), [b64(RFC['asPublic']), b64(RFC['asPrivate'])]);
    assertSame(RFC['result'], Base64Url::encode($body));
});

test('produces messages the browser can decrypt, different every time', function (): void {
    $ua = browserKeys();
    $text = json_encode(['title' => 'Marie Tremblay', 'body' => 'Allô 😊 à tantôt'], JSON_UNESCAPED_UNICODE);
    $a = WebPush::encrypt($text, $ua['p256dh'], $ua['auth']);
    $b = WebPush::encrypt($text, $ua['p256dh'], $ua['auth']);
    assertFalse($a === $b, 'two messages came out the same');
    assertSame($text, decryptPayload($a, $ua['private'], $ua['public'], $ua['authSecret']));
    // The decryption above is the browser's side, checked against the RFC.
    assertSame(RFC['plaintext'], decryptPayload(b64(RFC['result']), b64(RFC['uaPrivate']), b64(RFC['uaPublic']), b64(RFC['auth'])));
});

test('refuses payloads push services would reject', function (): void {
    $ua = browserKeys();
    assertThrows(LengthException::class, fn () => WebPush::encrypt(str_repeat("\0", 4000), $ua['p256dh'], $ua['auth']));
});

test('signs a JWT for the push service origin that verifies with the public key', function (): void {
    $keys = WebPush::generateVapidKeys();
    assertSame(65, strlen(b64($keys['publicKey'])));
    assertSame(32, strlen(b64($keys['privateKey'])));
    $now = (new DateTimeImmutable('2026-10-02T00:00:00Z'))->getTimestamp() * 1000;
    $header = WebPush::vapidAuthorization('https://fcm.googleapis.com/fcm/send/abc:def', $keys, 'mailto:me@example.com', $now);
    assertSame(1, preg_match('/^vapid t=([\w-]+)\.([\w-]+)\.([\w-]+), k=([\w-]+)$/', $header, $match), $header);
    [, $h, $c, $sig, $k] = $match;
    assertSame($keys['publicKey'], $k);
    assertSame(['typ' => 'JWT', 'alg' => 'ES256'], json_decode(b64($h), true));
    assertSame(['aud' => 'https://fcm.googleapis.com', 'exp' => intdiv($now, 1000) + 12 * 3600, 'sub' => 'mailto:me@example.com'], json_decode(b64($c), true));
    $signature = b64($sig);
    assertSame(64, strlen($signature));
    assertSame(1, openssl_verify("$h.$c", signatureDer($signature), publicPem(b64($keys['publicKey'])), OPENSSL_ALGO_SHA256));
});

test('validates browser public keys', function (): void {
    assertTrue(WebPush::isValidPublicKey(b64(RFC['uaPublic'])));
    $offCurve = b64(RFC['uaPublic']);
    $offCurve[64] = chr(ord($offCurve[64]) ^ 1);
    assertFalse(WebPush::isValidPublicKey($offCurve));
    assertFalse(WebPush::isValidPublicKey(str_repeat("\0", 65)));
});

test('posts the encrypted message with the Web Push headers', function (): void {
    // A push service on this machine: php -S, writing down the request it gets.
    $dir = tempDir();
    file_put_contents("$dir/push-service.php", <<<'PHP'
        <?php
        file_put_contents(__DIR__ . '/request.json', json_encode([
            'method' => $_SERVER['REQUEST_METHOD'],
            'path' => $_SERVER['REQUEST_URI'],
            'headers' => getallheaders(),
            'body' => base64_encode(file_get_contents('php://input')),
        ]));
        http_response_code(201);
        PHP);
    $probe = stream_socket_server('tcp://127.0.0.1:0');
    $port = (int) substr((string) strrchr(stream_socket_get_name($probe, false), ':'), 1);
    fclose($probe);
    $server = proc_open([PHP_BINARY, '-S', "127.0.0.1:$port", "$dir/push-service.php"], [['pipe', 'r'], ['file', '/dev/null', 'w'], ['file', '/dev/null', 'w']], $pipes);
    try {
        for ($i = 0; $i < 100 && ($socket = @fsockopen('127.0.0.1', $port, $errno, $error, 0.1)) === false; $i++) {
            usleep(50_000);
        }
        if ($socket === false) {
            fail("the push service did not start: $error");
        }
        fclose($socket);

        $ua = browserKeys();
        $target = ['endpoint' => "http://127.0.0.1:$port/s/1", 'p256dh' => $ua['p256dh'], 'auth' => $ua['auth']];
        $status = WebPush::send($target, '{"title":"Hi"}', WebPush::generateVapidKeys(), 'mailto:me@example.com', 'high', 'c12');
        assertSame(201, $status);
        $seen = json_decode((string) file_get_contents("$dir/request.json"), true);
        assertSame(['POST', '/s/1'], [$seen['method'], $seen['path']]);
        $headers = $seen['headers'];
        assertSame(
            ['Content-Encoding' => 'aes128gcm', 'TTL' => '86400', 'Urgency' => 'high', 'Topic' => 'c12'],
            array_intersect_key($headers, array_flip(['Content-Encoding', 'TTL', 'Urgency', 'Topic'])),
        );
        assertSame(1, preg_match('/^vapid t=/', $headers['Authorization'] ?? ''), 'Authorization');
        assertSame('{"title":"Hi"}', decryptPayload(base64_decode($seen['body']), $ua['private'], $ua['public'], $ua['authSecret']));
    } finally {
        proc_terminate($server);
        proc_close($server);
    }
});
