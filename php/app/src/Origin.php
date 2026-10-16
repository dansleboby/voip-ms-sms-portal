<?php

declare(strict_types=1);

namespace SmsPortal;

final class Origin
{
    /** "https://Host:443/path" -> "https://host", as URL.origin gives it; null for anything but http(s). */
    public static function of(string $url): ?string
    {
        $parts = parse_url($url);
        $scheme = strtolower($parts['scheme'] ?? '');
        if (!in_array($scheme, ['http', 'https'], true) || empty($parts['host'])) {
            return null;
        }
        $port = $parts['port'] ?? null;
        $default = $scheme === 'https' ? 443 : 80;
        return "$scheme://" . strtolower($parts['host']) . ($port !== null && $port !== $default ? ":$port" : '');
    }
}
