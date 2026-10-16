<?php

declare(strict_types=1);

namespace SmsPortal;

use SmsPortal\Http\HttpError;
use SmsPortal\VoipMs\VoipMsApi;
use SmsPortal\VoipMs\VoipMsError;

/**
 * Records an outgoing message right away (status "sending") and delivers it
 * through VoIP.ms once the response is on its way; the tabs follow along
 * through their polls (server/send.ts).
 */
final class Sender
{
    /** Failures after which the text may still have gone out. */
    private const AMBIGUOUS_ERRORS = ['http_error', 'network_error', 'invalid_response', 'interrupted'];

    /**
     * @param \Closure(): ?VoipMsApi $getClient
     * @param \Closure(callable): void $defer runs work after the response
     */
    public function __construct(
        private readonly Repo $repo,
        private readonly Events $events,
        private readonly Media $media,
        private readonly Sync $sync,
        private readonly \Closure $getClient,
        private readonly string $lockDir,
        private readonly \Closure $defer,
    ) {
    }

    /**
     * @param list<array{bytes: string, mime: string}> $files
     * @return array{message: array, conversation: array}
     */
    public function queue(string $did, string $to, string $body, array $files): array
    {
        $did = Phone::normalize($did);
        $to = Phone::normalize($to);
        $didInfo = $this->repo->getDid($did);
        if (!$didInfo) {
            throw new HttpError(400, 'unknown_did');
        }
        if (!$didInfo['smsEnabled']) {
            throw new HttpError(400, 'sms_not_enabled');
        }
        if (!Phone::isValidNanp($to)) {
            throw new HttpError(400, 'invalid_destination');
        }
        foreach ($files as $file) {
            if (strlen($file['bytes']) > MessageRules::MAX_ATTACHMENT_BYTES) {
                throw new HttpError(400, 'attachment_too_large');
            }
        }
        $body = str_replace("\r\n", "\n", $body);
        $check = MessageRules::checkOutgoing($body, count($files));
        if ($check['problem'] !== null) {
            throw new HttpError(400, $check['problem']);
        }
        if ($check['kind'] === 'mms' && !$didInfo['mmsAvailable']) {
            throw new HttpError(400, 'mms_not_available');
        }

        $saved = array_map(fn (array $f) => $this->media->save($f['bytes'], $f['mime']), $files);
        [$messageId, $conversationId] = $this->repo->transaction(function () use ($did, $to, $body, $check, $saved): array {
            $conversationId = $this->repo->getOrCreateConversation($did, $to);
            $messageId = $this->repo->insertMessage([
                'conversationId' => $conversationId,
                'kind' => $check['kind'],
                'remoteId' => null,
                'direction' => 'out',
                'body' => $body,
                'sentAt' => Time::nowMs(),
                'status' => 'sending',
            ]);
            foreach ($saved as $i => $file) {
                $this->repo->insertAttachment($messageId, $i, $file + ['status' => 'ready']);
            }
            $this->repo->touchConversation($conversationId);
            $this->repo->unarchiveConversation($conversationId);
            return [$messageId, $conversationId];
        });

        $result = $this->publish($messageId, $conversationId);
        ($this->defer)(fn () => $this->deliver($messageId));
        return $result;
    }

    public function retry(int $messageId): array
    {
        $row = $this->repo->getMessageRow($messageId);
        if (!$row || $row['direction'] !== 'out') {
            throw new HttpError(404, 'not_found');
        }
        if ($row['status'] !== 'failed') {
            throw new HttpError(409, 'not_failed');
        }
        if (in_array($row['error'] ?? '', self::AMBIGUOUS_ERRORS, true)) {
            // VoIP.ms may have taken the first attempt: look at the history
            // (which adopts it) before texting the recipient a second time.
            $this->sync->syncRecent(wait: true);
            if (($this->repo->getMessageRow($messageId)['status'] ?? null) === 'sent') {
                return $this->publish($messageId, $row['conversation_id'])['message'];
            }
        }
        $this->repo->updateMessage($messageId, ['status' => 'sending', 'error' => null]);
        $message = $this->publish($messageId, $row['conversation_id'])['message'];
        ($this->defer)(fn () => $this->deliver($messageId));
        return $message;
    }

    /** Sends through VoIP.ms. Never throws: failures end up on the message. */
    public function deliver(int $messageId): void
    {
        $lock = Lock::wait($this->lockDir, 'write', 60);
        $row = $this->repo->getMessageRow($messageId);
        if (!$row || $row['status'] !== 'sending') {
            $lock?->release();
            return;
        }
        $kind = $row['kind'];
        try {
            if ($lock === null) {
                throw new VoipMsError('interrupted', 'The write lock stayed busy');
            }
            $conversation = $this->repo->getConversation($row['conversation_id']) ?? throw new VoipMsError('not_found');
            $client = ($this->getClient)() ?? throw new VoipMsError('not_configured');
            $remoteId = null;
            if ($kind === 'sms') {
                try {
                    $remoteId = $client->sendSms($conversation['did'], $conversation['phone'], $row['body']);
                } catch (VoipMsError $e) {
                    // Our byte count should prevent this; if VoIP.ms disagrees, MMS has room for it.
                    if ($e->errorCode !== 'sms_toolong') {
                        throw $e;
                    }
                    $kind = 'mms';
                }
            }
            if ($kind === 'mms') {
                $media = array_map(fn (array $a) => $this->media->toDataUri($a), $this->repo->listAttachments($messageId));
                $remoteId = $client->sendMms($conversation['did'], $conversation['phone'], $row['body'], $media);
            }
            $this->repo->updateMessage($messageId, ['kind' => $kind, 'remoteId' => $remoteId, 'status' => 'sent', 'error' => null]);
        } catch (\Throwable $e) {
            $code = $e instanceof VoipMsError ? $e->errorCode : 'internal_error';
            Log::warn('Sending failed', ['messageId' => $messageId, 'code' => $code, 'err' => $e]);
            // Keep the kind actually attempted, so the history can be matched against it.
            $this->repo->updateMessage($messageId, ['kind' => $kind, 'status' => 'failed', 'error' => $code]);
        } finally {
            $lock?->release();
        }
        $this->publish($messageId, $row['conversation_id']);
    }

    /** @return array{message: array, conversation: array} */
    private function publish(int $messageId, int $conversationId): array
    {
        $message = $this->repo->getMessage($messageId);
        $conversation = $this->repo->getConversation($conversationId);
        $this->events->broadcast(['type' => 'message', 'message' => $message, 'conversation' => $conversation]);
        return ['message' => $message, 'conversation' => $conversation];
    }
}
