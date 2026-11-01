<?php

declare(strict_types=1);

namespace SmsPortal;

/**
 * scrypt (RFC 7914), for what the Node server of 1.x stored: it derived
 * the key of the VoIP.ms credentials with Node's crypto.scrypt, which PHP
 * lacks (libsodium's takes only 32-byte salts, and these are 16). Slow by
 * design, and slower in PHP: a few seconds, once, when a Docker install
 * from before 2.0 first starts on this server (Credentials, Push).
 */
final class Scrypt
{
    /** Node's defaults for crypto.scryptSync(password, salt, 32). */
    public static function derive(string $password, string $salt, int $n = 16384, int $r = 8, int $p = 1, int $length = 32): string
    {
        if ($n < 2 || ($n & ($n - 1)) !== 0) {
            throw new \InvalidArgumentException('scrypt: N must be a power of 2');
        }
        $blockSize = 128 * $r;
        $b = hash_pbkdf2('sha256', $password, $salt, 1, $p * $blockSize, true);
        $mixed = '';
        for ($i = 0; $i < $p; $i++) {
            $mixed .= self::roMix(substr($b, $i * $blockSize, $blockSize), $n, $r);
        }
        return hash_pbkdf2('sha256', $password, $mixed, 1, $length, true);
    }

    private static function roMix(string $x, int $n, int $r): string
    {
        $v = [];
        for ($i = 0; $i < $n; $i++) {
            $v[$i] = $x;
            $x = self::blockMix($x, $r);
        }
        // Integerify: the first little-endian word of the last 64-byte block, modulo N (a power of 2).
        $last = 64 * (2 * $r - 1);
        for ($i = 0; $i < $n; $i++) {
            $j = unpack('V', $x, $last)[1] & ($n - 1);
            $x = self::blockMix($x ^ $v[$j], $r);
        }
        return $x;
    }

    private static function blockMix(string $b, int $r): string
    {
        $x = substr($b, -64);
        $even = '';
        $odd = '';
        for ($i = 0; $i < 2 * $r; $i++) {
            $x = self::salsa208($x ^ substr($b, 64 * $i, 64));
            if ($i % 2 === 0) {
                $even .= $x;
            } else {
                $odd .= $x;
            }
        }
        return $even . $odd;
    }

    /** The Salsa20/8 core on one 64-byte block. */
    private static function salsa208(string $block): string
    {
        [, $j0, $j1, $j2, $j3, $j4, $j5, $j6, $j7, $j8, $j9, $j10, $j11, $j12, $j13, $j14, $j15] = unpack('V16', $block);
        [$x0, $x1, $x2, $x3, $x4, $x5, $x6, $x7, $x8, $x9, $x10, $x11, $x12, $x13, $x14, $x15] = [$j0, $j1, $j2, $j3, $j4, $j5, $j6, $j7, $j8, $j9, $j10, $j11, $j12, $j13, $j14, $j15];
        for ($round = 0; $round < 8; $round += 2) {
            $t = ($x0 + $x12) & 0xffffffff;
            $x4 ^= (($t << 7) & 0xffffffff) | ($t >> 25);
            $t = ($x4 + $x0) & 0xffffffff;
            $x8 ^= (($t << 9) & 0xffffffff) | ($t >> 23);
            $t = ($x8 + $x4) & 0xffffffff;
            $x12 ^= (($t << 13) & 0xffffffff) | ($t >> 19);
            $t = ($x12 + $x8) & 0xffffffff;
            $x0 ^= (($t << 18) & 0xffffffff) | ($t >> 14);
            $t = ($x5 + $x1) & 0xffffffff;
            $x9 ^= (($t << 7) & 0xffffffff) | ($t >> 25);
            $t = ($x9 + $x5) & 0xffffffff;
            $x13 ^= (($t << 9) & 0xffffffff) | ($t >> 23);
            $t = ($x13 + $x9) & 0xffffffff;
            $x1 ^= (($t << 13) & 0xffffffff) | ($t >> 19);
            $t = ($x1 + $x13) & 0xffffffff;
            $x5 ^= (($t << 18) & 0xffffffff) | ($t >> 14);
            $t = ($x10 + $x6) & 0xffffffff;
            $x14 ^= (($t << 7) & 0xffffffff) | ($t >> 25);
            $t = ($x14 + $x10) & 0xffffffff;
            $x2 ^= (($t << 9) & 0xffffffff) | ($t >> 23);
            $t = ($x2 + $x14) & 0xffffffff;
            $x6 ^= (($t << 13) & 0xffffffff) | ($t >> 19);
            $t = ($x6 + $x2) & 0xffffffff;
            $x10 ^= (($t << 18) & 0xffffffff) | ($t >> 14);
            $t = ($x15 + $x11) & 0xffffffff;
            $x3 ^= (($t << 7) & 0xffffffff) | ($t >> 25);
            $t = ($x3 + $x15) & 0xffffffff;
            $x7 ^= (($t << 9) & 0xffffffff) | ($t >> 23);
            $t = ($x7 + $x3) & 0xffffffff;
            $x11 ^= (($t << 13) & 0xffffffff) | ($t >> 19);
            $t = ($x11 + $x7) & 0xffffffff;
            $x15 ^= (($t << 18) & 0xffffffff) | ($t >> 14);
            $t = ($x0 + $x3) & 0xffffffff;
            $x1 ^= (($t << 7) & 0xffffffff) | ($t >> 25);
            $t = ($x1 + $x0) & 0xffffffff;
            $x2 ^= (($t << 9) & 0xffffffff) | ($t >> 23);
            $t = ($x2 + $x1) & 0xffffffff;
            $x3 ^= (($t << 13) & 0xffffffff) | ($t >> 19);
            $t = ($x3 + $x2) & 0xffffffff;
            $x0 ^= (($t << 18) & 0xffffffff) | ($t >> 14);
            $t = ($x5 + $x4) & 0xffffffff;
            $x6 ^= (($t << 7) & 0xffffffff) | ($t >> 25);
            $t = ($x6 + $x5) & 0xffffffff;
            $x7 ^= (($t << 9) & 0xffffffff) | ($t >> 23);
            $t = ($x7 + $x6) & 0xffffffff;
            $x4 ^= (($t << 13) & 0xffffffff) | ($t >> 19);
            $t = ($x4 + $x7) & 0xffffffff;
            $x5 ^= (($t << 18) & 0xffffffff) | ($t >> 14);
            $t = ($x10 + $x9) & 0xffffffff;
            $x11 ^= (($t << 7) & 0xffffffff) | ($t >> 25);
            $t = ($x11 + $x10) & 0xffffffff;
            $x8 ^= (($t << 9) & 0xffffffff) | ($t >> 23);
            $t = ($x8 + $x11) & 0xffffffff;
            $x9 ^= (($t << 13) & 0xffffffff) | ($t >> 19);
            $t = ($x9 + $x8) & 0xffffffff;
            $x10 ^= (($t << 18) & 0xffffffff) | ($t >> 14);
            $t = ($x15 + $x14) & 0xffffffff;
            $x12 ^= (($t << 7) & 0xffffffff) | ($t >> 25);
            $t = ($x12 + $x15) & 0xffffffff;
            $x13 ^= (($t << 9) & 0xffffffff) | ($t >> 23);
            $t = ($x13 + $x12) & 0xffffffff;
            $x14 ^= (($t << 13) & 0xffffffff) | ($t >> 19);
            $t = ($x14 + $x13) & 0xffffffff;
            $x15 ^= (($t << 18) & 0xffffffff) | ($t >> 14);
        }
        return pack(
            'V16',
            ($x0 + $j0) & 0xffffffff,
            ($x1 + $j1) & 0xffffffff,
            ($x2 + $j2) & 0xffffffff,
            ($x3 + $j3) & 0xffffffff,
            ($x4 + $j4) & 0xffffffff,
            ($x5 + $j5) & 0xffffffff,
            ($x6 + $j6) & 0xffffffff,
            ($x7 + $j7) & 0xffffffff,
            ($x8 + $j8) & 0xffffffff,
            ($x9 + $j9) & 0xffffffff,
            ($x10 + $j10) & 0xffffffff,
            ($x11 + $j11) & 0xffffffff,
            ($x12 + $j12) & 0xffffffff,
            ($x13 + $j13) & 0xffffffff,
            ($x14 + $j14) & 0xffffffff,
            ($x15 + $j15) & 0xffffffff,
        );
    }
}
