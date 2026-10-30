<?php

declare(strict_types=1);

namespace SmsPortal;

/**
 * Who reads, for what the API shows and what it lets through: the owner and
 * the admins see every number; a user of the Team mode sees the numbers an
 * admin gave them, and texts only from those with the right to send. Their
 * key also picks their own unread counts and archive, on the numbers that
 * keep one per person (Repo).
 */
final class Viewer
{
    /** The owner, signed in with APP_PASSWORD: no user account. */
    public const OWNER = 0;

    /**
     * @param int $key the user's id, or OWNER
     * @param ?array<string, bool> $numbers did => may send from it; null for every number
     */
    public function __construct(
        public readonly int $key,
        private readonly ?array $numbers = null,
    ) {
    }

    public function sees(string $did): bool
    {
        return $this->numbers === null || array_key_exists($did, $this->numbers);
    }

    public function canSend(string $did): bool
    {
        return $this->numbers === null || ($this->numbers[$did] ?? false);
    }

    /** @return ?list<string> the numbers this person sees; null for every number */
    public function dids(): ?array
    {
        return $this->numbers === null ? null : array_map('strval', array_keys($this->numbers));
    }
}
