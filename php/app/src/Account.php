<?php

declare(strict_types=1);

namespace SmsPortal;

use SmsPortal\VoipMs\VoipMsApi;

/** One VoIP.ms account: its client, the checks of its numbers, and VoIP.ms calling back for them. */
final class Account
{
    public readonly Sync $sync;
    public readonly Webhook $webhook;
    private ?VoipMsApi $client = null;
    private bool $clientLoaded = false;

    /**
     * @param \Closure(): ?VoipMsApi $makeClient null while the account has no credentials (or cannot read them)
     * @param \Closure(Account): array{0: Sync, 1: Webhook} $build
     */
    public function __construct(public readonly int $id, private readonly \Closure $makeClient, \Closure $build)
    {
        [$this->sync, $this->webhook] = $build($this);
    }

    public function client(): ?VoipMsApi
    {
        if (!$this->clientLoaded) {
            $this->client = ($this->makeClient)();
            $this->clientLoaded = true;
        }
        return $this->client;
    }

    /** Drops the cached client after its credentials change. */
    public function resetClient(): void
    {
        $this->client = null;
        $this->clientLoaded = false;
    }
}
