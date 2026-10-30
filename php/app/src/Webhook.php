<?php

declare(strict_types=1);

namespace SmsPortal;

use SmsPortal\Http\HttpError;
use SmsPortal\VoipMs\VoipMsApi;
use SmsPortal\VoipMs\VoipMsError;

/**
 * Texts announced by VoIP.ms (each number's "SMS/MMS URL Callback") instead
 * of found by checking on a schedule. A call is only a
 * signal to check VoIP.ms right away: what it says is never stored, since
 * nothing proves it comes from VoIP.ms. The secret in its address only keeps
 * strangers from making the portal check more often.
 */
final class Webhook
{
    private const ENABLED_KEY = 'webhook.enabled';
    private const TOKEN_KEY = 'webhook.token';
    private const URL_KEY = 'webhook.url';
    /** '1' while every number with SMS on calls back (as of the last look at VoIP.ms). */
    private const COMPLETE_KEY = 'webhook.complete';
    /** The callbacks this portal replaced, by number, to give them back when webhooks are turned off. */
    private const PREVIOUS_KEY = 'webhook.previous';
    private const LAST_CALL_KEY = 'webhook.lastCallAt';

    /** Where VoIP.ms calls; the secret follows. */
    public const CALLBACK_PATH = '/api/voipms/callback/';
    /**
     * Checks that still run with webhooks on: VoIP.ms only calls for texts a
     * number receives, not for those sent from other apps, and a call can be
     * lost while the server is down. shared/webhook.ts has the same.
     */
    public const SAFETY_INTERVAL_MS = 15 * 60_000;

    /**
     * @param \Closure(): ?VoipMsApi $getClient
     * @param \Closure(): void $onCall a call from VoIP.ms: check it now
     */
    public function __construct(
        private readonly Repo $repo,
        private readonly \Closure $getClient,
        private readonly ?string $publicOrigin,
        private readonly \Closure $onCall,
        /** Each VoIP.ms account has its own secret and state (Accounts). */
        private readonly int $accountId = Repo::PRIMARY_ACCOUNT,
    ) {
    }

    /** This account's setting. */
    private function get(string $key): ?string
    {
        return $this->repo->getSetting(Repo::accountKey($this->accountId, $key));
    }

    private function set(string $key, string $value): void
    {
        $this->repo->setSetting(Repo::accountKey($this->accountId, $key), $value);
    }

    private function delete(string $key): void
    {
        $this->repo->deleteSetting(Repo::accountKey($this->accountId, $key));
    }

    public function enabled(): bool
    {
        return $this->get(self::ENABLED_KEY) === '1';
    }

    /** Every number with SMS on calls back: checks can slow down to the safety net. */
    public function complete(): bool
    {
        return $this->enabled() && $this->get(self::COMPLETE_KEY) === '1';
    }

    public function summary(): ?array
    {
        return $this->enabled() ? ['lastCallAt' => $this->lastCallAt(), 'complete' => $this->complete()] : null;
    }

    /**
     * The callback for a number whose SMS is turned on while webhooks are on.
     *
     * @return ?array{url: string, retry: bool}
     */
    public function callbackForNewNumber(): ?array
    {
        $url = $this->get(self::URL_KEY);
        return $this->enabled() && $url !== null ? ['url' => $url, 'retry' => true] : null;
    }

    /** A call to the callback address: true when its secret is right. */
    public function receive(string $token): bool
    {
        $expected = $this->get(self::TOKEN_KEY);
        if ($expected === null || !hash_equals($expected, $token)) {
            return false;
        }
        $this->set(self::LAST_CALL_KEY, (string) Time::nowMs());
        ($this->onCall)();
        return true;
    }

    /**
     * The callback of each number, as VoIP.ms has it now.
     *
     * @param array<string, string> $errors what VoIP.ms refused just before, by number
     */
    public function status(array $errors = []): array
    {
        $client = $this->client();
        $token = $this->get(self::TOKEN_KEY);
        $numbers = [];
        foreach ($client->getDids() as $d) {
            $did = Phone::normalize($d['did']);
            if (!$this->repo->allowsDid($did)) {
                continue;
            }
            $callback = $d['callback'] ?? null;
            $state = 'none';
            if (!$d['smsEnabled']) {
                $state = 'sms_off';
            } elseif ($callback !== null && $token !== null && self::isOurs($callback['url'], $token)) {
                $state = 'ours';
            } elseif ($callback !== null) {
                $state = 'other';
            }
            $numbers[] = [
                'did' => $did,
                'state' => $state,
                'otherUrl' => $state === 'other' ? $callback['url'] : null,
                'error' => $errors[$did] ?? null,
            ];
        }
        $enabled = $this->enabled();
        $complete = $enabled;
        foreach ($numbers as $n) {
            if ($n['state'] !== 'ours' && $n['state'] !== 'sms_off') {
                $complete = false;
            }
        }
        $this->set(self::COMPLETE_KEY, $complete ? '1' : '0');
        return [
            'enabled' => $enabled,
            'url' => $enabled ? $this->get(self::URL_KEY) : null,
            'lastCallAt' => $this->lastCallAt(),
            'complete' => $complete,
            'publicUrl' => $this->publicOrigin,
            'safetyMinutes' => intdiv(self::SAFETY_INTERVAL_MS, 60_000),
            'numbers' => $numbers,
        ];
    }

    /**
     * Points the callback of every number with SMS on at this portal. A number
     * that already calls another address keeps it unless listed in $replace;
     * what it had is kept, to give it back when webhooks are turned off.
     * $origin: the browser's, used when PUBLIC_URL is not set.
     *
     * @param list<string> $replace
     */
    public function enable(?string $origin, array $replace): array
    {
        $client = $this->client();
        $base = $this->publicOrigin ?? $origin;
        // VoIP.ms must reach the address from the Internet, and the secret must not travel in clear.
        if ($base === null || !str_starts_with($base, 'https://')) {
            throw new HttpError(400, 'webhook_needs_https');
        }
        $token = $this->get(self::TOKEN_KEY);
        if ($token === null) {
            $token = Base64Url::encode(random_bytes(24));
            $this->set(self::TOKEN_KEY, $token);
        }
        $url = rtrim($base, '/') . self::CALLBACK_PATH . $token;
        // VoIP.ms answers first: refused (an IP not allowed, say), nothing changes.
        $dids = $client->getDids();
        $this->set(self::URL_KEY, $url);
        $this->set(self::ENABLED_KEY, '1');

        $previous = $this->previous();
        $errors = [];
        foreach ($dids as $d) {
            $did = Phone::normalize($d['did']);
            $callback = $d['callback'] ?? null;
            if (!$this->repo->allowsDid($did) || !$d['smsEnabled'] || ($callback['url'] ?? null) === $url) {
                continue;
            }
            // A former address of this portal (another domain, say) is replaced without asking.
            $other = $callback !== null && !self::isOurs($callback['url'], $token) ? $callback : null;
            if ($other !== null && !in_array($did, $replace, true)) {
                continue;
            }
            try {
                $client->setCallback($d['did'], ['url' => $url, 'retry' => true]);
                if ($other !== null) {
                    $previous[$did] = $other;
                }
            } catch (VoipMsError $e) {
                $errors[$did] = $e->errorCode;
            }
        }
        $this->set(self::PREVIOUS_KEY, json_encode((object) $previous));
        return $this->status($errors);
    }

    /**
     * Back to checking on a schedule: the numbers calling this portal get back
     * the callback they had, or none. Checks speed up again even if VoIP.ms
     * refuses some changes; those numbers keep calling, which does no harm.
     */
    public function disable(): array
    {
        $client = $this->client();
        $this->delete(self::ENABLED_KEY);
        $this->delete(self::COMPLETE_KEY);
        $token = $this->get(self::TOKEN_KEY);
        $previous = $this->previous();
        $errors = [];
        foreach ($client->getDids() as $d) {
            $did = Phone::normalize($d['did']);
            $callback = $d['callback'] ?? null;
            if ($token === null || $callback === null || !self::isOurs($callback['url'], $token)) {
                continue;
            }
            try {
                $client->setCallback($d['did'], $previous[$did] ?? null);
                unset($previous[$did]);
            } catch (VoipMsError $e) {
                $errors[$did] = $e->errorCode;
            }
        }
        $this->set(self::PREVIOUS_KEY, json_encode((object) $previous));
        return $this->status($errors);
    }

    private function client(): VoipMsApi
    {
        return ($this->getClient)() ?? throw new HttpError(409, 'not_configured');
    }

    private function lastCallAt(): ?int
    {
        $value = $this->get(self::LAST_CALL_KEY);
        return $value !== null ? (int) $value : null;
    }

    /** @return array<string, array{url: string, retry: bool}> */
    private function previous(): array
    {
        $value = json_decode($this->get(self::PREVIOUS_KEY) ?? '{}', true);
        return is_array($value) ? $value : [];
    }

    /** A callback address of this portal: its path ends with the secret, whatever the domain. */
    private static function isOurs(string $url, string $token): bool
    {
        return parse_url($url, PHP_URL_PATH) === self::CALLBACK_PATH . $token;
    }
}
