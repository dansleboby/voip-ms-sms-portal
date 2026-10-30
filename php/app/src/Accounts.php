<?php

declare(strict_types=1);

namespace SmsPortal;

use SmsPortal\VoipMs\VoipMsApi;
use SmsPortal\VoipMs\VoipMsError;

/**
 * The VoIP.ms accounts the portal uses (server/accounts.ts). Each one is
 * checked on its own (its own credentials, watermark, lock and webhook), and
 * a number belongs to the account whose history it came from. To the rest of
 * the server, their checks look like one, reported together.
 */
final class Accounts
{
    /** @var array<int, Account> */
    private array $accounts = [];

    /**
     * @param \Closure(array{username: string, password: string}, int): VoipMsApi $clientFor
     * @param \Closure(Account): array{0: Sync, 1: Webhook} $build
     */
    public function __construct(
        private readonly Repo $repo,
        private readonly Events $events,
        private readonly Credentials $credentials,
        private readonly \Closure $clientFor,
        private readonly \Closure $build,
    ) {
        foreach ($repo->listAccounts() as $row) {
            $this->open((int) $row['id']);
        }
    }

    public function primary(): Account
    {
        return $this->open(Repo::PRIMARY_ACCOUNT);
    }

    public function get(int $id): ?Account
    {
        return $this->accounts[$id] ?? null;
    }

    /** @return list<Account> */
    public function all(): array
    {
        return array_values($this->accounts);
    }

    /** The account a number belongs to; null for a number the portal does not know. */
    public function forDid(string $did): ?Account
    {
        $id = $this->repo->accountOfDid(Phone::normalize($did));
        return $id === null ? null : ($this->accounts[$id] ?? null);
    }

    public function list(): array
    {
        return array_map(fn (array $a) => [
            'id' => (int) $a['id'],
            'label' => $a['label'],
            'username' => $this->credentials->get((int) $a['id'])['username'] ?? null,
            'credentialsSource' => $this->credentials->source(accountId: (int) $a['id']),
            'numbers' => (int) $a['numbers'],
        ], $this->repo->listAccounts());
    }

    /** Adds an account with credentials already checked; its numbers come with the next refresh. */
    public function add(?string $label, array $credentials): Account
    {
        $id = $this->repo->createAccount($label);
        $this->credentials->save($credentials, $id);
        return $this->open($id);
    }

    /**
     * Fetches every account's numbers from VoIP.ms; an account VoIP.ms refuses
     * keeps the ones it had. The first account's refusal is reported: it is
     * the one the setup wizard sets up.
     */
    public function refreshDids(): void
    {
        $primaryError = null;
        foreach ($this->accounts as $account) {
            $client = $account->client();
            if ($client === null) {
                continue;
            }
            try {
                $dids = array_values(array_filter($client->getDids(), fn (array $d) => $this->repo->allowsDid($d['did'])));
                $this->repo->transaction(function () use ($dids, $account): void {
                    foreach ($dids as $d) {
                        if (!$this->repo->upsertDid($d, $account->id)) {
                            Log::warn('Number already used under another account', ['did' => $d['did'], 'account' => $account->id]);
                        }
                    }
                });
            } catch (VoipMsError $e) {
                if ($account->id === Repo::PRIMARY_ACCOUNT) {
                    $primaryError = $e;
                } else {
                    Log::warn('Could not refresh the numbers of a VoIP.ms account', ['account' => $account->id, 'err' => $e]);
                }
            }
        }
        $this->events->broadcast(['type' => 'dids']);
        if ($primaryError !== null) {
            throw $primaryError;
        }
    }

    /** A call from VoIP.ms: the account whose secret it carries checks its numbers. */
    public function receive(string $token): bool
    {
        foreach ($this->accounts as $account) {
            if ($account->webhook->receive($token)) {
                return true;
            }
        }
        return false;
    }

    /**
     * One status for the tabs: an error or a check in progress on any account
     * shows; dates are those of the account checked least recently.
     */
    public function status(): array
    {
        $all = array_map(static fn (Account $a) => $a->sync->status(), $this->all());
        if (count($all) === 1) {
            return $all[0];
        }
        $live = array_values(array_filter($all, static fn (array $s) => $s['state'] !== 'disabled'));
        $states = array_column($live, 'state');
        $oldest = static function (array $values): ?int {
            return in_array(null, $values, true) || !$values ? null : min($values);
        };
        $importing = array_values(array_filter(array_column($all, 'importing')));
        $webhooks = array_values(array_filter(array_column($all, 'webhook')));
        $lastCalls = array_values(array_filter(array_column($webhooks, 'lastCallAt'), static fn ($v) => $v !== null));
        $lastError = null;
        foreach ($live as $s) {
            $lastError ??= $s['lastError'];
        }
        return [
            'state' => !$live ? 'disabled' : (in_array('syncing', $states, true) ? 'syncing' : (in_array('error', $states, true) ? 'error' : 'idle')),
            'mode' => $all[0]['mode'],
            'lastSyncAt' => $oldest(array_column($live, 'lastSyncAt')),
            'lastCheckAt' => $oldest(array_column($live, 'lastCheckAt')),
            'lastError' => $lastError,
            'importing' => $importing
                ? ['done' => array_sum(array_column($importing, 'done')), 'total' => array_sum(array_column($importing, 'total'))]
                : null,
            'webhook' => $webhooks
                ? ['lastCallAt' => $lastCalls ? max($lastCalls) : null, 'complete' => !in_array(false, array_column($webhooks, 'complete'), true)]
                : null,
        ] + (isset($all[0]['cron']) ? ['cron' => $all[0]['cron']] : []);
    }

    public function publishStatus(): void
    {
        $this->events->broadcast(['type' => 'sync', 'status' => $this->status()]);
    }

    private function open(int $id): Account
    {
        return $this->accounts[$id] ??= new Account(
            $id,
            function () use ($id): ?VoipMsApi {
                $credentials = $this->credentials->get($id);
                return $credentials !== null ? ($this->clientFor)($credentials, $id) : null;
            },
            $this->build,
        );
    }
}
