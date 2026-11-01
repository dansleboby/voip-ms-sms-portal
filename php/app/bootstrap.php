<?php

declare(strict_types=1);

/*
 * Entry point shared by the API (www/api.php) and the cron job (cron.php).
 * This folder holds the settings and the data: it must stay outside the web
 * root, so neither can ever be downloaded.
 */

if (PHP_VERSION_ID < 80400) {
    throw new RuntimeException('SMS Portal needs PHP 8.4 or later; this server runs ' . PHP_VERSION . '.');
}

spl_autoload_register(static function (string $class): void {
    $prefix = 'SmsPortal\\';
    if (strncmp($class, $prefix, strlen($prefix)) !== 0) {
        return;
    }
    $file = __DIR__ . '/src/' . str_replace('\\', '/', substr($class, strlen($prefix))) . '.php';
    if (is_file($file)) {
        require $file;
    }
});
