<?php

declare(strict_types=1);

namespace SmsPortal;

/**
 * Phone numbers, as in shared/phone.ts: North American numbers are stored as
 * their 10 digits (the form VoIP.ms uses), short codes as they are.
 */
final class Phone
{
    /** "+1 (450) 657-5294" -> "4506575294". */
    public static function normalize(string $input): string
    {
        $digits = preg_replace('/\D/', '', $input) ?? '';
        if (strlen($digits) === 11 && $digits[0] === '1') {
            return substr($digits, 1);
        }
        return $digits;
    }

    /** A dialable 10-digit North American number (area code and exchange cannot start with 0 or 1). */
    public static function isValidNanp(string $phone): bool
    {
        return (bool) preg_match('/^[2-9]\d{2}[2-9]\d{6}$/', $phone);
    }

    /** "4506575294" -> "(450) 657-5294"; anything else is returned untouched. */
    public static function format(string $phone): string
    {
        $d = self::normalize($phone);
        if (strlen($d) !== 10) {
            return $phone;
        }
        return '(' . substr($d, 0, 3) . ') ' . substr($d, 3, 3) . '-' . substr($d, 6);
    }

    /** Digits to search for, without a country code typed as "+1 438…", "1-514…" or 11 digits. */
    public static function searchDigits(string $query): string
    {
        $digits = preg_replace('/\D/', '', $query) ?? '';
        if (preg_match('/^\s*(\+\s*1|1[\s.\-(])/', $query) || (strlen($digits) === 11 && $digits[0] === '1')) {
            return substr($digits, 1);
        }
        return $digits;
    }
}
