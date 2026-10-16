<?php

declare(strict_types=1);

namespace SmsPortal;

/**
 * One run of the cron job (cron.php, every minute): checks VoIP.ms when
 * nobody has the app open, carries on with history imports and media
 * downloads, and tidies up. Settings shows when it last ran.
 */
final class Cron
{
    /** Leaves room before the next run, a minute later. */
    private const BUDGET_S = 50;
    /** A send still "sending" after this long died with its request. */
    private const STALE_SEND_MS = 5 * 60_000;

    public static function run(string $appDir): int
    {
        try {
            $app = App::boot($appDir);
        } catch (ConfigError $e) {
            fwrite(STDERR, 'SMS Portal: ' . $e->getMessage() . "\n");
            return 1;
        }
        $lock = Lock::take($app->config->dataDir, 'cron');
        if ($lock === null) {
            // The previous run is still going.
            return 0;
        }
        $deadline = microtime(true) + self::BUDGET_S;
        @set_time_limit(self::BUDGET_S + 70);
        try {
            $app->sync->recordCronRun();
            foreach ($app->repo->failStaleSends(Time::nowMs() - self::STALE_SEND_MS) as $id) {
                $message = $app->repo->getMessage($id);
                $conversation = $message ? $app->repo->getConversation($message['conversationId']) : null;
                $app->events->broadcast(['type' => 'message', 'message' => $message, 'conversation' => $conversation]);
            }
            if ($app->sync->isDue($app->events->hasOpenTabs())) {
                $app->sync->syncRecent();
            } else {
                // The tabs learn that the cron job is alive.
                $app->sync->publishStatus();
            }
            $app->sync->continueImport($deadline);
            $app->media->drain($deadline);
            $app->events->prune();
            $app->runDeferred();
        } catch (\Throwable $e) {
            Log::error('Cron run failed', ['err' => $e]);
            fwrite(STDERR, 'SMS Portal: ' . $e->getMessage() . "\n");
            return 1;
        } finally {
            $lock->release();
        }
        return 0;
    }
}
