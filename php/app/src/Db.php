<?php

declare(strict_types=1);

namespace SmsPortal;

use PDO;

/**
 * The SQLite database. Its migrations are those of the Node server of 1.x
 * (the Docker image before 2.0), migration for migration, so the databases
 * it left behind carry on here; the tables it kept in memory instead are
 * created apart from that numbering.
 */
final class Db
{
    /** Appended, never edited: the index + 1 is PRAGMA user_version. */
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
            <<<'SQL'
            ALTER TABLE contacts ADD COLUMN color TEXT;
            ALTER TABLE contacts ADD COLUMN icon TEXT;
            SQL,
            <<<'SQL'
            ALTER TABLE messages ADD COLUMN deleted_at INTEGER;
            ALTER TABLE messages ADD COLUMN delete_remote INTEGER NOT NULL DEFAULT 0;
            CREATE INDEX messages_delete_remote ON messages(delete_remote) WHERE delete_remote = 1;
            SQL,
            static function (PDO $db): void {
                $update = $db->prepare("UPDATE messages SET body = '', search_text = '' WHERE id = ?");
                foreach ($db->query("SELECT id, body FROM messages WHERE body <> '' AND body NOT GLOB '*[0-9A-Za-z]*'")->fetchAll() as $row) {
                    if (Text::isBlank($row['body'])) {
                        self::execute($update, [$row['id']]);
                    }
                }
            },
            <<<'SQL'
            CREATE TABLE voipms_accounts (
              id         INTEGER PRIMARY KEY,
              label      TEXT,
              created_at INTEGER NOT NULL
            );
            INSERT INTO voipms_accounts (id, label, created_at) VALUES (1, NULL, CAST(strftime('%s', 'now') AS INTEGER) * 1000);
            ALTER TABLE dids ADD COLUMN account_id INTEGER NOT NULL DEFAULT 1;
            SQL,
            <<<'SQL'
            CREATE TABLE users (
              -- AUTOINCREMENT: a deleted user's id never goes to someone else.
              id            INTEGER PRIMARY KEY AUTOINCREMENT,
              email         TEXT NOT NULL UNIQUE,
              name          TEXT,
              -- pbkdf2-sha256$<iterations>$<salt>$<hash> (Passwords)
              password_hash TEXT NOT NULL,
              role          TEXT NOT NULL CHECK (role IN ('admin', 'user')),
              disabled_at   INTEGER,
              created_at    INTEGER NOT NULL,
              updated_at    INTEGER NOT NULL
            );
            CREATE TABLE user_dids (
              user_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
              did      TEXT NOT NULL,
              can_send INTEGER NOT NULL DEFAULT 1,
              PRIMARY KEY (user_id, did)
            );
            CREATE TABLE sessions (
              -- SHA-256 of the id in the cookie: the table alone signs nobody in.
              id           TEXT PRIMARY KEY,
              -- NULL: the owner, signed in with APP_PASSWORD.
              user_id      INTEGER REFERENCES users(id) ON DELETE CASCADE,
              created_at   INTEGER NOT NULL,
              last_seen_at INTEGER NOT NULL,
              user_agent   TEXT
            );
            CREATE INDEX sessions_user ON sessions(user_id);
            SQL,
            // What each person sees in the Team mode: numbers whose unread counts and archive are
            // their own, who sent each text, and whose browser each push subscription is.
            <<<'SQL'
            -- 1: one unread count and archive for everyone; 0: one per person (conversation_states).
            ALTER TABLE dids ADD COLUMN shared_state INTEGER NOT NULL DEFAULT 1;
            -- Who sent a text from the portal: 0 the owner, otherwise a user's id; NULL when nobody known did
            -- (sent elsewhere, or before 2.0). The name as it was then, which stays if the user goes.
            ALTER TABLE messages ADD COLUMN sent_by_user INTEGER;
            ALTER TABLE messages ADD COLUMN sent_by_name TEXT;
            -- 0: the owner's browser, otherwise a user's.
            ALTER TABLE push_subscriptions ADD COLUMN user_key INTEGER NOT NULL DEFAULT 0;
            CREATE TABLE conversation_states (
              conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
              -- 0: the owner; otherwise a user's id.
              user_key        INTEGER NOT NULL,
              -- The last message read (date and id): later incoming ones are unread. NULL: the shared count.
              read_at         INTEGER,
              read_message_id INTEGER,
              archived_at     INTEGER,
              PRIMARY KEY (conversation_id, user_key)
            );
            SQL,
            <<<'SQL'
            -- What each person (0: the owner; otherwise a user's id) chose for a number, for themselves.
            CREATE TABLE did_prefs (
              user_key INTEGER NOT NULL,
              did      TEXT NOT NULL,
              -- Out of their list of conversations and of their notifications.
              hidden   INTEGER NOT NULL DEFAULT 0,
              -- No notifications.
              muted    INTEGER NOT NULL DEFAULT 0,
              PRIMARY KEY (user_key, did)
            );
            SQL,
        ];
    }

    /**
     * Created on every open, outside the migrations: the Node server of 1.x
     * (the Docker image before 2.0) kept these in memory, so the databases it
     * left behind lack them.
     */
    private const PHP_TABLES = <<<'SQL'
        -- What happened, kept for open tabs to poll.
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

    /**
     * Opens the database and brings its schema up to date. Tests pass
     * $version to build the database of an earlier release, as it stopped
     * at that migration, and check what the later ones do to it.
     */
    public static function open(string $file, ?int $version = null): PDO
    {
        $db = new \Pdo\Sqlite('sqlite:' . $file);
        $db->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
        $db->setAttribute(PDO::ATTR_DEFAULT_FETCH_MODE, PDO::FETCH_ASSOC);
        $db->exec('PRAGMA busy_timeout = 5000');
        $db->exec('PRAGMA journal_mode = WAL');
        $db->exec('PRAGMA foreign_keys = ON');
        $db->createFunction('fold', static fn ($value) => is_string($value) ? Text::fold($value) : $value, 1, \Pdo\Sqlite::DETERMINISTIC);
        self::migrate($db, $version);
        return $db;
    }

    private static function migrate(PDO $db, ?int $version): void
    {
        $migrations = array_slice(self::migrations(), 0, $version);
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
