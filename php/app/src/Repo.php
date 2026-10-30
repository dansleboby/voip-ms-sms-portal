<?php

declare(strict_types=1);

namespace SmsPortal;

use PDO;

/**
 * Reads and writes the database; port of Repo in server/db.ts. Methods
 * returning "Dto" arrays give the JSON shapes of shared/types.ts.
 */
final class Repo
{
    /** Distinct colors that read well on light and dark surfaces. */
    public const DID_COLORS = ['#1a73e8', '#e8710a', '#188038', '#a142f4', '#d93025', '#007b83', '#c5221f', '#9334e6'];

    private const MESSAGE_COLUMNS = 'id, conversation_id, kind, remote_id, direction, body, sent_at, status, error, carrier_status, created_at';

    private const CONVERSATION_SELECT = <<<'SQL'
        SELECT c.id, c.did, c.phone, c.last_message_id, c.last_message_at, c.unread_count, c.archived_at,
               m.body AS last_body, m.direction AS last_direction, m.status AS last_status,
               (SELECT COUNT(*) FROM attachments a WHERE a.message_id = m.id) AS last_attachments,
               ct.id AS contact_id, ct.name AS contact_name, ct.color AS contact_color, ct.icon AS contact_icon
        FROM conversations c
        LEFT JOIN messages m ON m.id = c.last_message_id
        LEFT JOIN contact_phones cp ON cp.phone = c.phone
        LEFT JOIN contacts ct ON ct.id = cp.contact_id
        SQL;

    private int $depth = 0;

    /**
     * @param list<string>|null $allowedDids the only numbers of the account the configuration lets the portal use (null: all of them)
     * @param list<string> $excludedDids numbers it leaves alone
     */
    public function __construct(
        public readonly PDO $db,
        private readonly ?array $allowedDids = null,
        private readonly array $excludedDids = [],
    ) {
    }

    /**
     * Whether the configuration lets the portal use a number. The others are
     * out of sight everywhere: their texts are not fetched, and those stored
     * before the number was left out stay in the database, hidden.
     */
    public function allowsDid(string $did): bool
    {
        return ($this->allowedDids === null || in_array($did, $this->allowedDids, true))
            && !in_array($did, $this->excludedDids, true);
    }

    /**
     * The same, as an SQL condition on $column, with its parameters.
     *
     * @return array{0: string, 1: list<string>}
     */
    private function didScope(string $column): array
    {
        $conditions = [];
        if ($this->allowedDids !== null) {
            $conditions[] = "$column IN (" . implode(', ', array_fill(0, count($this->allowedDids), '?')) . ')';
        }
        if ($this->excludedDids) {
            $conditions[] = "$column NOT IN (" . implode(', ', array_fill(0, count($this->excludedDids), '?')) . ')';
        }
        return [$conditions ? implode(' AND ', $conditions) : '1', [...($this->allowedDids ?? []), ...$this->excludedDids]];
    }

    /**
     * @template T
     * @param callable(): T $fn
     * @return T
     */
    public function transaction(callable $fn): mixed
    {
        if ($this->depth > 0) {
            return $fn();
        }
        // IMMEDIATE takes the write lock up front: two PHP processes upgrading
        // their read locks at the same time would otherwise fail with "busy".
        $this->db->exec('BEGIN IMMEDIATE');
        $this->depth++;
        try {
            $result = $fn();
            $this->db->exec('COMMIT');
            return $result;
        } catch (\Throwable $e) {
            $this->db->exec('ROLLBACK');
            throw $e;
        } finally {
            $this->depth--;
        }
    }

    public function run(string $sql, array $params = []): \PDOStatement
    {
        return Db::run($this->db, $sql, $params);
    }

    private function one(string $sql, array $params = []): ?array
    {
        $row = $this->run($sql, $params)->fetch();
        return $row === false ? null : $row;
    }

    /** @return list<array<string, mixed>> */
    private function all(string $sql, array $params = []): array
    {
        return $this->run($sql, $params)->fetchAll();
    }

    private static function placeholders(array $values): string
    {
        return implode(',', array_fill(0, count($values), '?'));
    }

    // ----------------------------------------------------------------- settings

    public function getSetting(string $key): ?string
    {
        $value = $this->run('SELECT value FROM settings WHERE key = ?', [$key])->fetchColumn();
        return $value === false ? null : (string) $value;
    }

    public function setSetting(string $key, string $value): void
    {
        $this->run('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', [$key, $value]);
    }

    public function deleteSetting(string $key): void
    {
        $this->run('DELETE FROM settings WHERE key = ?', [$key]);
    }

    // -------------------------------------------------------------------- users

    public function createUser(string $email, ?string $name, string $passwordHash, string $role): int
    {
        $now = Time::nowMs();
        $this->run(
            'INSERT INTO users (email, name, password_hash, role, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
            [$email, $name, $passwordHash, $role, $now, $now],
        );
        return (int) $this->db->lastInsertId();
    }

    public function getUserRow(int $id): ?array
    {
        return $this->one('SELECT * FROM users WHERE id = ?', [$id]);
    }

    public function findUserByEmail(string $email): ?array
    {
        return $this->one('SELECT * FROM users WHERE email = ?', [$email]);
    }

    public function listUsers(): array
    {
        $numbers = [];
        foreach ($this->all('SELECT user_id, did, can_send FROM user_dids ORDER BY did') as $n) {
            $numbers[$n['user_id']][] = ['did' => $n['did'], 'canSend' => $n['can_send'] === 1];
        }
        return array_map(static fn (array $r) => [
            'id' => $r['id'],
            'email' => $r['email'],
            'name' => $r['name'],
            'role' => $r['role'],
            'disabled' => $r['disabled_at'] !== null,
            'createdAt' => $r['created_at'],
            'numbers' => $numbers[$r['id']] ?? [],
        ], $this->all('SELECT * FROM users ORDER BY email'));
    }

    public function getUser(int $id): ?array
    {
        foreach ($this->listUsers() as $user) {
            if ($user['id'] === $id) {
                return $user;
            }
        }
        return null;
    }

    /** @param array{name?: ?string, role?: string, passwordHash?: string, disabled?: bool} $patch */
    public function updateUser(int $id, array $patch): bool
    {
        $sets = ['updated_at = ?'];
        $values = [Time::nowMs()];
        if (array_key_exists('name', $patch)) {
            $sets[] = 'name = ?';
            $values[] = $patch['name'];
        }
        if (isset($patch['role'])) {
            $sets[] = 'role = ?';
            $values[] = $patch['role'];
        }
        if (isset($patch['passwordHash'])) {
            $sets[] = 'password_hash = ?';
            $values[] = $patch['passwordHash'];
        }
        if (isset($patch['disabled'])) {
            $sets[] = 'disabled_at = ?';
            $values[] = $patch['disabled'] ? Time::nowMs() : null;
        }
        $values[] = $id;
        return $this->run('UPDATE users SET ' . implode(', ', $sets) . ' WHERE id = ?', $values)->rowCount() > 0;
    }

    public function deleteUser(int $id): bool
    {
        return $this->run('DELETE FROM users WHERE id = ?', [$id])->rowCount() > 0;
    }

    /** @param list<array{did: string, canSend: bool}> $numbers in place of those the user had */
    public function setUserNumbers(int $id, array $numbers): void
    {
        $this->transaction(function () use ($id, $numbers): void {
            $this->run('DELETE FROM user_dids WHERE user_id = ?', [$id]);
            foreach ($numbers as $n) {
                $this->run('INSERT INTO user_dids (user_id, did, can_send) VALUES (?, ?, ?)', [$id, $n['did'], $n['canSend'] ? 1 : 0]);
            }
        });
    }

    // ----------------------------------------------------------------- sessions

    public function createSession(string $id, ?int $userId, ?string $userAgent, int $now): void
    {
        $this->run('INSERT INTO sessions (id, user_id, created_at, last_seen_at, user_agent) VALUES (?, ?, ?, ?, ?)', [$id, $userId, $now, $now, $userAgent]);
    }

    public function getSession(string $id): ?array
    {
        return $this->one('SELECT * FROM sessions WHERE id = ?', [$id]);
    }

    public function touchSession(string $id, int $now): void
    {
        $this->run('UPDATE sessions SET last_seen_at = ? WHERE id = ?', [$now, $id]);
    }

    public function deleteSession(string $id): bool
    {
        return $this->run('DELETE FROM sessions WHERE id = ?', [$id])->rowCount() > 0;
    }

    /** Signs a user out everywhere but $exceptId (null user: the owner's sessions). */
    public function deleteUserSessions(?int $userId, ?string $exceptId = null): void
    {
        $this->run('DELETE FROM sessions WHERE user_id IS ? AND id IS NOT ?', [$userId, $exceptId]);
    }

    /** A user's sessions, the latest first (null: the owner's). */
    public function listSessions(?int $userId): array
    {
        return $this->all('SELECT * FROM sessions WHERE user_id IS ? ORDER BY last_seen_at DESC', [$userId]);
    }

    public function pruneSessions(int $createdBefore): void
    {
        $this->run('DELETE FROM sessions WHERE created_at < ?', [$createdBefore]);
    }

    // ----------------------------------------------------------------- accounts

    /** The account set up first: the only one of a 1.x install, and the one the setup wizard is about. */
    public const PRIMARY_ACCOUNT = 1;

    /**
     * The settings key of something each VoIP.ms account has (credentials,
     * sync state, webhook): the first account keeps the plain keys of 1.x
     * (server/db.ts).
     */
    public static function accountKey(int $accountId, string $key): string
    {
        return $accountId === self::PRIMARY_ACCOUNT ? $key : "account.$accountId.$key";
    }

    /**
     * A VoIP.ms message id as stored: those of the accounts after the first
     * carry the account ("2:1234"), so that two accounts' ids never clash.
     */
    public static function storedRemoteId(int $accountId, string $id): string
    {
        return $accountId === self::PRIMARY_ACCOUNT ? $id : "$accountId:$id";
    }

    /** The id VoIP.ms knows a stored message by. */
    public static function voipmsId(string $stored): string
    {
        $colon = strpos($stored, ':');
        return $colon === false ? $stored : substr($stored, $colon + 1);
    }

    /** @return list<array{id: int, label: ?string, numbers: int}> */
    public function listAccounts(): array
    {
        return $this->all(
            'SELECT a.id, a.label, (SELECT COUNT(*) FROM dids d WHERE d.account_id = a.id) AS numbers FROM voipms_accounts a ORDER BY a.id',
        );
    }

    public function createAccount(?string $label): int
    {
        $label = $label !== null && trim($label) !== '' ? trim($label) : null;
        $this->run('INSERT INTO voipms_accounts (label, created_at) VALUES (?, ?)', [$label, Time::nowMs()]);
        return (int) $this->db->lastInsertId();
    }

    public function updateAccount(int $id, ?string $label): bool
    {
        $label = $label !== null && trim($label) !== '' ? trim($label) : null;
        return $this->run('UPDATE voipms_accounts SET label = ? WHERE id = ?', [$label, $id])->rowCount() > 0;
    }

    /** The account a number belongs to, or null for a number not seen yet. */
    public function accountOfDid(string $did): ?int
    {
        $row = $this->one('SELECT account_id FROM dids WHERE did = ?', [$did]);
        return $row === null ? null : (int) $row['account_id'];
    }

    // --------------------------------------------------------------------- dids

    public function listDids(): array
    {
        [$scope, $scopeParams] = $this->didScope('d.did');
        $rows = $this->all(
            "SELECT d.*, (SELECT SUM(unread_count) FROM conversations c WHERE c.did = d.did AND c.archived_at IS NULL) AS unread
             FROM dids d WHERE $scope ORDER BY d.position, d.did",
            $scopeParams,
        );
        return array_map(static fn (array $r) => [
            'did' => $r['did'],
            'label' => $r['label'],
            'color' => $r['color'],
            'visible' => $r['visible'] === 1,
            'smsEnabled' => $r['sms_enabled'] === 1,
            'smsAvailable' => $r['sms_available'] === 1,
            'mmsAvailable' => $r['mms_available'] === 1,
            'description' => $r['description'],
            'position' => $r['position'],
            'unreadCount' => (int) ($r['unread'] ?? 0),
            'accountId' => (int) $r['account_id'],
        ], $rows);
    }

    public function getDid(string $did): ?array
    {
        foreach ($this->listDids() as $d) {
            if ($d['did'] === $did) {
                return $d;
            }
        }
        return null;
    }

    private function nextDidColor(): string
    {
        $used = array_column($this->all('SELECT color FROM dids'), 'color');
        foreach (self::DID_COLORS as $color) {
            if (!in_array($color, $used, true)) {
                return $color;
            }
        }
        return self::DID_COLORS[count($used) % count(self::DID_COLORS)];
    }

    /**
     * Inserts or refreshes a DID from VoIP.ms, keeping the user's label, color
     * and visibility; a number that just got SMS shows up, like a new one.
     */
    /** A number already known under another account stays with it (false). */
    public function upsertDid(array $info, int $accountId = self::PRIMARY_ACCOUNT): bool
    {
        $owner = $this->accountOfDid($info['did']);
        if ($owner !== null && $owner !== $accountId) {
            return false;
        }
        if ($owner !== null) {
            $this->run(
                'UPDATE dids SET visible = CASE WHEN sms_enabled = 0 AND ? = 1 THEN 1 ELSE visible END,
                   description = ?, sms_enabled = ?, sms_available = ?, mms_available = ? WHERE did = ?',
                [
                    $info['smsEnabled'] ? 1 : 0,
                    $info['description'],
                    $info['smsEnabled'] ? 1 : 0,
                    $info['smsAvailable'] ? 1 : 0,
                    $info['mmsAvailable'] ? 1 : 0,
                    $info['did'],
                ],
            );
            return true;
        }
        $position = (int) $this->run('SELECT COUNT(*) FROM dids')->fetchColumn();
        $this->run(
            'INSERT INTO dids (did, label, color, visible, sms_enabled, sms_available, mms_available, description, position, account_id)
             VALUES (?, NULL, ?, ?, ?, ?, ?, ?, ?, ?)',
            [
                $info['did'],
                $this->nextDidColor(),
                $info['smsEnabled'] ? 1 : 0,
                $info['smsEnabled'] ? 1 : 0,
                $info['smsAvailable'] ? 1 : 0,
                $info['mmsAvailable'] ? 1 : 0,
                $info['description'],
                $position,
                $accountId,
            ],
        );
        return true;
    }

    /** Makes sure a DID seen in message history exists locally. */
    public function ensureDid(string $did, int $accountId = self::PRIMARY_ACCOUNT): void
    {
        if (!$this->one('SELECT did FROM dids WHERE did = ?', [$did])) {
            $this->upsertDid(['did' => $did, 'description' => null, 'smsEnabled' => true, 'smsAvailable' => true, 'mmsAvailable' => true], $accountId);
        }
    }

    public function updateDid(string $did, array $patch): bool
    {
        if (!$this->allowsDid($did)) {
            return false;
        }
        $sets = [];
        $values = [];
        if (array_key_exists('label', $patch)) {
            $sets[] = 'label = ?';
            $label = $patch['label'] === null ? '' : trim($patch['label']);
            $values[] = $label !== '' ? $label : null;
        }
        if (array_key_exists('color', $patch)) {
            $sets[] = 'color = ?';
            $values[] = $patch['color'];
        }
        if (array_key_exists('visible', $patch)) {
            $sets[] = 'visible = ?';
            $values[] = $patch['visible'] ? 1 : 0;
        }
        if (array_key_exists('position', $patch)) {
            $sets[] = 'position = ?';
            $values[] = $patch['position'];
        }
        if (!$sets) {
            return $this->getDid($did) !== null;
        }
        $values[] = $did;
        return $this->run('UPDATE dids SET ' . implode(', ', $sets) . ' WHERE did = ?', $values)->rowCount() > 0;
    }

    // ------------------------------------------------------------ conversations

    public function getOrCreateConversation(string $did, string $phone): int
    {
        $id = $this->findConversation($did, $phone);
        if ($id !== null) {
            return $id;
        }
        $this->run('INSERT INTO conversations (did, phone) VALUES (?, ?)', [$did, $phone]);
        return (int) $this->db->lastInsertId();
    }

    public function findConversation(string $did, string $phone): ?int
    {
        $id = $this->run('SELECT id FROM conversations WHERE did = ? AND phone = ?', [$did, $phone])->fetchColumn();
        return $id === false ? null : (int) $id;
    }

    public function getConversation(int $id): ?array
    {
        [$scope, $scopeParams] = $this->didScope('c.did');
        $row = $this->one(self::CONVERSATION_SELECT . " WHERE c.id = ? AND $scope", [$id, ...$scopeParams]);
        return $row ? self::conversationDto($row) : null;
    }

    /**
     * Conversations with at least one message, newest first. Archived ones are
     * left out unless asked for; a search looks through both unless told otherwise.
     */
    public function listConversations(?string $did = null, ?string $query = null, ?bool $archived = null, int $limit = 500): array
    {
        [$scope, $params] = $this->didScope('c.did');
        $where = ['c.last_message_id IS NOT NULL', $scope];
        $q = trim($query ?? '');
        $archived ??= $q !== '' ? null : false;
        if ($archived !== null) {
            $where[] = $archived ? 'c.archived_at IS NOT NULL' : 'c.archived_at IS NULL';
        }
        if ($did) {
            $where[] = 'c.did = ?';
            $params[] = $did;
        } else {
            $where[] = 'c.did IN (SELECT did FROM dids WHERE visible = 1)';
        }
        if ($q !== '') {
            $like = '%' . addcslashes(Text::fold($q), '\\%_') . '%';
            $clauses = [
                "fold(ct.name) LIKE ? ESCAPE '\\'",
                "EXISTS (SELECT 1 FROM messages mm WHERE mm.conversation_id = c.id AND mm.search_text LIKE ? ESCAPE '\\')",
            ];
            array_push($params, $like, $like);
            // "+1 514..." must match the stored 10 digits.
            $digits = Phone::searchDigits($q);
            if (strlen($digits) >= 3) {
                $clauses[] = 'c.phone LIKE ?';
                $params[] = "%$digits%";
            }
            $where[] = '(' . implode(' OR ', $clauses) . ')';
        }
        $params[] = $limit;
        $rows = $this->all(
            self::CONVERSATION_SELECT . ' WHERE ' . implode(' AND ', $where) . ' ORDER BY c.last_message_at DESC, c.id DESC LIMIT ?',
            $params,
        );
        return array_map([self::class, 'conversationDto'], $rows);
    }

    /** Recomputes the conversation's last message and optionally bumps its unread counter. */
    public function touchConversation(int $conversationId, int $unreadDelta = 0): void
    {
        $last = $this->one(
            'SELECT id, sent_at FROM messages WHERE conversation_id = ? AND deleted_at IS NULL ORDER BY sent_at DESC, id DESC LIMIT 1',
            [$conversationId],
        );
        $this->run(
            'UPDATE conversations SET last_message_id = ?, last_message_at = ?, unread_count = unread_count + ? WHERE id = ?',
            [$last['id'] ?? null, $last['sent_at'] ?? null, $unreadDelta, $conversationId],
        );
    }

    /**
     * Deletes messages of a conversation (all of them when $ids is null),
     * except one still being sent. Those VoIP.ms knows stay as their id, text
     * and attachments gone, so that its history does not bring them back; the
     * others go entirely.
     *
     * @param list<int>|null $ids
     * @return array{ids: list<int>, files: list<string>} the deleted ids and the media files to remove
     */
    public function deleteMessages(int $conversationId, ?array $ids, bool $alsoAtVoipMs): array
    {
        return $this->transaction(function () use ($conversationId, $ids, $alsoAtVoipMs): array {
            $rows = array_values(array_filter(
                array_column($this->all("SELECT id FROM messages WHERE conversation_id = ? AND deleted_at IS NULL AND status != 'sending'", [$conversationId]), 'id'),
                static fn (int $id) => $ids === null || in_array($id, $ids, true),
            ));
            if (!$rows) {
                return ['ids' => [], 'files' => []];
            }
            $list = self::placeholders($rows);
            $files = array_column($this->all("SELECT file_name FROM attachments WHERE message_id IN ($list) AND file_name IS NOT NULL", $rows), 'file_name');
            $this->run("DELETE FROM attachments WHERE message_id IN ($list)", $rows);
            $this->run("DELETE FROM messages WHERE id IN ($list) AND remote_id IS NULL", $rows);
            $this->run(
                "UPDATE messages SET deleted_at = ?, delete_remote = ?, body = '', search_text = '' WHERE id IN ($list)",
                [Time::nowMs(), $alsoAtVoipMs ? 1 : 0, ...$rows],
            );
            $this->touchConversation($conversationId);
            if ($ids === null) {
                $this->run('UPDATE conversations SET unread_count = 0 WHERE id = ?', [$conversationId]);
            }
            return ['ids' => $rows, 'files' => $files];
        });
    }

    /** @return list<array{id: int, kind: string, remoteId: string}> deleted messages still to be deleted at VoIP.ms, oldest first */
    public function pendingRemoteDeletes(int $limit): array
    {
        return array_map(
            static fn (array $r) => ['id' => $r['id'], 'kind' => $r['kind'], 'remoteId' => (string) $r['remote_id'], 'did' => $r['did']],
            $this->all(
                'SELECT m.id, m.kind, m.remote_id, c.did FROM messages m JOIN conversations c ON c.id = m.conversation_id
                 WHERE m.delete_remote = 1 ORDER BY m.id LIMIT ?',
                [$limit],
            ),
        );
    }

    public function remoteDeleteDone(int $id): void
    {
        $this->run('UPDATE messages SET delete_remote = 0 WHERE id = ?', [$id]);
    }

    public function setArchived(int $id, bool $archived): bool
    {
        return $this->run(
            'UPDATE conversations SET archived_at = CASE WHEN ? THEN COALESCE(archived_at, ?) ELSE NULL END WHERE id = ?',
            [$archived ? 1 : 0, Time::nowMs(), $id],
        )->rowCount() > 0;
    }

    /** A new message brings an archived conversation back to the list. */
    public function unarchiveConversation(int $id): bool
    {
        return $this->run('UPDATE conversations SET archived_at = NULL WHERE id = ? AND archived_at IS NOT NULL', [$id])->rowCount() > 0;
    }

    public function markConversationRead(int $id): bool
    {
        return $this->run('UPDATE conversations SET unread_count = 0 WHERE id = ? AND unread_count > 0', [$id])->rowCount() > 0;
    }

    // ----------------------------------------------------------------- messages

    public function insertMessage(array $m): int
    {
        $this->run(
            'INSERT INTO messages (conversation_id, kind, remote_id, direction, body, search_text, sent_at, status, carrier_status, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
            [
                $m['conversationId'],
                $m['kind'],
                $m['remoteId'],
                $m['direction'],
                $m['body'],
                Text::fold($m['body']),
                $m['sentAt'],
                $m['status'],
                $m['carrierStatus'] ?? null,
                Time::nowMs(),
            ],
        );
        return (int) $this->db->lastInsertId();
    }

    /** @return array{id: int, carrierStatus: ?string, deleted: bool}|null */
    public function findMessageByRemote(string $kind, string $remoteId): ?array
    {
        $row = $this->one('SELECT id, carrier_status, deleted_at FROM messages WHERE kind = ? AND remote_id = ?', [$kind, $remoteId]);
        return $row ? ['id' => $row['id'], 'carrierStatus' => $row['carrier_status'], 'deleted' => $row['deleted_at'] !== null] : null;
    }

    public function updateMessage(int $id, array $patch): void
    {
        $columns = ['kind' => 'kind', 'remoteId' => 'remote_id', 'status' => 'status', 'error' => 'error', 'carrierStatus' => 'carrier_status', 'sentAt' => 'sent_at'];
        $sets = [];
        $values = [];
        foreach ($columns as $key => $column) {
            if (array_key_exists($key, $patch)) {
                $sets[] = "$column = ?";
                $values[] = $patch[$key];
            }
        }
        if ($sets) {
            $values[] = $id;
            $this->run('UPDATE messages SET ' . implode(', ', $sets) . ' WHERE id = ?', $values);
        }
    }

    public function getMessageRow(int $id): ?array
    {
        return $this->one('SELECT ' . self::MESSAGE_COLUMNS . ' FROM messages WHERE id = ? AND deleted_at IS NULL', [$id]);
    }

    public function getMessage(int $id): ?array
    {
        $row = $this->getMessageRow($id);
        return $row ? self::messageDto($row, $this->attachmentsFor([$row['id']])) : null;
    }

    /** Newest-last page of a conversation, optionally strictly older than message $beforeId. */
    public function listMessages(int $conversationId, ?int $beforeId = null, ?int $limit = null): array
    {
        $limit = min(max($limit ?? 50, 1), 200);
        $before = $beforeId ? $this->getMessageRow($beforeId) : null;
        if ($before) {
            $rows = $this->all(
                'SELECT ' . self::MESSAGE_COLUMNS . ' FROM messages
                 WHERE conversation_id = ? AND deleted_at IS NULL AND (sent_at < ? OR (sent_at = ? AND id < ?))
                 ORDER BY sent_at DESC, id DESC LIMIT ?',
                [$conversationId, $before['sent_at'], $before['sent_at'], $before['id'], $limit],
            );
        } else {
            $rows = $this->all(
                'SELECT ' . self::MESSAGE_COLUMNS . ' FROM messages WHERE conversation_id = ? AND deleted_at IS NULL ORDER BY sent_at DESC, id DESC LIMIT ?',
                [$conversationId, $limit],
            );
        }
        $rows = array_reverse($rows);
        $attachments = $this->attachmentsFor(array_column($rows, 'id'));
        return array_map(static fn (array $r) => self::messageDto($r, $attachments), $rows);
    }

    /** @return array<int, list<array>> */
    private function attachmentsFor(array $messageIds): array
    {
        if (!$messageIds) {
            return [];
        }
        $map = [];
        $rows = $this->all(
            'SELECT * FROM attachments WHERE message_id IN (' . self::placeholders($messageIds) . ') ORDER BY message_id, position',
            array_values($messageIds),
        );
        foreach ($rows as $r) {
            $map[$r['message_id']][] = $r;
        }
        return $map;
    }

    private static function messageDto(array $row, array $attachments): array
    {
        return [
            'id' => $row['id'],
            'conversationId' => $row['conversation_id'],
            'kind' => $row['kind'],
            'direction' => $row['direction'],
            'body' => $row['body'],
            'sentAt' => $row['sent_at'],
            'status' => $row['status'],
            'error' => $row['error'],
            'carrierStatus' => $row['carrier_status'],
            'attachments' => array_map([self::class, 'attachmentDto'], $attachments[$row['id']] ?? []),
        ];
    }

    // -------------------------------------------------------------- attachments

    public function insertAttachment(int $messageId, int $position, array $a): int
    {
        $this->run(
            'INSERT INTO attachments (message_id, position, remote_url, file_name, mime, size, status) VALUES (?, ?, ?, ?, ?, ?, ?)',
            [$messageId, $position, $a['remoteUrl'] ?? null, $a['fileName'] ?? null, $a['mime'] ?? null, $a['size'] ?? null, $a['status']],
        );
        return (int) $this->db->lastInsertId();
    }

    public function getAttachment(int $id): ?array
    {
        return $this->one('SELECT * FROM attachments WHERE id = ?', [$id]);
    }

    public function listAttachments(int $messageId): array
    {
        return $this->all('SELECT * FROM attachments WHERE message_id = ? ORDER BY position', [$messageId]);
    }

    /** Pending downloads that are due. */
    public function pendingAttachments(int $now, int $afterId = 0, int $limit = 20): array
    {
        return $this->all(
            "SELECT * FROM attachments WHERE status = 'pending' AND next_attempt_at <= ? AND id > ? ORDER BY id LIMIT ?",
            [$now, $afterId, $limit],
        );
    }

    /** Puts a failed download back in the queue. */
    public function resetAttachment(int $id): bool
    {
        return $this->run(
            "UPDATE attachments SET status = 'pending', attempts = 0, next_attempt_at = 0 WHERE id = ? AND status = 'failed'",
            [$id],
        )->rowCount() > 0;
    }

    /**
     * Sends whose request died before finishing (PHP killed it, the host
     * restarted) can neither finish nor be retried while "sending".
     *
     * @return list<int> the ids of the messages marked failed
     */
    public function failStaleSends(int $startedBefore): array
    {
        $ids = array_column($this->all("SELECT id FROM messages WHERE status = 'sending' AND created_at < ?", [$startedBefore]), 'id');
        if ($ids) {
            $this->run("UPDATE messages SET status = 'failed', error = 'interrupted' WHERE id IN (" . self::placeholders($ids) . ')', $ids);
        }
        return $ids;
    }

    public function updateAttachment(int $id, array $patch): void
    {
        $columns = ['fileName' => 'file_name', 'mime' => 'mime', 'size' => 'size', 'status' => 'status', 'attempts' => 'attempts', 'nextAttemptAt' => 'next_attempt_at'];
        $sets = [];
        $values = [];
        foreach ($columns as $key => $column) {
            if (array_key_exists($key, $patch)) {
                $sets[] = "$column = ?";
                $values[] = $patch[$key];
            }
        }
        if ($sets) {
            $values[] = $id;
            $this->run('UPDATE attachments SET ' . implode(', ', $sets) . ' WHERE id = ?', $values);
        }
    }

    // ----------------------------------------------------------------- contacts

    public function listContacts(): array
    {
        $contacts = $this->all('SELECT id, name, color, icon, notes FROM contacts ORDER BY name COLLATE NOCASE');
        $byContact = [];
        foreach ($this->all('SELECT phone, contact_id FROM contact_phones ORDER BY rowid') as $p) {
            $byContact[$p['contact_id']][] = $p['phone'];
        }
        return array_map(static fn (array $c) => $c + ['phones' => $byContact[$c['id']] ?? []], $contacts);
    }

    public function getContact(int $id): ?array
    {
        foreach ($this->listContacts() as $c) {
            if ($c['id'] === $id) {
                return $c;
            }
        }
        return null;
    }

    /** Phones already attached to another contact than $exceptId. */
    public function conflictingPhones(array $phones, ?int $exceptId): array
    {
        if (!$phones) {
            return [];
        }
        $rows = $this->all('SELECT phone, contact_id FROM contact_phones WHERE phone IN (' . self::placeholders($phones) . ')', array_values($phones));
        return array_values(array_map(
            static fn (array $r) => $r['phone'],
            array_filter($rows, static fn (array $r) => $r['contact_id'] !== $exceptId),
        ));
    }

    public function saveContact(?int $id, string $name, ?string $notes, array $phones, ?string $color = null, ?string $icon = null): int
    {
        return $this->transaction(function () use ($id, $name, $notes, $phones, $color, $icon): int {
            $now = Time::nowMs();
            if ($id) {
                $this->run(
                    'UPDATE contacts SET name = ?, color = ?, icon = ?, notes = ?, updated_at = ? WHERE id = ?',
                    [$name, $color, $icon, $notes, $now, $id],
                );
                $this->run('DELETE FROM contact_phones WHERE contact_id = ?', [$id]);
            } else {
                $this->run(
                    'INSERT INTO contacts (name, color, icon, notes, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
                    [$name, $color, $icon, $notes, $now, $now],
                );
                $id = (int) $this->db->lastInsertId();
            }
            $phones = array_values(array_unique($phones));
            $previousOwners = $phones
                ? array_unique(array_column($this->all('SELECT contact_id FROM contact_phones WHERE phone IN (' . self::placeholders($phones) . ')', $phones), 'contact_id'))
                : [];
            foreach ($phones as $phone) {
                $this->run(
                    'INSERT INTO contact_phones (phone, contact_id) VALUES (?, ?) ON CONFLICT(phone) DO UPDATE SET contact_id = excluded.contact_id',
                    [$phone, $id],
                );
            }
            // A contact whose only numbers were just moved here has nothing left to identify it.
            foreach ($previousOwners as $owner) {
                if ($owner !== $id && !$this->one('SELECT 1 FROM contact_phones WHERE contact_id = ? LIMIT 1', [$owner])) {
                    $this->run('DELETE FROM contacts WHERE id = ?', [$owner]);
                }
            }
            return $id;
        });
    }

    public function deleteContact(int $id): bool
    {
        return $this->run('DELETE FROM contacts WHERE id = ?', [$id])->rowCount() > 0;
    }

    /** Deletes the contacts that still exist among $ids; returns how many there were. */
    public function deleteContacts(array $ids): int
    {
        return $this->transaction(function () use ($ids): int {
            $deleted = 0;
            // In slices: the SQLite of older hosts takes at most 999 parameters.
            foreach (array_chunk($ids, 500) as $slice) {
                $deleted += $this->run('DELETE FROM contacts WHERE id IN (' . self::placeholders($slice) . ')', $slice)->rowCount();
            }
            return $deleted;
        });
    }

    // ------------------------------------------------------- push subscriptions

    public function listPushSubscriptions(): array
    {
        return $this->all('SELECT endpoint, p256dh, auth, device, lang FROM push_subscriptions');
    }

    public function getPushSubscription(string $endpoint): ?array
    {
        return $this->one('SELECT endpoint, p256dh, auth, device, lang FROM push_subscriptions WHERE endpoint = ?', [$endpoint]);
    }

    public function savePushSubscription(array $sub): void
    {
        $now = Time::nowMs();
        $this->run(
            'INSERT INTO push_subscriptions (endpoint, p256dh, auth, device, lang, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(endpoint) DO UPDATE SET p256dh = excluded.p256dh, auth = excluded.auth,
               device = excluded.device, lang = excluded.lang, updated_at = excluded.updated_at',
            [$sub['endpoint'], $sub['p256dh'], $sub['auth'], $sub['device'], $sub['lang'], $now, $now],
        );
    }

    public function deletePushSubscription(string $endpoint): bool
    {
        return $this->run('DELETE FROM push_subscriptions WHERE endpoint = ?', [$endpoint])->rowCount() > 0;
    }

    public function deleteAllPushSubscriptions(): int
    {
        return $this->run('DELETE FROM push_subscriptions')->rowCount();
    }

    // ------------------------------------------------------------------ shapes

    private static function conversationDto(array $row): array
    {
        return [
            'id' => $row['id'],
            'did' => $row['did'],
            'phone' => $row['phone'],
            'contact' => $row['contact_id'] !== null
                ? ['id' => $row['contact_id'], 'name' => $row['contact_name'] ?? '', 'color' => $row['contact_color'], 'icon' => $row['contact_icon']]
                : null,
            'unreadCount' => $row['unread_count'],
            'archived' => $row['archived_at'] !== null,
            'lastMessageAt' => $row['last_message_at'],
            'lastMessage' => $row['last_message_id'] !== null && $row['last_direction'] !== null
                ? [
                    'body' => $row['last_body'] ?? '',
                    'direction' => $row['last_direction'],
                    'status' => $row['last_status'] ?? 'sent',
                    'attachmentCount' => $row['last_attachments'] ?? 0,
                ]
                : null,
        ];
    }

    public static function attachmentDto(array $row): array
    {
        return [
            'id' => $row['id'],
            'mime' => $row['mime'],
            'size' => $row['size'],
            'status' => $row['status'],
            'url' => $row['status'] === 'ready' && $row['file_name'] ? '/api/media/' . $row['id'] : null,
        ];
    }
}
