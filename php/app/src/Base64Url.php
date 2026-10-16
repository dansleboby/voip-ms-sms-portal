<?php

declare(strict_types=1);

namespace SmsPortal;

final class Base64Url
{
    public static function encode(string $bytes): string
    {
        return rtrim(strtr(base64_encode($bytes), '+/', '-_'), '=');
    }

    /** Null when $text is not base64url. */
    public static function decode(string $text): ?string
    {
        if (!preg_match('/^[\w-]*={0,2}$/', $text)) {
            return null;
        }
        $bytes = base64_decode(strtr(rtrim($text, '='), '-_', '+/'), true);
        return $bytes === false ? null : $bytes;
    }
}
