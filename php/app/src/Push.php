<?php

declare(strict_types=1);

namespace SmsPortal;

/**
 * Web Push notifications for new incoming texts, to the browsers that asked
 * for them, skipping those where the app is on screen.
 */
final class Push
{
    private const VAPID_KEY = 'push.vapid';
    private const OWNER_KEY = 'push.owner';
    /** Keeps the encrypted payload well under the 4 KB push services accept. */
    private const BODY_MAX_CHARS = 240;

    private const TEXT = [
        'fr' => [
            'attachment' => '📎 Pièce jointe',
            'attachments' => '📎 %d pièces jointes',
            'testTitle' => 'Notifications activées',
            'testBody' => 'Les nouveaux textos s’afficheront ici, même quand l’application est fermée.',
        ],
        'en' => [
            'attachment' => '📎 Attachment',
            'attachments' => '📎 %d attachments',
            'testTitle' => 'Notifications are on',
            'testBody' => 'New texts will show up here, even when the app is closed.',
        ],
    ];

    private ?array $vapid = null;
    private bool $ownerChecked = false;

    /**
     * @param \Closure(): string $ownerFingerprint changes with APP_PASSWORD (slow to compute: only asked when needed)
     * @param ?\Closure(): string $legacyOwnerFingerprint the same, as the Node server of 1.x computed it
     */
    public function __construct(
        private readonly Repo $repo,
        private readonly Events $events,
        private readonly string $subject,
        private readonly \Closure $ownerFingerprint,
        private readonly ?\Closure $legacyOwnerFingerprint = null,
    ) {
    }

    /** @return array{publicKey: string, privateKey: string} */
    private function vapid(): array
    {
        if ($this->vapid === null) {
            $stored = $this->repo->getSetting(self::VAPID_KEY);
            $this->vapid = $stored !== null ? json_decode($stored, true) : null;
            if (!is_array($this->vapid)) {
                $this->vapid = WebPush::generateVapidKeys();
                $this->repo->setSetting(self::VAPID_KEY, json_encode($this->vapid));
            }
        }
        return $this->vapid;
    }

    public function publicKey(): string
    {
        return $this->vapid()['publicKey'];
    }

    /** Notifications show message previews: a new APP_PASSWORD revokes every browser, like sessions. */
    public function checkOwner(): void
    {
        if ($this->ownerChecked) {
            return;
        }
        $this->ownerChecked = true;
        $owner = ($this->ownerFingerprint)();
        $stored = $this->repo->getSetting(self::OWNER_KEY);
        if ($stored !== $owner) {
            // A Docker install from before 2.0 computed it another way: the same APP_PASSWORD keeps its browsers.
            $sameOwner = $stored !== null && $this->legacyOwnerFingerprint !== null && $stored === ($this->legacyOwnerFingerprint)();
            $dropped = $sameOwner ? 0 : $this->repo->deleteAllPushSubscriptions();
            if ($dropped) {
                Log::info('APP_PASSWORD changed: push subscriptions removed', ['count' => $dropped]);
            }
            $this->repo->setSetting(self::OWNER_KEY, $owner);
        }
    }

    /**
     * New texts from a check, grouped into one notification per conversation.
     *
     * @param list<array{messageId: int, conversationId: int}> $items
     */
    public function notifyIncoming(array $items): void
    {
        $this->checkOwner();
        $subscriptions = $this->repo->listPushSubscriptions();
        if (!$subscriptions) {
            return;
        }
        // VoIP.ms lists newest first: the last one stored is not necessarily the latest.
        $latest = [];
        foreach ($items as ['messageId' => $messageId, 'conversationId' => $conversationId]) {
            $sentAt = $this->repo->getMessageRow($messageId)['sent_at'] ?? 0;
            $entry = $latest[$conversationId] ?? null;
            $newer = $entry === null || $sentAt > $entry['sentAt'] || ($sentAt === $entry['sentAt'] && $messageId > $entry['messageId']);
            $latest[$conversationId] = [
                'messageId' => $newer ? $messageId : $entry['messageId'],
                'sentAt' => $newer ? $sentAt : $entry['sentAt'],
                'count' => ($entry['count'] ?? 0) + 1,
            ];
        }
        $dids = array_values(array_filter($this->repo->listDids(), static fn (array $d) => $d['visible']));
        $multi = count($dids) > 1;
        // Archived conversations are already left out of these counts.
        $unread = array_sum(array_column($dids, 'unreadCount'));
        foreach ($latest as $conversationId => ['messageId' => $messageId, 'count' => $count]) {
            $message = $this->repo->getMessage($messageId);
            $conversation = $this->repo->getConversation($conversationId);
            if (!$message || !$conversation) {
                continue;
            }
            $did = null;
            foreach ($dids as $d) {
                if ($d['did'] === $conversation['did']) {
                    $did = $d;
                }
            }
            if ($did === null) {
                // Hidden number.
                continue;
            }
            $didLabel = $multi ? ($did['label'] ?: Phone::format($conversation['did'])) : null;
            foreach ($subscriptions as $sub) {
                if ($sub['device'] && $this->events->isOnScreen($sub['device'])) {
                    continue;
                }
                $payload = self::messagePayload($message, $conversation, $count, $didLabel, self::lang($sub['lang'])) + ['unread' => $unread];
                $this->deliver($sub, $payload, "c$conversationId");
            }
        }
    }

    /** Sends a sample notification to one browser; returns the push service's status. */
    public function sendTest(string $endpoint): ?int
    {
        $sub = $this->repo->getPushSubscription($endpoint);
        if (!$sub) {
            return null;
        }
        $text = self::TEXT[self::lang($sub['lang'])];
        return $this->deliver($sub, ['title' => $text['testTitle'], 'body' => $text['testBody'], 'tag' => 'test', 'url' => '/settings']);
    }

    /** Forgets browsers that unsubscribed; returns the push service's status. */
    private function deliver(array $sub, array $payload, ?string $topic = null): int
    {
        try {
            $json = json_encode($payload, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_INVALID_UTF8_SUBSTITUTE);
            $status = WebPush::send($sub, $json, $this->vapid(), $this->subject, 'high', $topic);
        } catch (\Throwable $e) {
            Log::warn('Push notification failed', ['err' => $e]);
            return 0;
        }
        if ($status === 404 || $status === 410) {
            // The browser dropped the subscription (permission revoked, data cleared...).
            $this->repo->deletePushSubscription($sub['endpoint']);
            Log::info('Push subscription expired and was removed', ['status' => $status]);
        } elseif ($status >= 300 || $status === 0) {
            Log::warn('Push service refused a notification', ['status' => $status, 'host' => parse_url($sub['endpoint'], PHP_URL_HOST)]);
        }
        return $status;
    }

    private static function lang(string $value): string
    {
        return $value === 'en' ? 'en' : 'fr';
    }

    public static function messagePayload(array $message, array $conversation, int $count, ?string $didLabel, string $lang): array
    {
        $text = self::TEXT[$lang];
        $name = ($conversation['contact']['name'] ?? '') ?: Phone::format($conversation['phone']);
        $attachments = count($message['attachments']);
        $body = trim($message['body']);
        if (mb_strlen($body, 'UTF-8') > self::BODY_MAX_CHARS) {
            $body = mb_substr($body, 0, self::BODY_MAX_CHARS, 'UTF-8') . '…';
        }
        if ($body === '' && $attachments) {
            $body = $attachments > 1 ? sprintf($text['attachments'], $attachments) : $text['attachment'];
        }
        if ($didLabel !== null) {
            $body .= "\n— $didLabel";
        }
        return [
            'title' => $count > 1 ? "$name ($count)" : $name,
            'body' => $body,
            'tag' => 'conversation-' . $conversation['id'],
            'url' => '/c/' . $conversation['id'],
            'timestamp' => $message['sentAt'],
        ];
    }
}
