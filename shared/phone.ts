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

/**
 * Formats a North American number as it is typed: "5145" -> "(514) 5",
 * "15145550100" -> "+1 (514) 555-0100". An international number ("+33 ...")
 * or more than 10 digits comes back as typed. Numbers are stored as digits,
 * so a short code formatted like the start of a number is stored right.
 */
export function formatPhoneInput(input: string): string {
  const digits = input.replace(/\D/g, '');
  const international = input.trimStart().startsWith('+') && !digits.startsWith('1');
  // NANP area codes never start with 1: a leading 1 is the country code.
  const country = digits.startsWith('1') ? '+1 ' : '';
  const local = country ? digits.slice(1) : digits;
  if (international || local.length > 10) return input;
  if (local.length === 0) return country.trim();
  if (local.length <= 3) return country + local;
  const area = `(${local.slice(0, 3)}) `;
  if (local.length <= 6) return country + area + local.slice(3);
  return `${country}${area}${local.slice(3, 6)}-${local.slice(6)}`;
}

/**
 * Digits to look for when searching by (partial) number: drops a leading
 * country code typed as "+1 438…", "1-514…" or a full 11-digit number.
 */
export function searchDigits(query: string): string {
  const digits = query.replace(/\D/g, '');
  if (/^\s*(\+\s*1|1[\s.\-(])/.test(query) || (digits.length === 11 && digits.startsWith('1'))) return digits.slice(1);
  return digits;
}
