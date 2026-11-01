<?php

/*
 * Run every minute from cPanel > Cron Jobs (Settings shows the exact line):
 *   /usr/local/bin/php /home/you/sms-portal/cron.php
 * It checks VoIP.ms for new texts while nobody has the app open, which is
 * also what sends push notifications then.
 */

declare(strict_types=1);

require __DIR__ . '/bootstrap.php';

// "--check": only check the settings (the Docker image does, before it starts).
exit(($argv[1] ?? '') === '--check' ? SmsPortal\Cron::check(__DIR__) : SmsPortal\Cron::run(__DIR__));
