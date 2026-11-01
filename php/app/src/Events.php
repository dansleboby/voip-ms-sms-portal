<?php

declare(strict_types=1);

namespace SmsPortal;

/**
 * Live updates for tabs that poll (GET /api/events/poll), kept in the
 * database, since every PHP request is a process of its own: the events
 * (shapes of ServerEvent in shared/types.ts) in a change log, and the open
 * tabs from their polls.
 */
final class Events
{
    /** Events kept; a tab that falls further behind reloads everything. */
    private const BACKLOG_SIZE = 500;
    /** A tab counts as open until it misses its polls for this long (hidden tabs poll every 30 s). */
    private const TAB_TTL_MS = 90_000;
    /** A visible tab polls every few seconds; one closed without a word stops hiding push notifications after this. */
    private const ON_SCREEN_TTL_MS = 15_000;
    private const EPOCH_KEY = 'events.epoch';

    public function __construct(private readonly Repo $repo)
    {
    }

    public function broadcast(array $event): void
    {
        $this->repo->run('INSERT INTO events (data, created_at) VALUES (?, ?)', [
            json_encode($event, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_INVALID_UTF8_SUBSTITUTE),
            Time::nowMs(),
        ]);
    }

    /**
     * The events after $after (none on a tab's first poll); each poll also
     * says that the tab is open, and whether it is visible.
     *
     * @return array{cursor: string, events: list<array>, reset: bool}
     */
    public function poll(?string $after, ?string $tab, ?string $device, bool $visible): array
    {
        if ($tab !== null) {
            $this->repo->run(
                'INSERT INTO tabs (tab, device, visible, seen_at) VALUES (?, ?, ?, ?)
                 ON CONFLICT(tab) DO UPDATE SET device = excluded.device, visible = excluded.visible, seen_at = excluded.seen_at',
                [$tab, $device, $visible ? 1 : 0, Time::nowMs()],
            );
        }
        [$oldest, $latest] = $this->repo->run('SELECT MIN(id), MAX(id) FROM events')->fetch(\PDO::FETCH_NUM);
        $latest = (int) $latest;
        $epoch = $this->epoch();
        $cursor = "$epoch.$latest";
        if ($after === null) {
            return ['cursor' => $cursor, 'events' => [], 'reset' => false];
        }
        $seq = $this->parseCursor($after, $epoch);
        $oldest = $oldest === null ? $latest + 1 : (int) $oldest;
        if ($seq === null || $seq > $latest || $seq < $oldest - 1) {
            return ['cursor' => $cursor, 'events' => [], 'reset' => true];
        }
        $rows = $this->repo->run('SELECT data FROM events WHERE id > ? AND id <= ? ORDER BY id', [$seq, $latest])->fetchAll(\PDO::FETCH_COLUMN);
        $events = array_map(static fn ($json) => json_decode($json, true), $rows);
        return ['cursor' => $cursor, 'events' => $events, 'reset' => false];
    }

    /** Records that a tab was shown or hidden. False for a tab that never polled. */
    public function setVisibility(string $tab, bool $visible): bool
    {
        return $this->repo->run('UPDATE tabs SET visible = ? WHERE tab = ?', [$visible ? 1 : 0, $tab])->rowCount() > 0;
    }

    /** True while the app is on screen in one of this browser's tabs. */
    public function isOnScreen(string $device): bool
    {
        return $this->repo->run('SELECT 1 FROM tabs WHERE device = ? AND visible = 1 AND seen_at > ? LIMIT 1', [$device, Time::nowMs() - self::ON_SCREEN_TTL_MS])
            ->fetchColumn() !== false;
    }

    /** Whether someone has the app open: VoIP.ms is then checked at the faster pace. */
    public function hasOpenTabs(): bool
    {
        return $this->repo->run('SELECT 1 FROM tabs WHERE seen_at > ? LIMIT 1', [Time::nowMs() - self::TAB_TTL_MS])->fetchColumn() !== false;
    }

    /** Drops old events and tabs gone quiet. */
    public function prune(): void
    {
        $this->repo->run('DELETE FROM events WHERE id <= (SELECT MAX(id) FROM events) - ?', [self::BACKLOG_SIZE]);
        $this->repo->run('DELETE FROM tabs WHERE seen_at < ?', [Time::nowMs() - self::TAB_TTL_MS]);
    }

    /** Changes when the database is replaced: cursors into another one must not match. */
    private function epoch(): string
    {
        $epoch = $this->repo->getSetting(self::EPOCH_KEY);
        if ($epoch === null) {
            $epoch = Base64Url::encode(random_bytes(6));
            $this->repo->setSetting(self::EPOCH_KEY, $epoch);
        }
        return $epoch;
    }

    private function parseCursor(string $cursor, string $epoch): ?int
    {
        $dot = strrpos($cursor, '.');
        if ($dot === false || substr($cursor, 0, $dot) !== $epoch) {
            return null;
        }
        $seq = substr($cursor, $dot + 1);
        return preg_match('/^\d{1,15}$/', $seq) ? (int) $seq : null;
    }
}
