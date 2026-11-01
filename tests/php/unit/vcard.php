<?php

// Contacts imported from a .vcf export.

declare(strict_types=1);

require __DIR__ . '/../harness.php';

use SmsPortal\VCard;

test('unfolds long lines and keeps only North American numbers', function (): void {
    $text = implode("\n", [
        'BEGIN:VCARD',
        'VERSION:4.0',
        'FN:Jean-Fran',
        ' çois Côté',
        'item1.TEL;type=CELL:tel:+1-514-555-0100',
        'TEL;TYPE=HOME:+44 20 7946 0958',
        'END:VCARD',
    ]);
    assertSame([['name' => 'Jean-François Côté', 'phones' => ['5145550100']]], VCard::parse($text));
});

test('falls back to N then ORG for the name', function (): void {
    $text = "BEGIN:VCARD\nN:Doe;Jane;;;\nTEL:4385550100\nEND:VCARD\nBEGIN:VCARD\nORG:Pizzeria Roma;Livraison\nTEL:4505550100\nEND:VCARD";
    assertSame(['Jane Doe', 'Pizzeria Roma'], array_column(VCard::parse($text), 'name'));
});
