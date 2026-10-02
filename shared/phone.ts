/**
 * Phone number helpers shared by the server and the web client.
 *
 * VoIP.ms identifies North American numbers by their 10 digits (no leading
 * "1", no punctuation), so that is the canonical form stored everywhere.
 * Short codes (e.g. 2FA senders) are kept as-is.
 */

/** Strips punctuation and the NANP country code: "+1 (450) 657-5294" -> "4506575294". */
export function normalizePhone(input: string): string {
  const digits = input.replace(/\D/g, '');
  if (digits.length === 11 && digits.startsWith('1')) return digits.slice(1);
  return digits;
}

/** True for a dialable 10-digit North American number (area code and exchange cannot start with 0 or 1). */
export function isValidNanp(phone: string): boolean {
  return /^[2-9]\d{2}[2-9]\d{6}$/.test(phone);
}

/** "4506575294" -> "(450) 657-5294". Anything that is not 10 digits is returned untouched. */
export function formatPhone(phone: string): string {
  const d = normalizePhone(phone);
  if (d.length !== 10) return phone;
  return `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}`;
}
