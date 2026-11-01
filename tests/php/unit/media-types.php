<?php

// Which attachments the portal lets a browser show inline.

declare(strict_types=1);

require __DIR__ . '/../harness.php';

use SmsPortal\Media;

test('only lets pictures, video and audio render inline', function (): void {
    assertTrue(Media::isInlineSafe('image/jpeg'));
    assertTrue(Media::isInlineSafe('video/mp4'));
    // An SVG or an HTML page can carry scripts that would run on the portal's origin.
    assertFalse(Media::isInlineSafe('image/svg+xml'));
    assertFalse(Media::isInlineSafe('text/html'));
    assertFalse(Media::isInlineSafe(null));
});
