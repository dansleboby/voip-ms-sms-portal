import { describe, expect, it } from 'vitest';
import { checkOutgoing, pickMessageKind, utf8Length } from './message.js';
import { formatPhone, isValidNanp, normalizePhone, searchDigits } from './phone.js';

describe('phone', () => {
  it('normalizes to the 10 digits VoIP.ms uses', () => {
    expect(normalizePhone('+1 (450) 657-5294')).toBe('4506575294');
    expect(normalizePhone('1-438-398-0707')).toBe('4383980707');
    expect(normalizePhone('438.398.0707')).toBe('4383980707');
    expect(normalizePhone('32665')).toBe('32665');
  });

  it('validates North American numbers', () => {
    expect(isValidNanp('4506575294')).toBe(true);
    expect(isValidNanp('1506575294')).toBe(false);
    expect(isValidNanp('4501575294')).toBe(false);
    expect(isValidNanp('32665')).toBe(false);
  });

  it('extracts search digits without the country code', () => {
    expect(searchDigits('+1 438-398')).toBe('438398');
    expect(searchDigits('1-514-555-1234')).toBe('5145551234');
    expect(searchDigits('15145551234')).toBe('5145551234');
    expect(searchDigits('1234')).toBe('1234');
    expect(searchDigits('(514) 5')).toBe('5145');
  });

  it('formats 10-digit numbers and leaves the rest alone', () => {
    expect(formatPhone('4506575294')).toBe('(450) 657-5294');
    expect(formatPhone('32665')).toBe('32665');
  });
});

describe('SMS or MMS', () => {
  it('counts UTF-8 bytes like VoIP.ms', () => {
    expect(utf8Length('abc')).toBe(3);
    expect(utf8Length('é')).toBe(2);
    expect(utf8Length('👋')).toBe(4);
  });

  it('sends up to 160 bytes as SMS', () => {
    expect(pickMessageKind('a'.repeat(160), 0)).toBe('sms');
    expect(pickMessageKind('a'.repeat(161), 0)).toBe('mms');
  });

  it('switches to MMS when accents push a 160-character text over 160 bytes', () => {
    // The live API rejected exactly this with sms_toolong.
    const text = 'é'.repeat(10) + 'a'.repeat(150);
    expect([...text].length).toBe(160);
    expect(pickMessageKind(text, 0)).toBe('mms');
    // 5 accents + 150 ASCII = 160 bytes: accepted as SMS by the live API.
    expect(pickMessageKind('é'.repeat(5) + 'a'.repeat(150), 0)).toBe('sms');
  });

  it('uses MMS for attachments', () => {
    expect(pickMessageKind('', 1)).toBe('mms');
  });

  it('reports what blocks a message', () => {
    expect(checkOutgoing('  ', 0).problem).toBe('empty');
    expect(checkOutgoing('', 1).problem).toBeNull();
    expect(checkOutgoing('x', 4).problem).toBe('too_many_attachments');
    expect(checkOutgoing('x'.repeat(2049), 0).problem).toBe('too_long');
    expect(checkOutgoing('x'.repeat(2048), 0)).toEqual({ kind: 'mms', bytes: 2048, problem: null });
  });
});
