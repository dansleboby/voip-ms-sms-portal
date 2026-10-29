<?php

declare(strict_types=1);

namespace SmsPortal\VoipMs;

/**
 * What the portal needs from VoIP.ms; also implemented by the demo client.
 *
 * Messages are arrays: kind ("sms"|"mms"), id, date (wall clock in VoIP.ms's
 * time zone), direction ("in"|"out"), did, contact, body, carrierStatus,
 * media (absolute URLs or data URIs).
 */
interface VoipMsApi
{
    public function getIP(): string;

    public function getBalance(): float;

    /**
     * "callback": where VoIP.ms sends a GET for each text the number receives
     * (its "SMS/MMS URL Callback"); "retry": VoIP.ms calls again every 30
     * minutes until it gets "ok".
     *
     * @return list<array{did: string, description: ?string, smsAvailable: bool, smsEnabled: bool, mmsAvailable: bool, callback: ?array{url: string, retry: bool}}>
     */
    public function getDids(): array;

    /**
     * Turns SMS on for one of the account's numbers, keeping its other SMS
     * settings; with $callback, points its URL callback there in the same call.
     *
     * @param ?array{url: string, retry: bool} $callback
     */
    public function enableSms(string $did, ?array $callback = null): void;

    /**
     * Points the URL callback of a number with SMS on at $callback, or turns it off; nothing else changes.
     *
     * @param ?array{url: string, retry: bool} $callback
     */
    public function setCallback(string $did, ?array $callback): void;

    /** Messages between two calendar dates, inclusive ("YYYY-MM-DD", VoIP.ms's time zone). */
    public function getMessages(string $kind, string $from, string $to, int $limit): array;

    /** @return string the VoIP.ms id of the message */
    public function sendSms(string $did, string $dst, string $message): string;

    /** @param list<string> $media data URIs or public URLs, at most 3 */
    public function sendMms(string $did, string $dst, string $message, array $media): string;

    /** Removes a message from the account's history. */
    public function deleteMessage(string $kind, string $id): void;
}
