<?php

declare(strict_types=1);

namespace SmsPortal;

use PDO;

/**
 * The SQLite database. Its schema is the one of the Docker version
 * (server/db.ts), migration for migration, so a database can move between
 * the two; the tables only the PHP version needs are created apart from
 * that numbering.
 */
final class Db
{
    /** Same list, same order as MIGRATIONS in server/db.ts; the index + 1 is PRAGMA user_version. */
    private static function migrations(): array
    {
        return [
            <<<'SQL'
            CREATE TABLE settings (
              key   TEXT PRIMARY KEY,
              value TEXT NOT NULL
            );

            CREATE TABLE dids (
              did           TEXT PRIMARY KEY,
              label         TEXT,
              color         TEXT NOT NULL,
              visible       INTEGER NOT NULL DEFAULT 1,
              sms_enabled   INTEGER NOT NULL DEFAULT 1,
              mms_available INTEGER NOT NULL DEFAULT 1,
              description   TEXT,
              position      INTEGER NOT NULL DEFAULT 0
            );

            CREATE TABLE contacts (
              id         INTEGER PRIMARY KEY,
              name       TEXT NOT NULL,
              notes      TEXT,
              created_at INTEGER NOT NULL,
              updated_at INTEGER NOT NULL
            );

            CREATE TABLE contact_phones (
              phone      TEXT PRIMARY KEY,
              contact_id INTEGER NOT NULL REFERENCES contacts(id) ON DELETE CASCADE
            );
            CREATE INDEX contact_phones_contact ON contact_phones(contact_id);

            CREATE TABLE conversations (
              id              INTEGER PRIMARY KEY,
              did             TEXT NOT NULL,
              phone           TEXT NOT NULL,
              last_message_id INTEGER,
              last_message_at INTEGER,
              unread_count    INTEGER NOT NULL DEFAULT 0,
              UNIQUE (did, phone)
            );
            CREATE INDEX conversations_recent ON conversations(last_message_at DESC);

            CREATE TABLE messages (
              id              INTEGER PRIMARY KEY,
              conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
              kind            TEXT NOT NULL CHECK (kind IN ('sms', 'mms')),
              remote_id       TEXT,
              direction       TEXT NOT NULL CHECK (direction IN ('in', 'out')),
              body            TEXT NOT NULL DEFAULT '',
              sent_at         INTEGER NOT NULL,
              status          TEXT NOT NULL,
              error           TEXT,
              carrier_status  TEXT,
              created_at      INTEGER NOT NULL,
              UNIQUE (kind, remote_id)
            );
            CREATE INDEX messages_conversation ON messages(conversation_id, sent_at, id);

            CREATE TABLE attachments (
              id         INTEGER PRIMARY KEY,
              message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
              position   INTEGER NOT NULL,
              remote_url TEXT,
              file_name  TEXT,
              mime       TEXT,
              size       INTEGER,
              status     TEXT NOT NULL,
              attempts   INTEGER NOT NULL DEFAULT 0
            );
            CREATE INDEX attachments_message ON attachments(message_id);
            CREATE INDEX attachments_pending ON attachments(status) WHERE status = 'pending';
            SQL,
            'ALTER TABLE attachments ADD COLUMN next_attempt_at INTEGER NOT NULL DEFAULT 0;',
            static function (PDO $db): void {
                $update = $db->prepare('UPDATE messages SET body = ? WHERE id = ?');
                foreach ($db->query("SELECT id, body FROM messages WHERE instr(body, '\\') > 0")->fetchAll() as $row) {
                    $body = Text::unescapeQuotes($row['body']);
                    if ($body !== $row['body']) {
                        self::execute($update, [$body, $row['id']]);
                    }
                }
            },
            'ALTER TABLE conversations ADD COLUMN archived_at INTEGER;',
            static function (PDO $db): void {
                $db->exec("ALTER TABLE messages ADD COLUMN search_text TEXT NOT NULL DEFAULT ''");
                $update = $db->prepare('UPDATE messages SET search_text = ? WHERE id = ?');
                foreach ($db->query('SELECT id, body FROM messages')->fetchAll() as $row) {
                    self::execute($update, [Text::fold($row['body']), $row['id']]);
                }
            },
            <<<'SQL'
            CREATE TABLE push_subscriptions (
              endpoint   TEXT PRIMARY KEY,
              p256dh     TEXT NOT NULL,
              auth       TEXT NOT NULL,
              device     TEXT,
              lang       TEXT NOT NULL DEFAULT 'fr',
              created_at INTEGER NOT NULL,
              updated_at INTEGER NOT NULL
            );
            SQL,
            'ALTER TABLE dids ADD COLUMN sms_available INTEGER NOT NULL DEFAULT 1;',
        ];
    }

    /** Tables of the PHP version only; the Docker version ignores them. */
    private const PHP_TABLES = <<<'SQL'
        -- What the Docker version sends over Server-Sent Events, kept for tabs to poll.
        CREATE TABLE IF NOT EXISTS events (
          id         INTEGER PRIMARY KEY AUTOINCREMENT,
          data       TEXT NOT NULL,
          created_at INTEGER NOT NULL
        );
        -- Open tabs, from their polls: whether someone is looking, and where.
        CREATE TABLE IF NOT EXISTS tabs (
          tab     TEXT PRIMARY KEY,
          device  TEXT,
          visible INTEGER NOT NULL,
          seen_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS login_attempts (
          ip TEXT NOT NULL,
          at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS login_attempts_ip ON login_attempts(ip, at);
        SQL;

    private const PHP_TABLES_VERSION = '1';

    /**
     * Prepares and runs a statement, binding each value with its own type:
     * PDO's execute([...]) sends them all as text, and SQLite does not
     * convert text compared with a computed value (COUNT(*) = '0' is false).
     */
    public static function run(PDO $db, string $sql, array $params = []): \PDOStatement
    {
        $statement = $db->prepare($sql);
        self::execute($statement, $params);
        return $statement;
    }

    public static function execute(\PDOStatement $statement, array $params): void
    {
        foreach (array_values($params) as $i => $value) {
            $type = match (true) {
                is_int($value) => PDO::PARAM_INT,
                is_bool($value) => PDO::PARAM_BOOL,
                $value === null => PDO::PARAM_NULL,
                default => PDO::PARAM_STR,
            };
            $statement->bindValue($i + 1, $value, $type);
        }
        $statement->execute();
    }

    public static function open(string $file): PDO
    {
        $dsn = 'sqlite:' . $file;
        // PHP 8.4 has a SQLite-specific class; createFunction moved there.
        $db = class_exists(\Pdo\Sqlite::class) ? new \Pdo\Sqlite($dsn) : new PDO($dsn);
        $db->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
        $db->setAttribute(PDO::ATTR_DEFAULT_FETCH_MODE, PDO::FETCH_ASSOC);
        $db->exec('PRAGMA busy_timeout = 5000');
        $db->exec('PRAGMA journal_mode = WAL');
        $db->exec('PRAGMA foreign_keys = ON');
        $fold = static fn ($value) => is_string($value) ? Text::fold($value) : $value;
        if ($db instanceof \Pdo\Sqlite) {
            $db->createFunction('fold', $fold, 1, \Pdo\Sqlite::DETERMINISTIC);
        } else {
            $db->sqliteCreateFunction('fold', $fold, 1, PDO::SQLITE_DETERMINISTIC);
        }
        self::migrate($db);
        return $db;
    }

    private static function migrate(PDO $db): void
    {
        $migrations = self::migrations();
        while ((int) $db->query('PRAGMA user_version')->fetchColumn() < count($migrations)) {
            // Two first requests can arrive together: the one that waited finds the work done.
            $db->exec('BEGIN IMMEDIATE');
            try {
                $i = (int) $db->query('PRAGMA user_version')->fetchColumn();
                if ($i < count($migrations)) {
                    $migration = $migrations[$i];
                    if (is_string($migration)) {
                        $db->exec($migration);
                    } else {
                        $migration($db);
                    }
                    $db->exec('PRAGMA user_version = ' . ($i + 1));
                }
                $db->exec('COMMIT');
            } catch (\Throwable $e) {
                $db->exec('ROLLBACK');
                throw $e;
            }
        }
        $version = $db->query("SELECT value FROM settings WHERE key = 'php.schema'")->fetchColumn();
        if ($version !== self::PHP_TABLES_VERSION) {
            $db->exec(self::PHP_TABLES);
            self::run($db, "INSERT INTO settings (key, value) VALUES ('php.schema', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", [self::PHP_TABLES_VERSION]);
        }
    }
}
