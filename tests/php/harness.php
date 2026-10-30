<?php

/*
 * A small test runner for the PHP server's own classes, with no Composer
 * package. Each file of tests/php/unit declares cases with test(); run by
 * tests/php-unit.test.ts, it prints one JSON line per case.
 */

declare(strict_types=1);

require __DIR__ . '/../../php/app/bootstrap.php';

final class AssertionFailed extends \RuntimeException
{
}

/** @var list<array{string, callable}> */
$GLOBALS['__tests'] = [];

function test(string $name, callable $case): void
{
    $GLOBALS['__tests'][] = [$name, $case];
}

function fail(string $message): never
{
    throw new AssertionFailed($message);
}

function assertSame(mixed $expected, mixed $actual, string $message = ''): void
{
    if ($expected !== $actual) {
        fail(($message !== '' ? "$message: " : '') . 'expected ' . export($expected) . ', got ' . export($actual));
    }
}

function assertTrue(mixed $actual, string $message = ''): void
{
    assertSame(true, $actual, $message);
}

function assertFalse(mixed $actual, string $message = ''): void
{
    assertSame(false, $actual, $message);
}

/** Runs $code and returns what it threw, failing when it throws nothing or something else. */
function assertThrows(string $class, callable $code, string $message = ''): \Throwable
{
    try {
        $code();
    } catch (\Throwable $e) {
        if (!$e instanceof $class) {
            fail(($message !== '' ? "$message: " : '') . "expected $class, got " . get_class($e) . ': ' . $e->getMessage());
        }
        return $e;
    }
    fail(($message !== '' ? "$message: " : '') . "expected $class, nothing was thrown");
}

function export(mixed $value): string
{
    return json_encode($value, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_PRESERVE_ZERO_FRACTION | JSON_PARTIAL_OUTPUT_ON_ERROR) ?: var_export($value, true);
}

/** A fresh database, migrated, in a folder of its own that is removed at exit. */
function freshRepo(): SmsPortal\Repo
{
    return new SmsPortal\Repo(SmsPortal\Db::open(tempDir() . '/portal.db'));
}

function tempDir(): string
{
    $dir = sys_get_temp_dir() . '/sms-portal-test-' . bin2hex(random_bytes(6));
    mkdir($dir, 0700, true);
    register_shutdown_function(static function () use ($dir): void {
        $files = new RecursiveIteratorIterator(new RecursiveDirectoryIterator($dir, FilesystemIterator::SKIP_DOTS), RecursiveIteratorIterator::CHILD_FIRST);
        foreach ($files as $file) {
            $file->isDir() ? rmdir($file->getPathname()) : unlink($file->getPathname());
        }
        rmdir($dir);
    });
    return $dir;
}

register_shutdown_function(static function (): void {
    foreach ($GLOBALS['__tests'] as [$name, $case]) {
        SmsPortal\Time::travelTo(null);
        try {
            $case();
            $result = ['name' => $name, 'ok' => true];
        } catch (\Throwable $e) {
            $where = ['file' => $e->getFile(), 'line' => $e->getLine()];
            if ($e instanceof AssertionFailed) {
                // The test's line, not the helper's.
                foreach ($e->getTrace() as $frame) {
                    if (isset($frame['file']) && $frame['file'] !== __FILE__) {
                        $where = $frame;
                        break;
                    }
                }
            }
            $result = [
                'name' => $name,
                'ok' => false,
                'error' => ($e instanceof AssertionFailed ? '' : get_class($e) . ': ') . $e->getMessage()
                    . (isset($where['file']) ? ' (' . basename($where['file']) . ':' . ($where['line'] ?? '?') . ')' : ''),
            ];
        }
        echo json_encode($result, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_INVALID_UTF8_SUBSTITUTE), "\n";
    }
});
