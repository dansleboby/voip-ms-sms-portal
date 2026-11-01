<?php

declare(strict_types=1);

namespace SmsPortal;

use SmsPortal\Http\Request;

/**
 * What people did that the admins may want to know about later: sign-ins,
 * including refused ones, changes to users, numbers and VoIP.ms accounts, and
 * deletions. Kept for KEEP_DAYS.
 */
final class Activity
{
    public const KEEP_DAYS = 180;
    public const PAGE = 100;

    public function __construct(private readonly Repo $repo)
    {
    }

    /**
     * What the person signed in did.
     *
     * @param array<string, mixed> $detail what to add, such as the fields a change touched
     */
    public function record(Request $req, string $action, ?string $target = null, array $detail = []): void
    {
        $this->recordAs($req->user, $req, $action, $target, $detail);
    }

    /**
     * @param ?array $user who did it, as Auth::verify returns it ('userId' null: the owner); null for nobody signed in
     * @param array<string, mixed> $detail
     */
    public function recordAs(?array $user, Request $req, string $action, ?string $target = null, array $detail = []): void
    {
        $now = Time::nowMs();
        $this->repo->run('DELETE FROM activity WHERE at < ?', [$now - self::KEEP_DAYS * Time::DAY_MS]);
        $this->repo->run(
            'INSERT INTO activity (at, user_key, actor, action, target, detail, ip) VALUES (?, ?, ?, ?, ?, ?, ?)',
            [
                $now,
                $user === null ? null : ($user['userId'] ?? Viewer::OWNER),
                $user === null ? null : ($user['name'] ?? $user['email'] ?? null),
                $action,
                $target,
                $detail ? json_encode($detail, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES) : null,
                $req->ip !== '' ? $req->ip : null,
            ],
        );
    }

    /** @return array{entries: list<array>, more: bool} the latest first, older than $beforeId when given (ActivityPageDto) */
    public function page(?int $beforeId): array
    {
        $rows = $this->repo->run(
            'SELECT * FROM activity WHERE id < ? ORDER BY id DESC LIMIT ?',
            [$beforeId ?? PHP_INT_MAX, self::PAGE + 1],
        )->fetchAll();
        return [
            'entries' => array_map(static fn (array $r) => [
                'id' => $r['id'],
                'at' => $r['at'],
                // The owner has no id; nobody signed in, no actor.
                'actor' => $r['user_key'] === null ? null : ['userId' => $r['user_key'] === Viewer::OWNER ? null : $r['user_key'], 'name' => $r['actor']],
                'action' => $r['action'],
                'target' => $r['target'],
                'detail' => $r['detail'] === null ? null : json_decode($r['detail'], true),
                'ip' => $r['ip'],
            ], array_slice($rows, 0, self::PAGE)),
            'more' => count($rows) > self::PAGE,
        ];
    }
}
