<?php

/*
 * Run every minute from cPanel > Cron Jobs (Settings shows the exact line):
 *   /usr/local/bin/php /home/you/sms-portal/cron.php
 * It checks VoIP.ms for new texts while nobody has the app open, which is
 * also what sends push notifications then.
 */

declare(strict_types=1);

require __DIR__ . '/bootstrap.php';

exit(SmsPortal\Cron::run(__DIR__));
