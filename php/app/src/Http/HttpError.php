<?php

declare(strict_types=1);

namespace SmsPortal\Http;

/** Ends the request with this status and {"error": code, ...extra}. */
class HttpError extends \RuntimeException
{
    public function __construct(public readonly int $status, public readonly string $errorCode, public readonly array $extra = [])
    {
        parent::__construct($errorCode);
    }
}
