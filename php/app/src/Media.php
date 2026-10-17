<?php

declare(strict_types=1);

namespace SmsPortal;

/**
 * Attachment files under DATA_DIR/media, and the downloads of received ones
 * (server/media.ts). VoIP.ms media links are public and can answer 404 for
 * a while after a message is sent, so downloads keep trying for about 6
 * hours, in short batches run by polls and the cron job.
 */
final class Media
{
    private const EXTENSIONS = [
        'image/jpeg' => 'jpg', 'image/png' => 'png', 'image/gif' => 'gif', 'image/webp' => 'webp', 'image/heic' => 'heic',
        'image/heif' => 'heif', 'image/bmp' => 'bmp', 'image/svg+xml' => 'svg', 'video/mp4' => 'mp4', 'video/3gpp' => '3gp',
        'video/quicktime' => 'mov', 'video/webm' => 'webm', 'audio/mpeg' => 'mp3', 'audio/mp4' => 'm4a', 'audio/aac' => 'aac',
        'audio/amr' => 'amr', 'audio/ogg' => 'ogg', 'audio/wav' => 'wav', 'text/vcard' => 'vcf', 'text/x-vcard' => 'vcf',
        'text/plain' => 'txt', 'application/pdf' => 'pdf',
    ];
    /** Types a browser may show inline from this origin without any risk of running script. */
    private const INLINE_SAFE = '~^(image/(jpeg|png|gif|webp|bmp|heic|heif|avif)|video/[\w.+-]+|audio/[\w.+-]+)$~';
    private const MAX_DOWNLOAD_BYTES = 25 * 1024 * 1024;
    public const MAX_DOWNLOAD_ATTEMPTS = 10;
    private const RETRY_BASE_MS = 30_000;
    private const RETRY_MAX_MS = 2 * 3_600_000;

    public function __construct(
        private readonly string $dir,
        private readonly string $lockDir,
        private readonly Repo $repo,
        private readonly Events $events,
    ) {
    }

    public static function isInlineSafe(?string $mime): bool
    {
        return $mime !== null && preg_match(self::INLINE_SAFE, $mime) === 1;
    }

    public function filePath(string $fileName): string
    {
        if ($fileName !== basename($fileName)) {
            throw new \InvalidArgumentException('Invalid media file name');
        }
        return $this->dir . '/' . $fileName;
    }

    /** @return array{fileName: string, size: int, mime: string} */
    public function save(string $bytes, ?string $mime): array
    {
        if (!is_dir($this->dir)) {
            mkdir($this->dir, 0700, true);
        }
        $type = $mime ?? 'application/octet-stream';
        $fileName = self::uuid() . '.' . (self::EXTENSIONS[$type] ?? 'bin');
        if (file_put_contents($this->filePath($fileName), $bytes) === false) {
            throw new \RuntimeException('Cannot write the media file');
        }
        return ['fileName' => $fileName, 'size' => strlen($bytes), 'mime' => $type];
    }

    /** The format sendMMS accepts for inline media. */
    public function toDataUri(array $row): string
    {
        $data = $row['file_name'] ? file_get_contents($this->filePath($row['file_name'])) : false;
        if ($data === false) {
            throw new \RuntimeException("Attachment {$row['id']} has no file");
        }
        return 'data:' . ($row['mime'] ?? 'application/octet-stream') . ';base64,' . base64_encode($data);
    }

    /** Downloads the due attachments until $deadline (microtime); one process at a time. */
    /** @param list<string> $fileNames files of deleted attachments */
    public function remove(array $fileNames): void
    {
        foreach ($fileNames as $name) {
            @unlink($this->filePath($name));
        }
    }

    public function drain(float $deadline): void
    {
        $lock = Lock::take($this->lockDir, 'media');
        if ($lock === null) {
            return;
        }
        $cursor = 0;
        while (microtime(true) < $deadline) {
            $batch = $this->repo->pendingAttachments(Time::nowMs(), $cursor);
            if (!$batch) {
                break;
            }
            foreach ($batch as $row) {
                if (microtime(true) >= $deadline) {
                    break 2;
                }
                $cursor = $row['id'];
                $this->downloadOne($row);
            }
        }
        $lock->release();
    }

    private function downloadOne(array $row): void
    {
        $attempts = $row['attempts'] + 1;
        try {
            if (!$row['remote_url']) {
                throw new \RuntimeException('No remote URL');
            }
            [$bytes, $mime] = $this->fetchRemote($row['remote_url']);
            $saved = $this->save($bytes, $mime);
            $this->repo->updateAttachment($row['id'], $saved + ['status' => 'ready', 'attempts' => $attempts]);
        } catch (\Throwable $e) {
            $failed = $attempts >= self::MAX_DOWNLOAD_ATTEMPTS;
            Log::warn('Media download failed', ['attachment' => $row['id'], 'attempts' => $attempts, 'err' => $e]);
            $this->repo->updateAttachment($row['id'], [
                'attempts' => $attempts,
                'status' => $failed ? 'failed' : 'pending',
                'nextAttemptAt' => Time::nowMs() + min(self::RETRY_BASE_MS * 2 ** ($attempts - 1), self::RETRY_MAX_MS),
            ]);
            if (!$failed) {
                return;
            }
        }
        $this->announce($row['message_id']);
    }

    /** Tells the open tabs that an attachment of this message changed. */
    public function announce(int $messageId): void
    {
        $message = $this->repo->getMessage($messageId);
        $conversation = $message ? $this->repo->getConversation($message['conversationId']) : null;
        if ($message && $conversation) {
            $this->events->broadcast(['type' => 'message', 'message' => $message, 'conversation' => $conversation]);
        }
    }

    /** @return array{0: string, 1: ?string} the bytes and their type */
    private function fetchRemote(string $url): array
    {
        if (str_starts_with($url, 'data:')) {
            if (!preg_match('/^data:([^;,]+)?(;base64)?,(.*)$/s', $url, $m)) {
                throw new \RuntimeException('Malformed data URI');
            }
            $bytes = $m[2] !== '' ? base64_decode($m[3]) : rawurldecode($m[3]);
            return [$bytes, self::cleanMime($m[1])];
        }
        $received = '';
        $curl = curl_init($url);
        curl_setopt_array($curl, [
            CURLOPT_FOLLOWLOCATION => true,
            CURLOPT_MAXREDIRS => 5,
            CURLOPT_PROTOCOLS => CURLPROTO_HTTP | CURLPROTO_HTTPS,
            CURLOPT_REDIR_PROTOCOLS => CURLPROTO_HTTP | CURLPROTO_HTTPS,
            CURLOPT_TIMEOUT => 60,
            CURLOPT_CONNECTTIMEOUT => 15,
            CURLOPT_WRITEFUNCTION => static function ($curl, string $chunk) use (&$received): int {
                $received .= $chunk;
                // Returning less than the chunk aborts the transfer.
                return strlen($received) > self::MAX_DOWNLOAD_BYTES ? 0 : strlen($chunk);
            },
        ]);
        $ok = curl_exec($curl);
        $status = (int) curl_getinfo($curl, CURLINFO_RESPONSE_CODE);
        $type = curl_getinfo($curl, CURLINFO_CONTENT_TYPE);
        $error = curl_error($curl);
        curl_close($curl);
        if (strlen($received) > self::MAX_DOWNLOAD_BYTES) {
            throw new \RuntimeException('Media too large');
        }
        if ($ok === false) {
            throw new \RuntimeException($error);
        }
        if ($status < 200 || $status >= 300) {
            throw new \RuntimeException("HTTP $status");
        }
        $mime = self::cleanMime(is_string($type) ? $type : null);
        if ($mime === null || $mime === 'application/octet-stream' || $mime === 'binary/octet-stream') {
            $mime = self::mimeFromUrl($url) ?? $mime;
        }
        return [$received, $mime];
    }

    private static function cleanMime(?string $contentType): ?string
    {
        $mime = strtolower(trim(explode(';', $contentType ?? '')[0]));
        return $mime !== '' ? $mime : null;
    }

    private static function mimeFromUrl(string $url): ?string
    {
        if (!preg_match('/\.([a-z0-9]{2,5})(?:$|[?#])/i', $url, $m)) {
            return null;
        }
        $ext = strtolower($m[1]);
        if ($ext === 'jpeg') {
            return 'image/jpeg';
        }
        $mime = array_search($ext, self::EXTENSIONS, true);
        return $mime === false ? null : $mime;
    }

    private static function uuid(): string
    {
        $b = random_bytes(16);
        $b[6] = chr((ord($b[6]) & 0x0f) | 0x40);
        $b[8] = chr((ord($b[8]) & 0x3f) | 0x80);
        return vsprintf('%s%s-%s-%s-%s-%s%s%s', str_split(bin2hex($b), 4));
    }
}
