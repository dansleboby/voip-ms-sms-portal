<?php

declare(strict_types=1);

namespace SmsPortal\VoipMs;

/** A VoIP.ms status ("invalid_credentials", "ip_not_enabled"...) or a transport failure. */
final class VoipMsError extends \RuntimeException
{
    public function __construct(public readonly string $errorCode, ?string $message = null)
    {
        parent::__construct($message ?? $errorCode);
    }
}
