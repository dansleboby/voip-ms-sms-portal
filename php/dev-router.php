<?php

/*
 * Router for PHP's built-in server, doing what www/.htaccess does on a real
 * host. From the project folder, after npm run build:
 *
 *   SMS_PORTAL_DIR=php/app APP_PASSWORD=dev DEMO_MODE=true \
 *     php -S 127.0.0.1:8090 -t dist/web php/dev-router.php
 */

declare(strict_types=1);

$path = (string) parse_url($_SERVER['REQUEST_URI'] ?? '/', PHP_URL_PATH);

if (str_starts_with($path, '/api/')) {
    require __DIR__ . '/www/api.php';
    return true;
}

$root = (string) $_SERVER['DOCUMENT_ROOT'];
if ($path !== '/' && is_file($root . $path)) {
    // Static file: the built-in server sends it.
    return false;
}
if (is_file("$root/index.html")) {
    header('Content-Type: text/html; charset=utf-8');
    header('Cache-Control: no-cache');
    readfile("$root/index.html");
    return true;
}
http_response_code(404);
echo "Build the web client first: npm run build\n";
return true;
