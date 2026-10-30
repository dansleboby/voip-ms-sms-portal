<?php

// What the migrations do to the databases of earlier releases (server/security.test.ts, "database migrations").

declare(strict_types=1);

require __DIR__ . '/../harness.php';

use SmsPortal\Db;
use SmsPortal\Repo;

/** A database left by an earlier release: the schema it had at migration $version, and the rows $fill puts in. */
function oldDatabase(int $version, callable $fill): string
{
    $file = tempDir() . '/portal.db';
    $db = Db::open($file, $version);
    assertSame($version, (int) $db->query('PRAGMA user_version')->fetchColumn());
    $fill($db);
    return $file;
}

/** Inserts a row and returns its id. */
function insert(PDO $db, string $sql, array $params = []): int
{
    Db::run($db, $sql, $params);
    return (int) $db->lastInsertId();
}

test('puts the numbers of a 1.x database under the first VoIP.ms account, keeping its settings', function (): void {
    // The schema of 1.8, the last one with a single account.
    $file = oldDatabase(10, function (PDO $db): void {
        insert($db, "INSERT INTO dids (did, color) VALUES ('4506575294', '#1a73e8')");
        insert($db, "INSERT INTO settings (key, value) VALUES ('sync.lastSuccessAt', '1700000000000')");
    });
    $repo = new Repo(Db::open($file));
    assertSame([['id' => 1, 'label' => null, 'numbers' => 1]], $repo->listAccounts());
    $dids = $repo->listDids();
    assertSame([['4506575294', 1]], array_map(static fn (array $d) => [$d['did'], $d['accountId']], $dids));
    // The first account reads the keys 1.x wrote, so going back to 1.x still finds them.
    assertSame('1700000000000', $repo->getSetting(Repo::accountKey(1, 'sync.lastSuccessAt')));
    assertSame('account.2.sync.lastSuccessAt', Repo::accountKey(2, 'sync.lastSuccessAt'));
});

test('unescapes quotes in bodies stored by earlier versions', function (): void {
    $ids = [];
    $file = oldDatabase(2, function (PDO $db) use (&$ids): void {
        insert($db, "INSERT INTO dids (did, color) VALUES ('4506575294', '#1a73e8')");
        $conversationId = insert($db, "INSERT INTO conversations (did, phone) VALUES ('4506575294', '4383980707')");
        $id = insert(
            $db,
            "INSERT INTO messages (conversation_id, kind, remote_id, direction, body, sent_at, status, created_at) VALUES (?, 'sms', '9', 'in', ?, 0, 'received', 0)",
            [$conversationId, 'l\\\\\\\'accès'],
        );
        Db::run($db, 'UPDATE conversations SET last_message_id = ?, last_message_at = 0 WHERE id = ?', [$id, $conversationId]);
        $ids = ['conversation' => $conversationId, 'message' => $id];
    });
    $repo = new Repo(Db::open($file));
    assertSame("l'accès", $repo->getMessage($ids['message'])['body']);
    // Later migrations index the cleaned body for accent-insensitive search.
    assertSame([$ids['conversation']], array_column($repo->listConversations(null, "L'ACCES"), 'id'));
});

test('empties bodies stored as only line breaks or invisible characters', function (): void {
    // The schema before blank bodies were emptied, holding one of each.
    $ids = [];
    $file = oldDatabase(9, function (PDO $db) use (&$ids): void {
        insert($db, "INSERT INTO dids (did, color) VALUES ('4506575294', '#1a73e8')");
        $conversationId = insert($db, "INSERT INTO conversations (did, phone) VALUES ('4506575294', '4383980707')");
        $add = static fn (string $remoteId, string $body) => insert(
            $db,
            "INSERT INTO messages (conversation_id, kind, remote_id, direction, body, search_text, sent_at, status, created_at) VALUES (?, 'mms', ?, 'in', ?, ?, 0, 'received', 0)",
            [$conversationId, $remoteId, $body, $body],
        );
        $ids = ['blank' => $add('1', "\n\n\n \u{200b}\r\n"), 'text' => $add('2', " Allo\n"), 'emoji' => $add('3', '🎤')];
    });
    $repo = new Repo(Db::open($file));
    assertSame('', $repo->getMessage($ids['blank'])['body']);
    assertSame(" Allo\n", $repo->getMessage($ids['text'])['body']);
    assertSame('🎤', $repo->getMessage($ids['emoji'])['body']);
});
