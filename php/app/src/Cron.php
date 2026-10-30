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

    /**
     * What the Docker image runs before it starts serving: the settings,
     * checked once, so that a mistake stops the container with its reason
     * in the logs, and their warnings show up there once rather than with
     * every request.
     */
    public static function check(string $appDir): int
    {
        try {
            $config = Config::load($appDir);
        } catch (ConfigError $e) {
            fwrite(STDERR, 'SMS Portal: ' . $e->getMessage() . "\n");
            return 1;
        }
        foreach ($config->warnings as $warning) {
            fwrite(STDERR, "SMS Portal: $warning\n");
        }
        if ($config->demo) {
            fwrite(STDERR, "SMS Portal: DEMO_MODE is on: using sample data, no real texts are sent.\n");
        }
        return 0;
    }

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
            $app->accounts->primary()->sync->recordCronRun();
            foreach ($app->repo->failStaleSends(Time::nowMs() - self::STALE_SEND_MS) as $id) {
                $message = $app->repo->getMessage($id);
                $conversation = $message ? $app->repo->getConversation($message['conversationId']) : null;
                $app->events->broadcast(['type' => 'message', 'message' => $message, 'conversation' => $conversation]);
            }
            $checked = false;
            foreach ($app->accounts->all() as $account) {
                if ($account->sync->isDue($app->events->hasOpenTabs())) {
                    $account->sync->syncRecent();
                    $checked = true;
                }
            }
            if (!$checked && $app->config->install !== 'docker') {
                // The tabs learn that the cron job is alive (Docker runs its own, which Settings does not show).
                $app->accounts->publishStatus();
            }
            foreach ($app->accounts->all() as $account) {
                $account->sync->continueImport($deadline);
            }
            $app->media->drain($deadline);
            $app->deletions->drain($deadline);
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
