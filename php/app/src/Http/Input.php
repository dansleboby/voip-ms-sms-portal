<?php

declare(strict_types=1);

namespace SmsPortal\Http;

/**
 * Typed reads from a decoded body or query, refusing anything unexpected
 * with a 400.
 */
final class Input
{
    public function __construct(private readonly array $data)
    {
    }

    public function has(string $key): bool
    {
        return array_key_exists($key, $this->data);
    }

    /** Absent or null. */
    public function isNull(string $key): bool
    {
        return ($this->data[$key] ?? null) === null;
    }

    public function string(string $key, int $min = 0, int $max = PHP_INT_MAX, bool $trim = false): string
    {
        $value = $this->data[$key] ?? null;
        if (!is_string($value)) {
            throw new InvalidRequest("$key: expected a string");
        }
        if ($trim) {
            $value = trim($value);
        }
        $length = mb_strlen($value, 'UTF-8');
        if ($length < $min || $length > $max) {
            throw new InvalidRequest("$key: expected between $min and $max characters");
        }
        return $value;
    }

    public function optionalString(string $key, int $max = PHP_INT_MAX): ?string
    {
        return $this->has($key) ? $this->string($key, 0, $max) : null;
    }

    /** Absent, null or a string. */
    public function nullableString(string $key, int $max = PHP_INT_MAX): ?string
    {
        return ($this->data[$key] ?? null) === null ? null : $this->string($key, 0, $max);
    }

    /** The value as decoded from JSON, for shapes the other readers do not cover. */
    public function raw(string $key): mixed
    {
        return $this->data[$key] ?? null;
    }

    public function bool(string $key): bool
    {
        $value = $this->data[$key] ?? null;
        if (!is_bool($value)) {
            throw new InvalidRequest("$key: expected a boolean");
        }
        return $value;
    }

    public function int(string $key, int $min = PHP_INT_MIN, int $max = PHP_INT_MAX): int
    {
        $value = $this->data[$key] ?? null;
        if (!is_int($value) || $value < $min || $value > $max) {
            throw new InvalidRequest("$key: expected a whole number from $min to $max");
        }
        return $value;
    }

    /** A positive whole number written in a path or query string ("12"). */
    public static function id(string $value): int
    {
        if (!preg_match('/^\d{1,15}$/', $value) || (int) $value <= 0) {
            throw new InvalidRequest('Expected a positive id');
        }
        return (int) $value;
    }

    /** @return list<string> */
    public function stringList(string $key, int $min, int $max): array
    {
        $value = $this->data[$key] ?? null;
        if (!is_array($value) || !array_is_list($value) || count($value) < $min || count($value) > $max) {
            throw new InvalidRequest("$key: expected a list of $min to $max items");
        }
        foreach ($value as $item) {
            if (!is_string($item)) {
                throw new InvalidRequest("$key: expected strings");
            }
        }
        return $value;
    }

    /** @return list<int> positive ids, as JSON numbers */
    public function idList(string $key, int $min, int $max): array
    {
        $value = $this->data[$key] ?? null;
        if (!is_array($value) || !array_is_list($value) || count($value) < $min || count($value) > $max) {
            throw new InvalidRequest("$key: expected a list of $min to $max items");
        }
        foreach ($value as $item) {
            if (!is_int($item) || $item <= 0) {
                throw new InvalidRequest("$key: expected positive whole numbers");
            }
        }
        return $value;
    }

    public function object(string $key): self
    {
        $value = $this->data[$key] ?? null;
        if (!is_array($value) || ($value !== [] && array_is_list($value))) {
            throw new InvalidRequest("$key: expected an object");
        }
        return new self($value);
    }

    /** A query string value, or null when absent; must be one of $allowed when given. */
    public function choice(string $key, array $allowed): ?string
    {
        if (!$this->has($key)) {
            return null;
        }
        $value = $this->data[$key];
        if (!is_string($value) || !in_array($value, $allowed, true)) {
            throw new InvalidRequest("$key: expected one of " . implode(', ', $allowed));
        }
        return $value;
    }

    /** A value that must match $pattern when given (query strings). */
    public function matching(string $key, string $pattern, bool $required = false): ?string
    {
        if (!$this->has($key)) {
            if ($required) {
                throw new InvalidRequest("$key: required");
            }
            return null;
        }
        $value = $this->data[$key];
        if (!is_string($value) || !preg_match($pattern, $value)) {
            throw new InvalidRequest("$key: invalid value");
        }
        return $value;
    }
}
