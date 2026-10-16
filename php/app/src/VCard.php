<?php

declare(strict_types=1);

namespace SmsPortal;

/**
 * Reads the contacts of a .vcf export (Google Contacts, iCloud, Android...):
 * the display name and the North American phone numbers (server/vcard.ts).
 */
final class VCard
{
    /**
     * @return list<array{name: string, phones: list<string>}>
     */
    public static function parse(string $text): array
    {
        $contacts = [];
        $current = null;
        // Undoes RFC 6350 line folding: continuation lines start with a space or a tab.
        $lines = explode("\n", preg_replace("/\n[ \t]/", '', str_replace("\r\n", "\n", $text)) ?? '');
        foreach ($lines as $line) {
            $colon = strpos($line, ':');
            if ($colon === false) {
                continue;
            }
            $params = explode(';', substr($line, 0, $colon));
            $value = substr($line, $colon + 1);
            $name = strtoupper(preg_replace('/^item\d+\./i', '', (string) array_shift($params)) ?? '');
            foreach ($params as $param) {
                if (stripos($param, 'ENCODING=QUOTED-PRINTABLE') !== false) {
                    $value = self::decodeQuotedPrintable($value);
                    break;
                }
            }

            if ($name === 'BEGIN' && strtoupper(trim($value)) === 'VCARD') {
                $current = ['fn' => '', 'n' => '', 'org' => '', 'phones' => []];
            } elseif ($name === 'END' && $current !== null) {
                $n = array_reverse(array_slice(explode(';', $current['n']), 0, 2));
                $displayName = $current['fn'] ?: implode(' ', array_filter($n, static fn ($part) => $part !== '')) ?: $current['org'];
                $phones = array_values(array_unique($current['phones']));
                if ($displayName !== '' && $phones) {
                    $contacts[] = ['name' => $displayName, 'phones' => $phones];
                }
                $current = null;
            } elseif ($current !== null) {
                if ($name === 'FN') {
                    $current['fn'] = self::unescape($value);
                } elseif ($name === 'N') {
                    $current['n'] = trim(str_replace('\\;', ' ', $value));
                } elseif ($name === 'ORG') {
                    $current['org'] = self::unescape(explode(';', $value)[0]);
                } elseif ($name === 'TEL') {
                    $phone = Phone::normalize((string) preg_replace('/^tel:/i', '', $value));
                    if (Phone::isValidNanp($phone)) {
                        $current['phones'][] = $phone;
                    }
                }
            }
        }
        return $contacts;
    }

    private static function unescape(string $value): string
    {
        return trim(preg_replace('/\\\\([,;\\\\])/', '$1', preg_replace('/\\\\n/i', ' ', $value) ?? $value) ?? $value);
    }

    private static function decodeQuotedPrintable(string $value): string
    {
        return preg_replace_callback('/=([0-9A-F]{2})/i', static fn ($m) => chr((int) hexdec($m[1])), $value) ?? $value;
    }
}
