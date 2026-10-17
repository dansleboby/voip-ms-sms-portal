<?php

declare(strict_types=1);

namespace SmsPortal\VoipMs;

use SmsPortal\Text;

/**
 * VoIP.ms REST client (server/voipms/client.ts). What the live API taught:
 * - bodies must be multipart/form-data (urlencoded ones get a SOAP fault);
 * - every call but getIP is refused unless the caller's IP is whitelisted;
 * - getSMS/getMMS with all_messages=1 mix both kinds without saying which,
 *   and their ids overlap: each kind is fetched on its own;
 * - "no results" comes back as an error status (no_sms, no_did).
 */
final class RestClient implements VoipMsApi
{
    /** Spacing between two calls, to stay clear of the per-minute API limit. */
    private const MIN_INTERVAL_US = 250_000;
    /**
     * A number's SMS settings as getDIDsInfo reports them => the names setSMS
     * takes them under: enabling SMS gives them back, so as not to reset them.
     */
    private const SMS_SETTINGS = [
        'sms_email_enabled' => 'email_enabled',
        'sms_email' => 'email_address',
        'sms_forward_enabled' => 'sms_forward_enable',
        'sms_forward' => 'sms_forward',
        'sms_url_callback_enabled' => 'url_callback_enable',
        'sms_url_callback' => 'url_callback',
        'sms_url_callback_retry' => 'url_callback_retry',
        'smpp_enabled' => 'smpp_enabled',
        'smpp_url' => 'smpp_url',
        'smpp_user' => 'smpp_user',
        'smpp_pass' => 'smpp_pass',
    ];
    private const TIMEOUT_S = 60;

    private float $lastCallAt = 0;

    public function __construct(private readonly string $username, private readonly string $password, private readonly string $url)
    {
    }

    private function call(string $method, array $params = []): array
    {
        $wait = (int) (($this->lastCallAt - microtime(true)) * 1_000_000) + self::MIN_INTERVAL_US;
        if ($wait > 0) {
            usleep($wait);
        }
        $this->lastCallAt = microtime(true);

        $fields = ['api_username' => $this->username, 'api_password' => $this->password, 'method' => $method, 'content_type' => 'json'];
        foreach ($params as $key => $value) {
            if ($value !== null) {
                $fields[$key] = (string) $value;
            }
        }
        $curl = curl_init($this->url);
        curl_setopt_array($curl, [
            CURLOPT_POST => true,
            // An array makes curl send multipart/form-data.
            CURLOPT_POSTFIELDS => $fields,
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_TIMEOUT => self::TIMEOUT_S,
            CURLOPT_CONNECTTIMEOUT => 15,
        ]);
        $text = curl_exec($curl);
        $status = (int) curl_getinfo($curl, CURLINFO_RESPONSE_CODE);
        $error = curl_error($curl);
        curl_close($curl);
        if ($text === false) {
            throw new VoipMsError('network_error', $error);
        }
        if ($status < 200 || $status >= 300) {
            throw new VoipMsError('http_error', "HTTP $status");
        }
        $data = json_decode((string) $text, true);
        if (!is_array($data)) {
            throw new VoipMsError('invalid_response', substr((string) $text, 0, 200));
        }
        if (($data['status'] ?? null) !== 'success') {
            throw new VoipMsError(self::str($data['status'] ?? '') ?: 'unknown_error', is_string($data['message'] ?? null) ? $data['message'] : null);
        }
        return $data;
    }

    public function getIP(): string
    {
        return self::str($this->call('getIP')['ip'] ?? '');
    }

    public function getBalance(): float
    {
        $balance = $this->call('getBalance')['balance']['current_balance'] ?? null;
        return is_numeric($balance) ? (float) $balance : NAN;
    }

    public function getDids(): array
    {
        try {
            $data = $this->call('getDIDsInfo');
        } catch (VoipMsError $e) {
            if ($e->errorCode === 'no_did') {
                return [];
            }
            throw $e;
        }
        $dids = is_array($data['dids'] ?? null) ? $data['dids'] : [];
        return array_map(static fn (array $d) => [
            'did' => self::str($d['did'] ?? ''),
            'description' => self::str($d['description'] ?? '') ?: null,
            'smsAvailable' => self::flag($d['sms_available'] ?? null),
            'smsEnabled' => self::flag($d['sms_enabled'] ?? null),
            'mmsAvailable' => self::flag($d['mms_available'] ?? null),
        ], array_values(array_filter($dids, 'is_array')));
    }

    public function deleteMessage(string $kind, string $id): void
    {
        $this->call($kind === 'sms' ? 'deleteSMS' : 'deleteMMS', ['id' => $id]);
    }

    public function enableSms(string $did): void
    {
        $data = $this->call('getDIDsInfo', ['did' => $did]);
        $info = null;
        foreach (is_array($data['dids'] ?? null) ? $data['dids'] : [] as $d) {
            if (is_array($d) && self::str($d['did'] ?? '') === $did) {
                $info = $d;
            }
        }
        if ($info === null) {
            throw new VoipMsError('invalid_did');
        }
        $params = ['did' => $did, 'enable' => 1];
        foreach (self::SMS_SETTINGS as $reported => $param) {
            if (isset($info[$reported])) {
                $params[$param] = self::str($info[$reported]);
            }
        }
        $this->call('setSMS', $params);
    }

    public function getMessages(string $kind, string $from, string $to, int $limit): array
    {
        try {
            $data = $this->call($kind === 'sms' ? 'getSMS' : 'getMMS', ['from' => $from, 'to' => $to, 'limit' => $limit, 'all_messages' => 0]);
        } catch (VoipMsError $e) {
            if ($e->errorCode === 'no_sms') {
                return [];
            }
            throw $e;
        }
        $rows = is_array($data['sms'] ?? null) ? $data['sms'] : [];
        return array_map(static fn (array $row) => self::parseMessage($kind, $row), array_values(array_filter($rows, 'is_array')));
    }

    public function sendSms(string $did, string $dst, string $message): string
    {
        return self::str($this->call('sendSMS', ['did' => $did, 'dst' => $dst, 'message' => $message])['sms'] ?? '');
    }

    public function sendMms(string $did, string $dst, string $message, array $media): string
    {
        $params = ['did' => $did, 'dst' => $dst, 'message' => $message];
        foreach (array_slice(array_values($media), 0, 3) as $i => $m) {
            $params['media' . ($i + 1)] = $m;
        }
        return self::str($this->call('sendMMS', $params)['mms'] ?? '');
    }

    public static function parseMessage(string $kind, array $row): array
    {
        $media = [];
        foreach (is_array($row['media'] ?? null) ? $row['media'] : [] as $m) {
            if (is_string($m) && trim($m) !== '') {
                $media[] = self::absoluteMediaUrl(trim($m));
            }
        }
        foreach (['col_media1', 'col_media2', 'col_media3'] as $key) {
            $m = trim(self::str($row[$key] ?? ''));
            if ($m !== '') {
                $media[] = self::absoluteMediaUrl($m);
            }
        }
        $carrier = trim(self::str($row['carrier_status'] ?? ''));
        return [
            'kind' => $kind,
            'id' => self::str($row['id'] ?? ''),
            'date' => self::str($row['date'] ?? ''),
            // VoIP.ms: type 1 = received, 0 = sent.
            'direction' => self::str($row['type'] ?? '') === '1' ? 'in' : 'out',
            'did' => self::str($row['did'] ?? ''),
            'contact' => self::str($row['contact'] ?? ''),
            'body' => Text::unescapeQuotes(self::str($row['message'] ?? '')),
            'carrierStatus' => $carrier !== '' ? $carrier : null,
            'media' => array_values(array_unique($media)),
        ];
    }

    private static function absoluteMediaUrl(string $url): string
    {
        return preg_match('~^https?://~i', $url) ? $url : 'https://voip.ms/' . ltrim($url, '/');
    }

    private static function str(mixed $value): string
    {
        return is_scalar($value) ? (string) $value : '';
    }

    private static function flag(mixed $value): bool
    {
        return $value === 1 || $value === '1' || $value === true;
    }
}
