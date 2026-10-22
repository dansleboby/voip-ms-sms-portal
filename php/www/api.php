<?php

/*
 * Every /api/ request lands here (see .htaccess). The portal itself lives in
 * the "sms-portal" folder, outside the web root, so its settings and data
 * can never be downloaded: next to this site's folder, or in your home
 * folder.
 */

declare(strict_types=1);

/** Answers like the portal does when its setup is incomplete, so that the sign-in page can say what to do. */
function setupProblem(string $message): void
{
    http_response_code(500);
    header('Content-Type: application/json; charset=utf-8');
    header('Cache-Control: no-store');
    echo json_encode(['error' => 'config_error', 'message' => $message]);
}

// Checked here, in code that older PHP still runs: the portal's own code would only fail with a blank error.
if (PHP_VERSION_ID < 80100) {
    setupProblem('SMS Portal needs PHP 8.1 or later, and this site runs PHP ' . PHP_VERSION . '. In cPanel, choose PHP 8.1 or later for this domain under MultiPHP Manager (or Select PHP Version).');
    return;
}

$candidates = [
    getenv('SMS_PORTAL_DIR') ?: null,
    // Site in ~/sms.example.com: the folder is ~/sms-portal.
    dirname(__DIR__) . '/sms-portal',
    // Site in ~/public_html/sms: the folder is still ~/sms-portal.
    dirname(__DIR__, 2) . '/sms-portal',
];
if (function_exists('posix_getpwuid') && function_exists('posix_geteuid')) {
    $candidates[] = (posix_getpwuid(posix_geteuid())['dir'] ?? '') . '/sms-portal';
}

foreach ($candidates as $dir) {
    if ($dir !== null && @is_file("$dir/bootstrap.php")) {
        require "$dir/bootstrap.php";
        SmsPortal\App::serve($dir, __DIR__);
        return;
    }
}

setupProblem('The sms-portal folder was not found. Upload it to your home folder, next to this site\'s folder, not inside it.');
