import { describe, expect, it } from 'vitest';
import { isInlineSafe } from './media.js';
import { parseVCards } from './vcard.js';

describe('parseVCards', () => {
  it('unfolds long lines and keeps only North American numbers', () => {
    const text = [
      'BEGIN:VCARD',
      'VERSION:4.0',
      'FN:Jean-Fran',
      ' çois Côté',
      'item1.TEL;type=CELL:tel:+1-514-555-0100',
      'TEL;TYPE=HOME:+44 20 7946 0958',
      'END:VCARD',
    ].join('\n');
    expect(parseVCards(text)).toEqual([{ name: 'Jean-François Côté', phones: ['5145550100'] }]);
  });

  it('falls back to N then ORG for the name', () => {
    const text = 'BEGIN:VCARD\nN:Doe;Jane;;;\nTEL:4385550100\nEND:VCARD\nBEGIN:VCARD\nORG:Pizzeria Roma;Livraison\nTEL:4505550100\nEND:VCARD';
    expect(parseVCards(text).map((c) => c.name)).toEqual(['Jane Doe', 'Pizzeria Roma']);
  });
});

describe('isInlineSafe', () => {
  it('only lets pictures, video and audio render inline', () => {
    expect(isInlineSafe('image/jpeg')).toBe(true);
    expect(isInlineSafe('video/mp4')).toBe(true);
    expect(isInlineSafe('image/svg+xml')).toBe(false);
    expect(isInlineSafe('text/html')).toBe(false);
    expect(isInlineSafe(null)).toBe(false);
  });
});
