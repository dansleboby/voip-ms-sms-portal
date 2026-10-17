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
    public function upsertDid(array $info): void
    {
        if ($this->one('SELECT did FROM dids WHERE did = ?', [$info['did']])) {
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
            return;
        }
        $position = (int) $this->run('SELECT COUNT(*) FROM dids')->fetchColumn();
        $this->run(
            'INSERT INTO dids (did, label, color, visible, sms_enabled, sms_available, mms_available, description, position)
             VALUES (?, NULL, ?, ?, ?, ?, ?, ?, ?)',
            [
                $info['did'],
                $this->nextDidColor(),
                $info['smsEnabled'] ? 1 : 0,
                $info['smsEnabled'] ? 1 : 0,
                $info['smsAvailable'] ? 1 : 0,
                $info['mmsAvailable'] ? 1 : 0,
                $info['description'],
                $position,
            ],
        );
    }

    /** Makes sure a DID seen in message history exists locally. */
    public function ensureDid(string $did): void
    {
        if (!$this->one('SELECT did FROM dids WHERE did = ?', [$did])) {
            $this->upsertDid(['did' => $did, 'description' => null, 'smsEnabled' => true, 'smsAvailable' => true, 'mmsAvailable' => true]);
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
        $last = $this->one('SELECT id, sent_at FROM messages WHERE conversation_id = ? ORDER BY sent_at DESC, id DESC LIMIT 1', [$conversationId]);
        $this->run(
            'UPDATE conversations SET last_message_id = ?, last_message_at = ?, unread_count = unread_count + ? WHERE id = ?',
            [$last['id'] ?? null, $last['sent_at'] ?? null, $unreadDelta, $conversationId],
        );
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

    /** @return array{id: int, carrierStatus: ?string}|null */
    public function findMessageByRemote(string $kind, string $remoteId): ?array
    {
        $row = $this->one('SELECT id, carrier_status FROM messages WHERE kind = ? AND remote_id = ?', [$kind, $remoteId]);
        return $row ? ['id' => $row['id'], 'carrierStatus' => $row['carrier_status']] : null;
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
        return $this->one('SELECT ' . self::MESSAGE_COLUMNS . ' FROM messages WHERE id = ?', [$id]);
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
                'SELECT ' . self::MESSAGE_COLUMNS . ' FROM messages WHERE conversation_id = ? AND (sent_at < ? OR (sent_at = ? AND id < ?))
                 ORDER BY sent_at DESC, id DESC LIMIT ?',
                [$conversationId, $before['sent_at'], $before['sent_at'], $before['id'], $limit],
            );
        } else {
            $rows = $this->all(
                'SELECT ' . self::MESSAGE_COLUMNS . ' FROM messages WHERE conversation_id = ? ORDER BY sent_at DESC, id DESC LIMIT ?',
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
