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
     * Some VoIP.ms bodies come back with quotes escaped, at times more than
     * once ("l\\\'accès"); a backslash right before a quote never means
     * anything in a text message (server/voipms/text.ts).
     */
    public static function unescapeQuotes(string $text): string
    {
        return preg_replace('/\\\\+([\'"])/', '$1', $text) ?? $text;
    }
}
