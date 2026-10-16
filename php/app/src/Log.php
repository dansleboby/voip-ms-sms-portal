<?php

declare(strict_types=1);

namespace SmsPortal;

/**
 * Writes to DATA_DIR/portal.log, outside the web root: PHP's own error log
 * often sits next to the script, where it can be downloaded. Nothing
 * personal (numbers, texts) goes in it.
 */
final class Log
{
    private const MAX_BYTES = 1_000_000;

    private static ?string $file = null;

    public static function to(string $file): void
    {
        self::$file = $file;
    }

    public static function info(string $message, array $context = []): void
    {
        self::write('info', $message, $context);
    }

    public static function warn(string $message, array $context = []): void
    {
        self::write('warn', $message, $context);
    }

    public static function error(string $message, array $context = []): void
    {
        self::write('error', $message, $context);
    }

    private static function write(string $level, string $message, array $context): void
    {
        foreach ($context as $key => $value) {
            if ($value instanceof \Throwable) {
                $context[$key] = get_class($value) . ': ' . $value->getMessage() . ' at ' . basename($value->getFile()) . ':' . $value->getLine();
            }
        }
        $line = gmdate('Y-m-d\TH:i:s\Z') . " $level $message" . ($context ? ' ' . json_encode($context, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE) : '') . "\n";
        if (self::$file === null) {
            error_log(rtrim($line));
            return;
        }
        if (@filesize(self::$file) > self::MAX_BYTES) {
            @rename(self::$file, self::$file . '.1');
        }
        @file_put_contents(self::$file, $line, FILE_APPEND | LOCK_EX);
    }
}
