<?php

// Keeping the database in step with VoIP.ms, against a
// scripted VoIP.ms account instead of the HTTP one.

declare(strict_types=1);

require __DIR__ . '/../harness.php';

use SmsPortal\Events;
use SmsPortal\Log;
use SmsPortal\Repo;
use SmsPortal\Sync;
use SmsPortal\Time;
use SmsPortal\VoipMs\VoipMsApi;
use SmsPortal\VoipMs\VoipMsError;

const TZ = 'America/New_York';

/** A scriptable VoIP.ms account. */
final class FakeVoipMs implements VoipMsApi
{
    /** @var list<array> the account's history, as getMessages gives it */
    public array $messages = [];
    /** @var list<array{kind: string, from: string, to: string, limit: int}> */
    public array $queries = [];
    /** Date given to pushed messages without one. */
    public string $defaultDate = '2026-10-02 14:24:20';
    /** @var array<string, string> method => VoIP.ms status to fail its next call with */
    public array $failNext = [];
    private array $nextId = ['sms' => 1000, 'mms' => 500];

    /** Adds a message to the history; returns its index in $messages, to change it later. */
    public function push(array $m): int
    {
        $kind = $m['kind'] ?? (!empty($m['media']) ? 'mms' : 'sms');
        $this->messages[] = $m + [
            'kind' => $kind,
            'id' => (string) $this->nextId[$kind]++,
            'date' => $this->defaultDate,
            'did' => '4506575294',
            'contact' => '4383980707',
            'carrierStatus' => null,
            'media' => [],
        ];
        return count($this->messages) - 1;
    }

    private function maybeFail(string $method): void
    {
        if (isset($this->failNext[$method])) {
            $code = $this->failNext[$method];
            unset($this->failNext[$method]);
            throw new VoipMsError($code);
        }
    }

    public function getIP(): string
    {
        return '198.51.100.7';
    }

    public function getBalance(): float
    {
        return 24.1175;
    }

    public function getDids(): array
    {
        return [['did' => '4506575294', 'description' => 'Le Gardeur, QC', 'smsAvailable' => true, 'smsEnabled' => true, 'mmsAvailable' => true, 'callback' => null]];
    }

    public function enableSms(string $did, ?array $callback = null): void
    {
    }

    public function setCallback(string $did, ?array $callback): void
    {
    }

    public function getMessages(string $kind, string $from, string $to, int $limit): array
    {
        $this->maybeFail('getMessages');
        $this->queries[] = ['kind' => $kind, 'from' => $from, 'to' => $to, 'limit' => $limit];
        return array_values(array_filter(
            $this->messages,
            static fn (array $m) => $m['kind'] === $kind && substr($m['date'], 0, 10) >= $from && substr($m['date'], 0, 10) <= $to,
        ));
    }

    public function sendSms(string $did, string $dst, string $message): string
    {
        return (string) $this->nextId['sms']++;
    }

    public function sendMms(string $did, string $dst, string $message, array $media): string
    {
        return (string) $this->nextId['mms']++;
    }

    public function deleteMessage(string $kind, string $id): void
    {
    }
}

/** What each case starts from: an empty database, set up and checking an account with nothing in it yet. */
final class SyncContext
{
    public Repo $repo;
    public FakeVoipMs $client;
    public Sync $sync;
    public int $now;

    public function __construct()
    {
        $dir = tempDir();
        Log::to("$dir/portal.log");
        $this->now = Time::zonedToEpoch('2026-10-02 15:00:00', TZ);
        Time::travelTo($this->now);
        $this->repo = freshRepo();
        $this->client = new FakeVoipMs();
        $client = $this->client;
        // Built the way App::buildAccount builds it, without the webhook.
        $this->sync = new Sync(
            repo: $this->repo,
            events: new Events($this->repo),
            getClient: fn () => $client,
            isEnabled: fn () => true,
            timeZone: TZ,
            pollActiveMs: 10_000,
            pollIdleMs: 60_000,
            lockDir: $dir,
            onIncoming: function (array $items): void {
            },
            cronCommand: 'php cron.php',
        );
    }

    /** What the open tabs were told, oldest first. */
    public function broadcast(): array
    {
        return array_map(
            static fn (string $json) => json_decode($json, true),
            $this->repo->run('SELECT data FROM events ORDER BY id')->fetchAll(PDO::FETCH_COLUMN),
        );
    }

    /** @return list<array> the events of one type */
    public function broadcastOf(string $type): array
    {
        return array_values(array_filter($this->broadcast(), static fn (array $e) => $e['type'] === $type));
    }

    /** The whole of a queued history import, as polls and the cron job would run it. */
    public function importHistory(int $days): void
    {
        $this->sync->startImport($days);
        $this->sync->continueImport(microtime(true) + 60);
    }

    public function conversation(string $phone): array
    {
        foreach ($this->repo->listConversations() as $c) {
            if ($c['phone'] === $phone) {
                return $c;
            }
        }
        fail("no conversation with $phone");
    }
}

test('treats the very first sync as a quiet baseline', function (): void {
    $ctx = new SyncContext();
    $ctx->client->push(['direction' => 'in', 'body' => 'Old news', 'date' => '2026-10-02 09:00:00']);
    $ctx->sync->syncRecent();
    [$conversation] = $ctx->repo->listConversations();
    assertSame(['4383980707', '4506575294', 0], [$conversation['phone'], $conversation['did'], $conversation['unreadCount']]);
    assertSame([], $ctx->broadcastOf('message'));
    assertTrue(count($ctx->broadcastOf('reload')) > 0, 'the tabs reload instead');
});

test('stores new incoming messages as unread, once', function (): void {
    $ctx = new SyncContext();
    $ctx->sync->syncRecent();
    $ctx->client->push(['direction' => 'in', 'body' => 'Salut!', 'date' => '2026-10-02 14:59:00']);
    $ctx->sync->syncRecent();
    $ctx->sync->syncRecent();
    $conversations = $ctx->repo->listConversations();
    assertSame(1, count($conversations));
    assertSame(1, $conversations[0]['unreadCount']);
    $messages = $ctx->repo->listMessages($conversations[0]['id']);
    assertSame(1, count($messages));
    assertSame(Time::zonedToEpoch('2026-10-02 14:59:00', TZ), $messages[0]['sentAt']);
    assertSame(1, count($ctx->broadcastOf('message')));
});

test('keeps SMS and MMS ids apart', function (): void {
    $ctx = new SyncContext();
    $ctx->client->push(['kind' => 'sms', 'id' => '42', 'direction' => 'in', 'body' => 'sms']);
    $ctx->client->push(['kind' => 'mms', 'id' => '42', 'direction' => 'in', 'body' => 'mms', 'media' => ['https://voip.ms/media/a/media.png']]);
    $ctx->sync->syncRecent();
    [$conversation] = $ctx->repo->listConversations();
    $messages = $ctx->repo->listMessages($conversation['id']);
    $kinds = array_column($messages, 'kind');
    sort($kinds);
    assertSame(['mms', 'sms'], $kinds);
    $mms = array_values(array_filter($messages, static fn (array $m) => $m['kind'] === 'mms'))[0];
    assertSame(1, count($mms['attachments']));
    assertSame(['pending', null], [$mms['attachments'][0]['status'], $mms['attachments'][0]['url']]);
});

test('records messages sent from elsewhere and follows carrier status', function (): void {
    $ctx = new SyncContext();
    $ctx->sync->syncRecent();
    $sent = $ctx->client->push(['direction' => 'out', 'body' => 'Sent from my phone']);
    $ctx->sync->syncRecent();
    $ctx->client->messages[$sent]['carrierStatus'] = 'Delivered';
    $ctx->sync->syncRecent();
    [$conversation] = $ctx->repo->listConversations();
    assertSame(0, $conversation['unreadCount']);
    [$message] = $ctx->repo->listMessages($conversation['id']);
    assertSame(['out', 'sent', 'Delivered'], [$message['direction'], $message['status'], $message['carrierStatus']]);
});

test('widens the window after a downtime', function (): void {
    $ctx = new SyncContext();
    $ctx->repo->setSetting('sync.lastSuccessAt', (string) ($ctx->now - 10 * Time::DAY_MS));
    $ctx->sync->syncRecent();
    $sms = array_values(array_filter($ctx->client->queries, static fn (array $q) => $q['kind'] === 'sms'))[0];
    assertSame(['2026-09-21', '2026-10-03'], [$sms['from'], $sms['to']]);
});

test('does not let a history import swallow texts newer than the last poll', function (): void {
    $ctx = new SyncContext();
    $ctx->sync->syncRecent();
    $ctx->repo->setSetting('sync.lastSuccessAt', (string) ($ctx->now - 5 * 60_000));
    $ctx->client->push(['direction' => 'in', 'body' => 'Just arrived', 'date' => '2026-10-02 14:58:00']);
    $ctx->client->push(['direction' => 'in', 'body' => 'Old one', 'date' => '2026-08-01 10:00:00', 'contact' => '5145550000']);
    $ctx->importHistory(90);
    assertSame(1, $ctx->conversation('4383980707')['unreadCount']);
    assertSame(0, $ctx->conversation('5145550000')['unreadCount']);
    $announced = array_column(array_column($ctx->broadcastOf('message'), 'message'), 'body');
    assertSame(['Just arrived'], $announced);
});

test('never adopts a message that is still waiting to be sent, nor one of another kind', function (): void {
    $ctx = new SyncContext();
    $ctx->sync->syncRecent();
    $conversationId = $ctx->repo->getOrCreateConversation('4506575294', '4383980707');
    $sentAt = Time::zonedToEpoch('2026-10-02 14:50:00', TZ);
    $message = ['conversationId' => $conversationId, 'remoteId' => null, 'direction' => 'out', 'body' => 'ok', 'sentAt' => $sentAt];
    $queued = $ctx->repo->insertMessage($message + ['kind' => 'sms', 'status' => 'sending']);
    $failedMms = $ctx->repo->insertMessage($message + ['kind' => 'mms', 'status' => 'failed']);
    $ctx->client->push(['kind' => 'sms', 'direction' => 'out', 'body' => 'ok', 'date' => '2026-10-02 14:50:30']);
    $ctx->sync->syncRecent();
    assertSame('sending', $ctx->repo->getMessage($queued)['status']);
    assertSame('failed', $ctx->repo->getMessage($failedMms)['status']);
    assertSame(3, count($ctx->repo->listMessages($conversationId)));
});

test('imports history quietly', function (): void {
    $ctx = new SyncContext();
    $ctx->client->push(['direction' => 'in', 'body' => 'Summer', 'date' => '2026-07-15 10:00:00']);
    $ctx->client->push(['direction' => 'in', 'body' => 'Spring', 'date' => '2026-04-15 10:00:00', 'contact' => '5145550000']);
    $ctx->importHistory(200);
    $conversations = $ctx->repo->listConversations();
    assertSame(2, count($conversations));
    assertSame([0, 0], array_column($conversations, 'unreadCount'));
    assertSame(null, $ctx->sync->status()['importing']);
});
