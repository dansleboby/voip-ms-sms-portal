<?php

declare(strict_types=1);

namespace SmsPortal\Http;

/** A body, query or path parameter that does not have the expected shape: 400 invalid_request. */
final class InvalidRequest extends HttpError
{
    public function __construct(string $message)
    {
        parent::__construct(400, 'invalid_request', ['message' => $message]);
    }
}
