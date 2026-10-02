/**
 * Some VoIP.ms message bodies come back with quotes escaped PHP-style, at
 * times more than once ("l\\\'accès" for "l'accès"). Backslashes directly in
 * front of a quote are never meaningful in a text message, so they are
 * dropped; any other backslash is kept.
 */
export function unescapeQuotes(text: string): string {
  return text.replace(/\\+(['"])/g, '$1');
}
