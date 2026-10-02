/**
 * Rules for choosing between SMS and MMS.
 *
 * VoIP.ms rejects an SMS whose body is longer than 160 *UTF-8 bytes* (PHP
 * strlen), not 160 characters: an accented letter counts for 2 and an emoji
 * for 4. Verified against the live API (sms_toolong at 161 bytes, accepted at
 * 160 bytes with accents). Anything longer, or with attachments, goes out as
 * an MMS.
 */

export const SMS_MAX_BYTES = 160;
/** sendMMS documents "max chars: 2048"; counted in bytes to stay on the safe side. */
export const MMS_MAX_BYTES = 2048;
export const MAX_ATTACHMENTS = 3;
/** VoIP.ms documents 1.2 MB per file when sending base64 media over POST. */
export const MAX_ATTACHMENT_BYTES = 1_200_000;

export type MessageKind = 'sms' | 'mms';

const encoder = new TextEncoder();

export function utf8Length(text: string): number {
  return encoder.encode(text).length;
}

export function pickMessageKind(body: string, attachmentCount: number): MessageKind {
  return attachmentCount > 0 || utf8Length(body) > SMS_MAX_BYTES ? 'mms' : 'sms';
}

export type OutgoingProblem = 'empty' | 'too_long' | 'too_many_attachments';

export interface OutgoingCheck {
  kind: MessageKind;
  bytes: number;
  problem: OutgoingProblem | null;
}

export function checkOutgoing(body: string, attachmentCount: number): OutgoingCheck {
  const bytes = utf8Length(body);
  const kind = pickMessageKind(body, attachmentCount);
  let problem: OutgoingProblem | null = null;
  if (body.trim() === '' && attachmentCount === 0) problem = 'empty';
  else if (attachmentCount > MAX_ATTACHMENTS) problem = 'too_many_attachments';
  else if (bytes > MMS_MAX_BYTES) problem = 'too_long';
  return { kind, bytes, problem };
}
