<?php

/*
 * Every /api/ request lands here (see .htaccess). The portal itself lives in
 * the "sms-portal" folder, outside the web root, so its settings and data
 * can never be downloaded: next to this site's folder, or in your home
 * folder.
 */

declare(strict_types=1);

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
        SmsPortal\App::serve($dir);
        return;
    }
}

http_response_code(500);
header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store');
echo json_encode([
    'error' => 'config_error',
    'message' => 'The sms-portal folder was not found. Upload it to your home folder, next to this site\'s folder, not inside it.',
]);
