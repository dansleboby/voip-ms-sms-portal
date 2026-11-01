<?php

declare(strict_types=1);

namespace SmsPortal;

final class Text
{
    private const LIGATURES = ['œ' => 'oe', 'æ' => 'ae', 'ß' => 'ss'];

    /** Used when the intl extension is missing: the accented letters of Western European languages. */
    private const ACCENTS = [
        'à' => 'a', 'á' => 'a', 'â' => 'a', 'ã' => 'a', 'ä' => 'a', 'å' => 'a', 'ç' => 'c', 'è' => 'e', 'é' => 'e',
        'ê' => 'e', 'ë' => 'e', 'ì' => 'i', 'í' => 'i', 'î' => 'i', 'ï' => 'i', 'ñ' => 'n', 'ò' => 'o', 'ó' => 'o',
        'ô' => 'o', 'õ' => 'o', 'ö' => 'o', 'ù' => 'u', 'ú' => 'u', 'û' => 'u', 'ü' => 'u', 'ý' => 'y', 'ÿ' => 'y',
    ];

    /**
     * Search form of a text, as foldText in shared/text.ts: lowercase, without
     * accents or ligatures, so that "belanger" finds "Bélanger".
     */
    public static function fold(string $text): string
    {
        if (class_exists(\Normalizer::class)) {
            $decomposed = \Normalizer::normalize($text, \Normalizer::FORM_KD);
            $folded = mb_strtolower(preg_replace('/\p{M}/u', '', $decomposed === false ? $text : $decomposed) ?? $text, 'UTF-8');
        } else {
            $folded = strtr(mb_strtolower($text, 'UTF-8'), self::ACCENTS);
        }
        return strtr($folded, self::LIGATURES);
    }

    /**
     * Whether a text shows nothing: only spaces, line breaks, control or
     * invisible characters, as VoIP.ms gives some voice messages (shared/text.ts).
     */
    public static function isBlank(string $text): bool
    {
        return preg_match('/^[\p{Z}\p{Cc}\p{Cf}]*$/u', $text) === 1;
    }

    /**
     * GSM 03.38 letters, keyed by their code: VoIP.ms passes some texts on as
     * GSM codes, so the letters below arrive as control characters ("Premi\x04re"
     * for "Première", from a short code). Escape (0x1B) starts GSM's extension
     * table. Line feed and carriage return are the same in both.
     */
    private const GSM = [
        "\x00" => '@', "\x01" => '£', "\x02" => '$', "\x03" => '¥', "\x04" => 'è', "\x05" => 'é', "\x06" => 'ù', "\x07" => 'ì',
        "\x08" => 'ò', "\x09" => 'Ç', "\x0B" => 'Ø', "\x0C" => 'ø', "\x0E" => 'Å', "\x0F" => 'å', "\x10" => 'Δ', "\x11" => '_',
        "\x12" => 'Φ', "\x13" => 'Γ', "\x14" => 'Λ', "\x15" => 'Ω', "\x16" => 'Π', "\x17" => 'Ψ', "\x18" => 'Σ', "\x19" => 'Θ',
        "\x1A" => 'Ξ', "\x1C" => 'Æ', "\x1D" => 'æ', "\x1E" => 'ß', "\x1F" => 'É', "\x7F" => 'à',
        "\x1B\x0A" => "\n", "\x1B\x14" => '^', "\x1B(" => '{', "\x1B)" => '}', "\x1B/" => '\\', "\x1B<" => '[',
        "\x1B=" => '~', "\x1B>" => ']', "\x1B@" => '|', "\x1Be" => '€', "\x1B" => '',
    ];

    /** Control characters that stand for GSM letters (all but line feed and carriage return). */
    public const GSM_CONTROLS = '/[\x00-\x09\x0B\x0C\x0E-\x1F\x7F]/';

    /**
     * The GSM letters of a text that came as control characters. They never
     * mean anything else in a text message, and are never part of a UTF-8
     * multibyte sequence, so the rest of the text is left alone.
     */
    public static function gsmLetters(string $text): string
    {
        return preg_match(self::GSM_CONTROLS, $text) ? strtr($text, self::GSM) : $text;
    }

    /**
     * Some VoIP.ms bodies come back with quotes escaped, at times more than
     * once ("l\\\'accès"); a backslash right before a quote never means
     * anything in a text message.
     */
    public static function unescapeQuotes(string $text): string
    {
        return preg_replace('/\\\\+([\'"])/', '$1', $text) ?? $text;
    }
}
