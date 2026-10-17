<?php

declare(strict_types=1);

namespace SmsPortal;

use SmsPortal\VoipMs\VoipMsApi;
use SmsPortal\VoipMs\VoipMsError;

/**
 * Deletes at VoIP.ms the messages deleted "at VoIP.ms too", one call each,
 * after responses and from the cron job (server/deletions.ts). A failure
 * that may pass (network, rate limit) waits for the next run; the message
 * stays deleted in the portal whatever happens.
 */
final class RemoteDeletions
{
    /** Failures worth another try later; any other means VoIP.ms will not delete that message. */
    private const PASSING = ['network_error', 'http_error', 'invalid_response', 'api_limit_exceeded', 'not_configured'];

    /** @param \Closure(): ?VoipMsApi $getClient */
    public function __construct(private readonly Repo $repo, private readonly \Closure $getClient, private readonly string $lockDir)
    {
    }

    public function drain(float $deadline): void
    {
        $lock = Lock::take($this->lockDir, 'delete');
        if ($lock === null) {
            return;
        }
        try {
            while (microtime(true) < $deadline) {
                $batch = $this->repo->pendingRemoteDeletes(20);
                if (!$batch) {
                    return;
                }
                foreach ($batch as $message) {
                    if (microtime(true) >= $deadline) {
                        return;
                    }
                    try {
                        $client = ($this->getClient)() ?? throw new VoipMsError('not_configured');
                        $client->deleteMessage($message['kind'], $message['remoteId']);
                    } catch (VoipMsError $e) {
                        if (in_array($e->errorCode, self::PASSING, true)) {
                            return;
                        }
                        Log::warn('VoIP.ms did not delete a message; it stays deleted in the portal', ['messageId' => $message['id'], 'err' => $e]);
                    }
                    $this->repo->remoteDeleteDone($message['id']);
                }
            }
        } finally {
            $lock->release();
        }
    }
}
