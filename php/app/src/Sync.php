<?php

declare(strict_types=1);

namespace SmsPortal;

use SmsPortal\VoipMs\VoipMsApi;
use SmsPortal\VoipMs\VoipMsError;

/**
 * Keeps the database in step with VoIP.ms by polling getSMS/getMMS. There
 * is no process of its own to run a timer: checks happen when an open tab
 * polls (every POLL_INTERVAL_ACTIVE) and when the cron job runs (every
 * POLL_INTERVAL_IDLE; at most once a minute on shared hosting, every 10 s
 * in Docker). Its state lives in the settings table.
 *
 * VoIP.ms keeps the history, so polling never loses anything: after a
 * downtime the next check widens its window back to the last success.
 */
final class Sync
{
    private const LAST_SUCCESS_KEY = 'sync.lastSuccessAt';
    private const LAST_CHECK_KEY = 'sync.lastCheckAt';
    private const LAST_ERROR_KEY = 'sync.lastError';
    private const ERRORS_KEY = 'sync.errorCount';
    private const IMPORT_KEY = 'sync.import';
    private const CRON_KEY = 'cron.lastRunAt';
    /** VoIP.ms refuses ranges over 92 days; smaller windows also keep responses small. */
    private const WINDOW_DAYS = 30;
    /** A full page is treated as possibly truncated and fetched again one day at a time. */
    private const PAGE_LIMIT = 1000;
    /** Local outgoing message with no VoIP.ms id that a fetched message may correspond to. */
    private const ADOPT_WINDOW_MS = 15 * 60_000;
    private const RATE_LIMIT_BACKOFF_MS = 60_000;
    private const MAX_ERROR_BACKOFF_MS = 5 * 60_000;

    /**
     * @param \Closure(): ?VoipMsApi $getClient
     * @param \Closure(): bool $isEnabled the setup wizard is done and there are credentials
     * @param \Closure(list<array{messageId: int, conversationId: int}>): void $onIncoming new incoming texts (not history)
     */
    public function __construct(
        private readonly Repo $repo,
        private readonly Events $events,
        private readonly \Closure $getClient,
        private readonly \Closure $isEnabled,
        private readonly string $timeZone,
        private readonly int $pollActiveMs,
        private readonly int $pollIdleMs,
        private readonly string $lockDir,
        private readonly \Closure $onIncoming,
        /** The line for cPanel's cron jobs; null where the server runs its own (Docker). */
        private readonly ?string $cronCommand,
        /** VoIP.ms announcing texts: with every number covered, checks become a safety net. */
        private readonly ?Webhook $webhook = null,
        /** The VoIP.ms account checked; each has its own (Accounts). */
        private readonly int $accountId = Repo::PRIMARY_ACCOUNT,
        /** @var ?\Closure(): void tells the tabs the state changed; by default, this account's own status */
        private readonly ?\Closure $publish = null,
    ) {
    }

    /** This account's setting key: the first account keeps the keys of 1.x. */
    private function key(string $key): string
    {
        return Repo::accountKey($this->accountId, $key);
    }

    /** A check of this account, and only this one, at a time. */
    private function lockName(): string
    {
        return $this->accountId === Repo::PRIMARY_ACCOUNT ? 'sync' : "sync-$this->accountId";
    }

    public function status(): array
    {
        $last = $this->repo->getSetting($this->key(self::LAST_SUCCESS_KEY));
        $checked = $this->repo->getSetting($this->key(self::LAST_CHECK_KEY));
        $error = $this->repo->getSetting($this->key(self::LAST_ERROR_KEY));
        $import = $this->import();
        $cron = $this->repo->getSetting(self::CRON_KEY);
        if (!($this->isEnabled)()) {
            $state = 'disabled';
        } elseif (Lock::isHeld($this->lockDir, $this->lockName())) {
            $state = 'syncing';
        } else {
            $state = $error !== null ? 'error' : 'idle';
        }
        return [
            'state' => $state,
            'mode' => $this->events->hasOpenTabs() ? 'active' : 'idle',
            'lastSyncAt' => $last !== null ? (int) $last : null,
            'lastCheckAt' => $checked !== null ? (int) $checked : null,
            'lastError' => $error,
            'importing' => $import ? ['done' => $import['done'], 'total' => $import['total']] : null,
            'webhook' => $this->webhook?->summary(),
        ] + ($this->cronCommand === null ? [] : ['cron' => ['lastRunAt' => $cron !== null ? (int) $cron : null, 'command' => $this->cronCommand]]);
    }

    public function recordCronRun(): void
    {
        $this->repo->setSetting(self::CRON_KEY, (string) Time::nowMs());
    }

    /**
     * Whether a check is due: faster while someone has the app open, slower
     * after errors, and only as a safety net while VoIP.ms announces texts,
     * except for a tab that just opened ($opening).
     */
    public function isDue(bool $active, bool $opening = false): bool
    {
        $interval = $active ? $this->pollActiveMs : $this->pollIdleMs;
        $errors = (int) ($this->repo->getSetting($this->key(self::ERRORS_KEY)) ?? 0);
        if ($errors > 0) {
            $interval = $this->repo->getSetting($this->key(self::LAST_ERROR_KEY)) === 'api_limit_exceeded'
                ? self::RATE_LIMIT_BACKOFF_MS
                : min($interval * 2 ** ($errors - 1), self::MAX_ERROR_BACKOFF_MS);
        } elseif (!$opening && $this->webhook?->complete()) {
            $interval = Webhook::SAFETY_INTERVAL_MS;
        }
        // Polls and cron runs do not land exactly on the interval: a little early still counts.
        $slack = min(5000, intdiv($interval, 4));
        return Time::nowMs() - (int) ($this->repo->getSetting($this->key(self::LAST_CHECK_KEY)) ?? 0) >= $interval - $slack;
    }

    /**
     * Fetches everything since the last successful sync (at least the last
     * day). Skipped while another process syncs, unless $wait.
     */
    public function syncRecent(bool $wait = false): void
    {
        $client = ($this->getClient)();
        if ($client === null || !($this->isEnabled)()) {
            return;
        }
        $lock = $wait ? Lock::wait($this->lockDir, $this->lockName(), 60) : Lock::take($this->lockDir, $this->lockName());
        if ($lock === null) {
            return;
        }
        $now = Time::nowMs();
        $last = (int) ($this->repo->getSetting($this->key(self::LAST_SUCCESS_KEY)) ?? 0);
        // A day before the last success absorbs clock and time zone edges; at most 90 days back.
        $from = max(min($now - Time::DAY_MS, ($last ?: $now) - Time::DAY_MS), $now - 90 * Time::DAY_MS);
        try {
            // The very first sync only sets a baseline: no unread badges or notifications for old texts.
            $this->syncRange($client, $from, $now + Time::DAY_MS, $last > 0 ? PHP_INT_MIN : PHP_INT_MAX);
            $this->repo->setSetting($this->key(self::LAST_SUCCESS_KEY), (string) $now);
            $this->repo->deleteSetting($this->key(self::LAST_ERROR_KEY));
            $this->repo->deleteSetting($this->key(self::ERRORS_KEY));
        } catch (VoipMsError $e) {
            $this->recordError($e->errorCode, $e);
        } catch (\Throwable $e) {
            $this->recordError('internal_error', $e);
        } finally {
            $this->repo->setSetting($this->key(self::LAST_CHECK_KEY), (string) $now);
            $lock->release();
        }
        $this->publishStatus();
    }

    private function recordError(string $code, \Throwable $e): void
    {
        $this->repo->setSetting($this->key(self::LAST_ERROR_KEY), $code);
        $this->repo->setSetting($this->key(self::ERRORS_KEY), (string) ((int) ($this->repo->getSetting($this->key(self::ERRORS_KEY)) ?? 0) + 1));
        Log::warn('VoIP.ms sync failed', ['code' => $code, 'err' => $e]);
    }

    // ------------------------------------------------------------ history import

    private function import(): ?array
    {
        $raw = $this->repo->getSetting($this->key(self::IMPORT_KEY));
        $job = $raw !== null ? json_decode($raw, true) : null;
        return is_array($job) ? $job : null;
    }

    /**
     * Queues the import of the last $days of history; continueImport works
     * through it a month at a time. Texts newer than the last check still
     * count as new: the import must not swallow one the next check would
     * have announced.
     */
    public function startImport(int $days): void
    {
        if ($this->import() !== null) {
            return;
        }
        $now = Time::nowMs();
        $last = (int) ($this->repo->getSetting($this->key(self::LAST_SUCCESS_KEY)) ?? 0);
        // Newest first, so recent conversations show up while older ones load.
        $windows = array_reverse(self::splitWindows($now - $days * Time::DAY_MS, $now + Time::DAY_MS, self::WINDOW_DAYS));
        $this->repo->setSetting($this->key(self::IMPORT_KEY), json_encode([
            'windows' => $windows,
            'total' => count($windows),
            'done' => 0,
            'liveAfter' => $last > 0 ? $last : PHP_INT_MAX,
        ]));
        $this->publishStatus();
    }

    /** Imports queued history until $deadline (microtime). */
    public function continueImport(float $deadline): void
    {
        $job = $this->import();
        $client = ($this->getClient)();
        if ($job === null || $client === null) {
            return;
        }
        $lock = Lock::take($this->lockDir, $this->lockName());
        if ($lock === null) {
            return;
        }
        try {
            while ($job['windows'] && microtime(true) < $deadline) {
                [$from, $to] = array_shift($job['windows']);
                $this->syncRange($client, $from, $to, $job['liveAfter']);
                $job['done']++;
                $this->repo->setSetting($this->key(self::IMPORT_KEY), json_encode($job));
                $this->events->broadcast(['type' => 'reload']);
                $this->publishStatus();
            }
            if (!$job['windows']) {
                $this->repo->deleteSetting($this->key(self::IMPORT_KEY));
            }
        } catch (\Throwable $e) {
            Log::error('History import failed', ['err' => $e]);
            $this->repo->deleteSetting($this->key(self::IMPORT_KEY));
        } finally {
            $lock->release();
        }
        if ($this->import() === null) {
            $this->publishStatus();
        }
    }

    // ------------------------------------------------------------------ fetching

    /** Messages sent after $liveAfter count as new (unread, announced); older ones are stored quietly. */
    private function syncRange(VoipMsApi $client, int $fromMs, int $toMs, int $liveAfter): void
    {
        $quiet = 0;
        foreach (self::splitWindows($fromMs, $toMs, self::WINDOW_DAYS) as [$from, $to]) {
            foreach (['sms', 'mms'] as $kind) {
                $quiet += $this->ingest($this->fetchAll($client, $kind, $from, $to), $liveAfter);
            }
        }
        // Quiet changes are not announced one by one: the tabs reload instead.
        if ($quiet > 0) {
            $this->events->broadcast(['type' => 'reload']);
        }
    }

    /** Fetches a window; if it fills a page, falls back to one call per day. */
    private function fetchAll(VoipMsApi $client, string $kind, int $fromMs, int $toMs): array
    {
        $from = Time::epochToZonedDate($fromMs, $this->timeZone);
        $to = Time::epochToZonedDate($toMs, $this->timeZone);
        $messages = $client->getMessages($kind, $from, $to, self::PAGE_LIMIT);
        if (count($messages) < self::PAGE_LIMIT) {
            return $messages;
        }
        $all = [];
        foreach (self::datesBetween($fromMs, $toMs, $this->timeZone) as $date) {
            $day = $client->getMessages($kind, $date, $date, self::PAGE_LIMIT);
            if (count($day) >= self::PAGE_LIMIT) {
                Log::warn('More messages in one day than a page holds; some may be missing', ['kind' => $kind, 'date' => $date]);
            }
            array_push($all, ...$day);
        }
        return $all;
    }

    /**
     * Stores messages not seen before. Those sent after $liveAfter are new:
     * incoming ones become unread and each one is announced. Returns how
     * many changes were made quietly.
     */
    public function ingest(array $messages, int $liveAfter): int
    {
        $repo = $this->repo;
        $changed = [];
        $incoming = [];
        $quiet = 0;
        $newDid = false;

        // Sends take the same lock: a check and a send never race on the same message.
        $lock = Lock::wait($this->lockDir, 'write', 60) ?? throw new \RuntimeException('The write lock stayed busy');
        try {
            $repo->transaction(function () use ($messages, $liveAfter, $repo, &$changed, &$incoming, &$quiet, &$newDid): void {
                foreach ($messages as $remote) {
                    $did = Phone::normalize($remote['did']);
                    if ($remote['id'] === '' || !$repo->allowsDid($did)) {
                        continue;
                    }
                    // A number known under another account is that account's to fetch.
                    $owner = $repo->accountOfDid($did);
                    if ($owner !== null && $owner !== $this->accountId) {
                        continue;
                    }
                    $remoteId = Repo::storedRemoteId($this->accountId, $remote['id']);
                    $existing = $repo->findMessageByRemote($remote['kind'], $remoteId);
                    if ($existing) {
                        // Deleted in the portal: it stays deleted.
                        if ($existing['deleted']) {
                            continue;
                        }
                        if ($remote['carrierStatus'] && $remote['carrierStatus'] !== $existing['carrierStatus']) {
                            $repo->updateMessage($existing['id'], ['carrierStatus' => $remote['carrierStatus']]);
                            $row = $repo->getMessageRow($existing['id']);
                            if ($row && $row['sent_at'] > $liveAfter) {
                                $changed[] = ['messageId' => $row['id'], 'conversationId' => $row['conversation_id']];
                            } else {
                                $quiet++;
                            }
                        }
                        continue;
                    }

                    $phone = Phone::normalize($remote['contact']);
                    if ($did === '' || $phone === '') {
                        continue;
                    }
                    if ($owner === null) {
                        $repo->ensureDid($did, $this->accountId);
                        $newDid = true;
                    }
                    $conversationId = $repo->getOrCreateConversation($did, $phone);
                    try {
                        $sentAt = Time::zonedToEpoch($remote['date'], $this->timeZone);
                    } catch (\InvalidArgumentException) {
                        $sentAt = Time::nowMs();
                    }

                    $live = $sentAt > $liveAfter;
                    if ($remote['direction'] === 'out') {
                        $adopted = $this->adoptLocalSend($conversationId, $remote, $remoteId, $sentAt);
                        if ($adopted !== null) {
                            $changed[] = ['messageId' => $adopted, 'conversationId' => $conversationId];
                            continue;
                        }
                    }

                    $messageId = $repo->insertMessage([
                        'conversationId' => $conversationId,
                        'kind' => $remote['kind'],
                        'remoteId' => $remoteId,
                        'direction' => $remote['direction'],
                        'body' => $remote['body'],
                        'sentAt' => $sentAt,
                        'status' => $remote['direction'] === 'in' ? 'received' : 'sent',
                        'carrierStatus' => $remote['carrierStatus'],
                    ]);
                    foreach ($remote['media'] as $i => $url) {
                        $repo->insertAttachment($messageId, $i, ['remoteUrl' => $url, 'status' => 'pending']);
                    }
                    $repo->touchConversation($conversationId, $live && $remote['direction'] === 'in' ? 1 : 0);
                    if ($live) {
                        $repo->unarchiveConversation($conversationId);
                        $changed[] = ['messageId' => $messageId, 'conversationId' => $conversationId];
                        if ($remote['direction'] === 'in') {
                            $incoming[] = ['messageId' => $messageId, 'conversationId' => $conversationId];
                        }
                    } else {
                        $quiet++;
                    }
                }
            });
        } finally {
            $lock->release();
        }

        if ($newDid) {
            $this->events->broadcast(['type' => 'dids']);
        }
        foreach ($changed as $c) {
            $message = $repo->getMessage($c['messageId']);
            $conversation = $repo->getConversation($c['conversationId']);
            if ($message && $conversation) {
                $this->events->broadcast(['type' => 'message', 'message' => $message, 'conversation' => $conversation]);
            }
        }
        if ($changed) {
            $this->events->broadcast(['type' => 'dids']);
        }
        if ($incoming) {
            ($this->onIncoming)($incoming);
        }
        return $quiet;
    }

    /**
     * A send can fail ambiguously (timeout, Cloudflare 5xx) after VoIP.ms
     * accepted it. When the message then shows up in the history, it is
     * attached to the local copy instead of showing twice. Only failed
     * attempts qualify: a message still waiting to be sent must go out.
     */
    private function adoptLocalSend(int $conversationId, array $remote, string $remoteId, int $sentAt): ?int
    {
        $id = $this->repo->run(
            "SELECT m.id FROM messages m
             WHERE m.conversation_id = ? AND m.direction = 'out' AND m.remote_id IS NULL AND m.status = 'failed'
               AND m.kind = ? AND m.body = ? AND m.sent_at BETWEEN ? AND ?
               AND (SELECT COUNT(*) FROM attachments a WHERE a.message_id = m.id) = ?
             ORDER BY m.sent_at LIMIT 1",
            [
                $conversationId,
                $remote['kind'],
                $remote['body'],
                $sentAt - self::ADOPT_WINDOW_MS,
                $sentAt + self::ADOPT_WINDOW_MS,
                count($remote['media']),
            ],
        )->fetchColumn();
        if ($id === false) {
            return null;
        }
        $this->repo->updateMessage((int) $id, [
            'kind' => $remote['kind'],
            'remoteId' => $remoteId,
            'status' => 'sent',
            'error' => null,
            'carrierStatus' => $remote['carrierStatus'],
        ]);
        return (int) $id;
    }

    public function publishStatus(): void
    {
        if ($this->publish !== null) {
            ($this->publish)();
        } else {
            $this->events->broadcast(['type' => 'sync', 'status' => $this->status()]);
        }
    }

    /**
     * Splits [from, to] into windows of at most $days calendar days.
     * Consecutive windows share their boundary day so a DST shift can never
     * skip a date; the duplicates are dropped on ingest.
     *
     * @return list<array{0: int, 1: int}>
     */
    public static function splitWindows(int $fromMs, int $toMs, int $days): array
    {
        $windows = [];
        $span = ($days - 1) * Time::DAY_MS;
        for ($start = $fromMs; ; $start += $span) {
            $end = min($start + $span, $toMs);
            $windows[] = [$start, $end];
            if ($end >= $toMs) {
                return $windows;
            }
        }
    }

    /** @return list<string> every calendar date (in $timeZone) touched by [from, to] */
    public static function datesBetween(int $fromMs, int $toMs, string $timeZone): array
    {
        $dates = [];
        // Half-day steps cannot jump over a date, whatever the DST transitions.
        for ($t = $fromMs; $t < $toMs; $t += intdiv(Time::DAY_MS, 2)) {
            $dates[Time::epochToZonedDate($t, $timeZone)] = true;
        }
        $dates[Time::epochToZonedDate($toMs, $timeZone)] = true;
        return array_keys($dates);
    }
}
