<?php

declare(strict_types=1);

namespace SmsPortal;

/** A setting is missing or wrong; the message tells the person installing the portal what to fix. */
final class ConfigError extends \RuntimeException
{
}
