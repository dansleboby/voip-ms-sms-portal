<?php

declare(strict_types=1);

namespace SmsPortal;

/**
 * Web Push with the openssl extension, no library: the
 * payload is encrypted for the browser (RFC 8291, "aes128gcm" from RFC 8188)
 * and the request signed with the server's VAPID key (RFC 8292). Push
 * services only ever see ciphertext.
 *
 * Keys are base64url: the public one as the raw uncompressed point (65
 * bytes), the private one as the scalar (32 bytes), as the Node server of
 * 1.x stored them too.
 */
final class WebPush
{
    private const RECORD_SIZE = 4096;
    /** Push services accept 4096 bytes of body; the header and tag take 103 of them. */
    public const MAX_PAYLOAD_BYTES = 3993;
    /** DER prefixes that wrap a raw P-256 public point and private scalar into keys openssl reads. */
    private const SPKI_PREFIX = '3059301306072a8648ce3d020106082a8648ce3d030107034200';
    private const SEC1_PREFIX = '30770201010420';
    private const SEC1_MIDDLE = 'a00a06082a8648ce3d030107a144034200';

    /** @return array{publicKey: string, privateKey: string} */
    public static function generateVapidKeys(): array
    {
        [$public, $private] = self::generateKeyPair();
        return ['publicKey' => Base64Url::encode($public), 'privateKey' => Base64Url::encode($private)];
    }

    /** True for a well-formed P-256 public key in uncompressed form, on the curve. */
    public static function isValidPublicKey(string $key): bool
    {
        return strlen($key) === 65 && $key[0] === "\x04" && openssl_pkey_get_public(self::publicPem($key)) !== false;
    }

    /** "Authorization" header value: a short-lived ES256 JWT for the push service's origin. */
    public static function vapidAuthorization(string $endpoint, array $keys, string $subject, ?int $nowMs = null): string
    {
        $audience = Origin::of($endpoint) ?? throw new \InvalidArgumentException('Invalid push endpoint');
        $header = Base64Url::encode(json_encode(['typ' => 'JWT', 'alg' => 'ES256']));
        $claims = Base64Url::encode(json_encode(
            ['aud' => $audience, 'exp' => intdiv($nowMs ?? Time::nowMs(), 1000) + 12 * 3600, 'sub' => $subject],
            JSON_UNESCAPED_SLASHES,
        ));
        $unsigned = "$header.$claims";
        $public = Base64Url::decode($keys['publicKey']);
        $private = Base64Url::decode($keys['privateKey']);
        if (!openssl_sign($unsigned, $der, self::privatePem($private, $public), OPENSSL_ALGO_SHA256)) {
            throw new \RuntimeException('Cannot sign the VAPID token');
        }
        return "vapid t=$unsigned." . Base64Url::encode(self::derToRaw($der)) . ", k={$keys['publicKey']}";
    }

    /**
     * Encrypts one push message (RFC 8291 §3). The salt and the sender key
     * are random for every message; they are parameters only to check the
     * result against the RFC's example.
     */
    public static function encrypt(string $plaintext, string $p256dh, string $auth, ?string $salt = null, ?array $senderKeys = null): string
    {
        if (strlen($plaintext) > self::MAX_PAYLOAD_BYTES) {
            throw new \LengthException('Push payload too large');
        }
        $uaPublic = Base64Url::decode($p256dh) ?? throw new \InvalidArgumentException('Invalid p256dh');
        $authSecret = Base64Url::decode($auth) ?? throw new \InvalidArgumentException('Invalid auth');
        [$asPublic, $asPrivate] = $senderKeys ?? self::generateKeyPair();
        $ecdhSecret = openssl_pkey_derive(self::publicPem($uaPublic), self::privatePem($asPrivate, $asPublic), 32);
        if ($ecdhSecret === false) {
            throw new \RuntimeException('ECDH failed');
        }

        $ikm = hash_hkdf('sha256', $ecdhSecret, 32, "WebPush: info\0" . $uaPublic . $asPublic, $authSecret);
        $salt ??= random_bytes(16);
        $cek = hash_hkdf('sha256', $ikm, 16, "Content-Encoding: aes128gcm\0", $salt);
        $nonce = hash_hkdf('sha256', $ikm, 12, "Content-Encoding: nonce\0", $salt);

        $tag = '';
        // A single record: the 0x02 delimiter marks it as the last one.
        $ciphertext = openssl_encrypt($plaintext . "\x02", 'aes-128-gcm', $cek, OPENSSL_RAW_DATA, $nonce, $tag, '', 16);
        if ($ciphertext === false) {
            throw new \RuntimeException('Encryption failed');
        }
        return $salt . pack('N', self::RECORD_SIZE) . chr(strlen($asPublic)) . $asPublic . $ciphertext . $tag;
    }

    /**
     * Delivers one message to a push service.
     *
     * @return int the HTTP status (201 when accepted), 0 when it could not be reached
     */
    public static function send(array $target, string $payload, array $vapid, string $subject, string $urgency = 'normal', ?string $topic = null): int
    {
        $headers = [
            'Authorization: ' . self::vapidAuthorization($target['endpoint'], $vapid, $subject),
            'Content-Encoding: aes128gcm',
            'Content-Type: application/octet-stream',
            'TTL: ' . 24 * 3600,
            "Urgency: $urgency",
        ];
        if ($topic !== null) {
            $headers[] = "Topic: $topic";
        }
        $curl = curl_init($target['endpoint']);
        curl_setopt_array($curl, [
            CURLOPT_POST => true,
            CURLOPT_POSTFIELDS => self::encrypt($payload, $target['p256dh'], $target['auth']),
            CURLOPT_HTTPHEADER => $headers,
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_PROTOCOLS => CURLPROTO_HTTPS | CURLPROTO_HTTP,
            CURLOPT_TIMEOUT => 15,
        ]);
        $ok = curl_exec($curl);
        $status = (int) curl_getinfo($curl, CURLINFO_RESPONSE_CODE);
        curl_close($curl);
        return $ok === false ? 0 : $status;
    }

    /** @return array{0: string, 1: string} raw public point and private scalar */
    private static function generateKeyPair(): array
    {
        $key = openssl_pkey_new(['curve_name' => 'prime256v1', 'private_key_type' => OPENSSL_KEYTYPE_EC]);
        if ($key === false) {
            throw new \RuntimeException('Cannot generate a P-256 key');
        }
        $ec = openssl_pkey_get_details($key)['ec'];
        $pad = static fn (string $n) => str_pad($n, 32, "\0", STR_PAD_LEFT);
        return ["\x04" . $pad($ec['x']) . $pad($ec['y']), $pad($ec['d'])];
    }

    private static function publicPem(string $point): string
    {
        return self::pem('PUBLIC KEY', hex2bin(self::SPKI_PREFIX) . $point);
    }

    private static function privatePem(string $scalar, string $point): string
    {
        return self::pem('EC PRIVATE KEY', hex2bin(self::SEC1_PREFIX) . $scalar . hex2bin(self::SEC1_MIDDLE) . $point);
    }

    private static function pem(string $label, string $der): string
    {
        return "-----BEGIN $label-----\n" . chunk_split(base64_encode($der), 64, "\n") . "-----END $label-----\n";
    }

    /** openssl gives ECDSA signatures in DER; JWTs want r and s side by side, 32 bytes each. */
    private static function derToRaw(string $der): string
    {
        $offset = 2;
        $raw = '';
        for ($i = 0; $i < 2; $i++) {
            $length = ord($der[$offset + 1]);
            $int = substr($der, $offset + 2, $length);
            $raw .= str_pad(ltrim($int, "\0"), 32, "\0", STR_PAD_LEFT);
            $offset += 2 + $length;
        }
        return $raw;
    }
}
