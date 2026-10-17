/**
 * Whether a text shows nothing: only spaces, line breaks, control or
 * invisible characters. VoIP.ms gives some voice messages such a body,
 * which would show as an empty bubble.
 */
export function isBlank(text: string): boolean {
  return /^[\p{Z}\p{Cc}\p{Cf}]*$/u.test(text);
}

const LIGATURES: Record<string, string> = { œ: 'oe', æ: 'ae', ß: 'ss' };

/**
 * Search form of a text: lowercase, without accents or ligatures, so that
 * "belanger" finds "Bélanger" and "coeur" finds "cœur".
 */
export function foldText(text: string): string {
  return text
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[œæß]/g, (c) => LIGATURES[c]!);
}
