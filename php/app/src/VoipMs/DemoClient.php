<?php

declare(strict_types=1);

namespace SmsPortal\VoipMs;

use PDO;
use SmsPortal\Db;
use SmsPortal\Time;

/**
 * Stand-in for a VoIP.ms account (DEMO_MODE): the sample numbers,
 * conversations and auto-reply of server/voipms/demo.ts. Every PHP request
 * starts afresh, so the account lives in its own table, and the auto-reply
 * is a message dated 4 s in the future that stays hidden until then.
 */
final class DemoClient implements VoipMsApi
{
    private const HOUR = 3_600_000;
    private const MIN = 60_000;
    private const FIRST_ID = ['sms' => 900000, 'mms' => 50000];
    private const REPLY = 'Bien reçu 👍 (réponse automatique de la démo)';

    public const DIDS = [
        ['did' => '5145550100', 'description' => 'Montréal, QC', 'smsAvailable' => true, 'smsEnabled' => true, 'mmsAvailable' => true],
        ['did' => '4505550199', 'description' => 'Laval, QC', 'smsAvailable' => true, 'smsEnabled' => true, 'mmsAvailable' => true],
        ['did' => '8195550123', 'description' => 'Gatineau, QC', 'smsAvailable' => true, 'smsEnabled' => false, 'mmsAvailable' => false],
    ];

    /** Contacts created locally in demo mode so names show up. */
    public const CONTACTS = [
        ['name' => 'Marie Tremblay', 'phones' => ['4385550142']],
        ['name' => 'Alex Martin', 'phones' => ['5145550187']],
        ['name' => 'Garage Bélanger', 'phones' => ['4505550111'], 'icon' => 'car'],
    ];

    public function __construct(private readonly PDO $db, private readonly string $timeZone)
    {
        $db->exec(
            'CREATE TABLE IF NOT EXISTS demo_messages (
               id INTEGER PRIMARY KEY, kind TEXT NOT NULL, remote_id TEXT NOT NULL, at INTEGER NOT NULL, direction TEXT NOT NULL,
               did TEXT NOT NULL, contact TEXT NOT NULL, body TEXT NOT NULL, carrier_status TEXT, media TEXT NOT NULL
             )',
        );
        if ($db->query('SELECT COUNT(*) FROM demo_messages')->fetchColumn() == 0) {
            $this->exclusive(function (): void {
                if ($this->db->query('SELECT COUNT(*) FROM demo_messages')->fetchColumn() == 0) {
                    $this->seed();
                }
            });
        }
    }

    /** Requests run side by side: ids are counted under the write lock. */
    private function exclusive(callable $fn): mixed
    {
        $this->db->exec('BEGIN IMMEDIATE');
        try {
            $result = $fn();
            $this->db->exec('COMMIT');
            return $result;
        } catch (\Throwable $e) {
            $this->db->exec('ROLLBACK');
            throw $e;
        }
    }

    private function seed(): void
    {
        $day = Time::DAY_MS;
        $seeds = [
            [3 * $day + 2 * self::HOUR, '5145550100', '4385550142', 'in', 'Salut! Tu viens toujours au chalet en fin de semaine?'],
            [3 * $day + 1 * self::HOUR, '5145550100', '4385550142', 'out', 'Oui! On arrive samedi vers 10 h.'],
            [3 * $day + 50 * self::MIN, '5145550100', '4385550142', 'in', 'Parfait 😊 Apporte tes bottes, il a plu.'],
            [2 * self::HOUR, '5145550100', '4385550142', 'in', 'Regarde la vue ce matin!', [self::photo()]],
            [1 * self::HOUR + 55 * self::MIN, '5145550100', '4385550142', 'out', 'Wow, magnifique 😍'],
            [26 * self::HOUR, '4505550199', '4505550111', 'in', 'Bonjour, votre véhicule est prêt. Vous pouvez passer le récupérer avant 17 h.'],
            [25 * self::HOUR, '4505550199', '4505550111', 'out', 'Merci, je passe vers 16 h 30.'],
            [5 * $day, '5145550100', '5145550187', 'out', 'Hey Alex, are we still on for Thursday?'],
            [5 * $day - 20 * self::MIN, '5145550100', '5145550187', 'in', 'Yes! 7pm at the usual place.'],
            [12 * self::MIN, '5145550100', '5145550187', 'in', 'Running 10 min late, sorry!'],
            [40 * self::MIN, '4505550199', '32665', 'in', 'Votre code de vérification est 482913. Ne le partagez avec personne.'],
        ];
        $now = Time::nowMs();
        foreach ($seeds as $s) {
            $media = $s[5] ?? [];
            $this->add($media ? 'mms' : 'sms', $s[1], $s[2], $s[3], $s[4], $media, $now - $s[0]);
        }
    }

    private function add(string $kind, string $did, string $contact, string $direction, string $body, array $media, int $at): string
    {
        $count = (int) $this->db->query('SELECT COUNT(*) FROM demo_messages WHERE kind = ' . $this->db->quote($kind))->fetchColumn();
        $id = (string) (self::FIRST_ID[$kind] + $count);
        Db::run(
            $this->db,
            'INSERT INTO demo_messages (kind, remote_id, at, direction, did, contact, body, carrier_status, media) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
            [$kind, $id, $at, $direction, $did, $contact, $body, $direction === 'out' ? 'Delivered' : null, json_encode($media)],
        );
        return $id;
    }

    public function getIP(): string
    {
        return '203.0.113.10';
    }

    public function getBalance(): float
    {
        return 42.5;
    }

    /** Numbers the demo turned SMS on for, kept between requests. */
    private const ENABLED_KEY = 'demo.smsEnabled';
    /** Each number's URL callback, once the portal changed one, kept between requests. */
    private const CALLBACKS_KEY = 'demo.callbacks';
    /** Laval already sends its texts to another system, as numbers wired to a CRM do (server/voipms/demo.ts). */
    private const OTHER_CALLBACK = 'https://crm.example.com/sms?from={FROM}&message={MESSAGE}';

    public function getDids(): array
    {
        $enabled = $this->enabledByDemo();
        $callbacks = $this->callbacks();
        return array_map(
            static fn (array $d) => ['callback' => $callbacks[$d['did']] ?? null]
                + (in_array($d['did'], $enabled, true) ? ['smsEnabled' => true, 'mmsAvailable' => true] + $d : $d),
            self::DIDS,
        );
    }

    public function setCallback(string $did, ?array $callback): void
    {
        $info = null;
        foreach ($this->getDids() as $d) {
            if ($d['did'] === $did) {
                $info = $d;
            }
        }
        if ($info === null) {
            throw new VoipMsError('invalid_did');
        }
        if (!$info['smsEnabled']) {
            throw new VoipMsError('sms_disabled');
        }
        $this->storeCallback($did, $callback);
    }

    /** @return array<string, ?array{url: string, retry: bool}> */
    private function callbacks(): array
    {
        $stored = Db::run($this->db, 'SELECT value FROM settings WHERE key = ?', [self::CALLBACKS_KEY])->fetchColumn();
        return $stored === false ? ['4505550199' => ['url' => self::OTHER_CALLBACK, 'retry' => false]] : json_decode($stored, true);
    }

    private function storeCallback(string $did, ?array $callback): void
    {
        $callbacks = $this->callbacks();
        $callbacks[$did] = $callback === null ? null : ['url' => $callback['url'], 'retry' => (bool) $callback['retry']];
        Db::run(
            $this->db,
            'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
            [self::CALLBACKS_KEY, json_encode($callbacks)],
        );
    }

    public function deleteMessage(string $kind, string $id): void
    {
        if (Db::run($this->db, 'DELETE FROM demo_messages WHERE kind = ? AND remote_id = ?', [$kind, $id])->rowCount() === 0) {
            throw new VoipMsError($kind === 'sms' ? 'invalid_sms' : 'invalid_mms');
        }
    }

    public function enableSms(string $did, ?array $callback = null): void
    {
        if (!(array_column(self::DIDS, 'smsAvailable', 'did')[$did] ?? false)) {
            throw new VoipMsError('invalid_did');
        }
        if ($callback !== null) {
            $this->storeCallback($did, $callback);
        }
        Db::run(
            $this->db,
            'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
            [self::ENABLED_KEY, json_encode(array_values(array_unique([...$this->enabledByDemo(), $did])))],
        );
    }

    /** @return list<string> */
    private function enabledByDemo(): array
    {
        $stored = Db::run($this->db, 'SELECT value FROM settings WHERE key = ?', [self::ENABLED_KEY])->fetchColumn();
        return $stored === false ? [] : json_decode($stored, true);
    }

    public function getMessages(string $kind, string $from, string $to, int $limit): array
    {
        $messages = [];
        foreach (Db::run($this->db, 'SELECT * FROM demo_messages WHERE kind = ? AND at <= ? ORDER BY id', [$kind, Time::nowMs()])->fetchAll() as $m) {
            $date = Time::epochToZonedDate($m['at'], $this->timeZone);
            if ($date < $from || $date > $to) {
                continue;
            }
            $messages[] = [
                'kind' => $m['kind'],
                'id' => $m['remote_id'],
                'date' => Time::epochToZonedDateTime($m['at'], $this->timeZone),
                'direction' => $m['direction'],
                'did' => $m['did'],
                'contact' => $m['contact'],
                'body' => $m['body'],
                'carrierStatus' => $m['carrier_status'],
                'media' => json_decode($m['media'], true),
            ];
        }
        return array_slice($messages, -$limit);
    }

    private function check(string $did): void
    {
        foreach ($this->getDids() as $info) {
            if ($info['did'] === $did && $info['smsEnabled']) {
                return;
            }
        }
        throw new VoipMsError('invalid_did');
    }

    public function sendSms(string $did, string $dst, string $message): string
    {
        $this->check($did);
        if (strlen($message) > 160) {
            throw new VoipMsError('sms_toolong');
        }
        return $this->sendWithReply('sms', $did, $dst, $message, []);
    }

    public function sendMms(string $did, string $dst, string $message, array $media): string
    {
        $this->check($did);
        return $this->sendWithReply('mms', $did, $dst, $message, $media);
    }

    private function sendWithReply(string $kind, string $did, string $dst, string $message, array $media): string
    {
        return $this->exclusive(function () use ($kind, $did, $dst, $message, $media): string {
            $now = Time::nowMs();
            $id = $this->add($kind, $did, $dst, 'out', $message, $media, $now);
            $this->add('sms', $did, $dst, 'in', self::REPLY, [], $now + 4000);
            return $id;
        });
    }

    private static function photo(): string
    {
        $svg = <<<'SVG'
            <svg xmlns="http://www.w3.org/2000/svg" width="640" height="420" viewBox="0 0 640 420">
              <defs>
                <linearGradient id="sky" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#f6b26b"/><stop offset="1" stop-color="#fbe3c0"/></linearGradient>
                <linearGradient id="lake" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#4f7cac"/><stop offset="1" stop-color="#2d4b6e"/></linearGradient>
              </defs>
              <rect width="640" height="420" fill="url(#sky)"/>
              <circle cx="470" cy="150" r="46" fill="#fff4dc"/>
              <path d="M0 260 L120 150 L210 230 L320 120 L450 250 L540 180 L640 250 L640 300 L0 300Z" fill="#5b6f5a"/>
              <path d="M0 280 L90 220 L190 270 L300 200 L420 280 L640 240 L640 310 L0 310Z" fill="#3e523f"/>
              <rect y="300" width="640" height="120" fill="url(#lake)"/>
              <rect x="380" y="330" width="120" height="6" rx="3" fill="#fbe3c0" opacity=".6"/>
              <rect x="410" y="350" width="70" height="5" rx="2.5" fill="#fbe3c0" opacity=".4"/>
            </svg>
            SVG;
        return 'data:image/svg+xml;base64,' . base64_encode($svg);
    }
}
