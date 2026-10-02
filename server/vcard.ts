import { isValidNanp, normalizePhone } from '../shared/phone.js';

export interface ParsedContact {
  name: string;
  phones: string[];
}

/** Undoes RFC 6350 line folding (continuation lines start with a space or tab). */
function unfold(text: string): string[] {
  return text.replace(/\r\n/g, '\n').replace(/\n[ \t]/g, '').split('\n');
}

function unescape(value: string): string {
  return value.replace(/\\n/gi, ' ').replace(/\\([,;\\])/g, '$1').trim();
}

function decodeQuotedPrintable(value: string): string {
  const bytes: number[] = [];
  for (let i = 0; i < value.length; i++) {
    if (value[i] === '=' && /^[0-9A-F]{2}$/i.test(value.slice(i + 1, i + 3))) {
      bytes.push(parseInt(value.slice(i + 1, i + 3), 16));
      i += 2;
    } else {
      bytes.push(value.charCodeAt(i));
    }
  }
  return Buffer.from(bytes).toString('utf8');
}

/**
 * Reads the contacts of a .vcf export (Google Contacts, iCloud, Android...):
 * the display name and the North American phone numbers, nothing else.
 */
export function parseVCards(text: string): ParsedContact[] {
  const contacts: ParsedContact[] = [];
  let current: { fn: string; n: string; org: string; phones: string[] } | null = null;

  for (const line of unfold(text)) {
    const colon = line.indexOf(':');
    if (colon < 0) continue;
    const head = line.slice(0, colon);
    let value = line.slice(colon + 1);
    const [rawName, ...params] = head.split(';');
    const name = rawName!.replace(/^item\d+\./i, '').toUpperCase();
    if (params.some((p) => /ENCODING=QUOTED-PRINTABLE/i.test(p))) value = decodeQuotedPrintable(value);

    if (name === 'BEGIN' && value.trim().toUpperCase() === 'VCARD') {
      current = { fn: '', n: '', org: '', phones: [] };
    } else if (name === 'END' && current) {
      const displayName =
        current.fn ||
        current.n
          .split(';')
          .slice(0, 2)
          .reverse()
          .filter(Boolean)
          .join(' ') ||
        current.org;
      const phones = [...new Set(current.phones)];
      if (displayName && phones.length) contacts.push({ name: displayName, phones });
      current = null;
    } else if (current) {
      if (name === 'FN') current.fn = unescape(value);
      else if (name === 'N') current.n = value.replace(/\\;/g, ' ').trim();
      else if (name === 'ORG') current.org = unescape(value.split(';')[0] ?? '');
      else if (name === 'TEL') {
        const phone = normalizePhone(value.replace(/^tel:/i, ''));
        if (isValidNanp(phone)) current.phones.push(phone);
      }
    }
  }
  return contacts;
}
