<?php

declare(strict_types=1);

namespace SmsPortal;

/**
 * File locks between the PHP processes of the site: requests and the cron
 * job run side by side, and the work the Docker version does in one process
 * (one sync at a time, sends and syncs taking turns) needs them.
 */
final class Lock
{
    /** @param resource $handle */
    private function __construct(private $handle)
    {
    }

    /** The lock, or null when another process holds it. */
    public static function take(string $dir, string $name): ?self
    {
        $handle = fopen("$dir/$name.lock", 'c');
        if ($handle === false) {
            throw new \RuntimeException("Cannot open the $name lock in $dir");
        }
        if (!flock($handle, LOCK_EX | LOCK_NB)) {
            fclose($handle);
            return null;
        }
        return new self($handle);
    }

    /** Waits up to $seconds for the lock; null if it is still held then. */
    public static function wait(string $dir, string $name, float $seconds): ?self
    {
        $deadline = microtime(true) + $seconds;
        do {
            $lock = self::take($dir, $name);
            if ($lock !== null) {
                return $lock;
            }
            usleep(50_000);
        } while (microtime(true) < $deadline);
        return null;
    }

    /** Whether some process (this one included) holds the lock right now. */
    public static function isHeld(string $dir, string $name): bool
    {
        $lock = self::take($dir, $name);
        $lock?->release();
        return $lock === null;
    }

    public function release(): void
    {
        if ($this->handle !== null) {
            flock($this->handle, LOCK_UN);
            fclose($this->handle);
            $this->handle = null;
        }
    }

    public function __destruct()
    {
        $this->release();
    }
}
