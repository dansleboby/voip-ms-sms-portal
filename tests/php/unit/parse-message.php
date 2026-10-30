<?php

// The rows of getSMS and getMMS, read into messages.

declare(strict_types=1);

require __DIR__ . '/../harness.php';

use SmsPortal\VoipMs\RestClient;

test('reads a getMMS row (shape observed on the live API)', function (): void {
    $m = RestClient::parseMessage('mms', [
        'id' => '10456720',
        'date' => '2026-10-02 14:24:31',
        'type' => '0',
        'did' => '4506575294',
        'contact' => '4383980707',
        'carrier_status' => 'Information not available',
        'message' => 'MMS avec image',
        'col_media1' => 'https://voip.ms/media/abc/media.png',
        'col_media2' => '',
        'col_media3' => '',
        'media' => ['https://voip.ms/media/abc/media.png'],
    ]);
    assertSame('mms', $m['kind']);
    assertSame('10456720', $m['id']);
    assertSame('out', $m['direction']);
    // The same picture comes in both "media" and "col_media1": it is kept once.
    assertSame(['https://voip.ms/media/abc/media.png'], $m['media']);
});

test('makes relative media paths absolute and maps type 1 to incoming', function (): void {
    $m = RestClient::parseMessage('mms', ['id' => '1', 'type' => '1', 'media' => ['media/xyz/media.jpg'], 'col_media1' => 'media/xyz/media.jpg']);
    assertSame('in', $m['direction']);
    assertSame(['https://voip.ms/media/xyz/media.jpg'], $m['media']);
});

test('drops PHP-style escaping in front of quotes, however many times it was applied', function (): void {
    $m = RestClient::parseMessage('sms', ['id' => '1', 'type' => '1', 'message' => 'Malheureusement, tant que l\\\\\\\'accès n\\\'est pas restauré, \\"merci\\"']);
    assertSame('Malheureusement, tant que l\'accès n\'est pas restauré, "merci"', $m['body']);
    // Backslashes before anything but a quote are the sender's.
    assertSame('C:\\temp et :-\\', RestClient::parseMessage('sms', ['id' => '2', 'message' => 'C:\\temp et :-\\'])['body']);
});

test('empties a body that shows nothing, as some voice messages come', function (): void {
    $m = RestClient::parseMessage('mms', ['id' => '3', 'type' => '1', 'message' => "\n\n\n \u{200b}\n", 'media' => ['https://voip.ms/media/x/media.amr']]);
    assertSame('', $m['body']);
    assertSame(" ok\n", RestClient::parseMessage('sms', ['id' => '4', 'message' => " ok\n"])['body']);
});
