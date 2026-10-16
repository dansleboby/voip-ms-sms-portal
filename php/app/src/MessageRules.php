<?php

declare(strict_types=1);

namespace SmsPortal;

/**
 * SMS or MMS, as in shared/message.ts: VoIP.ms counts its 160-character SMS
 * limit in UTF-8 bytes (strlen), and anything longer, or with attachments,
 * goes out as an MMS.
 */
final class MessageRules
{
    public const SMS_MAX_BYTES = 160;
    public const MMS_MAX_BYTES = 2048;
    public const MAX_ATTACHMENTS = 3;
    public const MAX_ATTACHMENT_BYTES = 1_200_000;

    /**
     * @return array{kind: string, bytes: int, problem: ?string}
     */
    public static function checkOutgoing(string $body, int $attachmentCount): array
    {
        $bytes = strlen($body);
        $kind = $attachmentCount > 0 || $bytes > self::SMS_MAX_BYTES ? 'mms' : 'sms';
        $problem = null;
        if (trim($body) === '' && $attachmentCount === 0) {
            $problem = 'empty';
        } elseif ($attachmentCount > self::MAX_ATTACHMENTS) {
            $problem = 'too_many_attachments';
        } elseif ($bytes > self::MMS_MAX_BYTES) {
            $problem = 'too_long';
        }
        return ['kind' => $kind, 'bytes' => $bytes, 'problem' => $problem];
    }
}
