<?php

declare(strict_types=1);

namespace SmsPortal\Routes;

use SmsPortal\App;
use SmsPortal\Http\HttpError;
use SmsPortal\Http\Input;
use SmsPortal\Http\InvalidRequest;
use SmsPortal\Http\Request;
use SmsPortal\Http\Response;
use SmsPortal\Media;
use SmsPortal\MessageRules;
use SmsPortal\Phone;

/** server/routes/messaging.ts, with polling in place of the event stream. */
final class MessagingRoutes
{
    private const CLIENT_ID = '/^[\w-]{8,64}$/';
    /** What MMS carriers accept: pictures, video, audio clips and contact cards. */
    private const SENDABLE = '~^(image|video|audio)/[\w.+-]+$|^text/(x-)?vcard$~';

    public static function register(App $app): void
    {
        $r = $app->router;
        $repo = $app->repo;
        $events = $app->events;

        /**
         * Deletes messages of a conversation (all of them when $ids is null); voipms=1 in the
         * query deletes them at VoIP.ms too, after the response. Returns the deleted ids.
         */
        $deleteMessages = static function (int $conversationId, ?array $ids, Request $req) use ($app, $repo, $events): array {
            $alsoAtVoipMs = (new Input($req->query))->choice('voipms', ['0', '1']) === '1';
            $deleted = $repo->deleteMessages($conversationId, $ids, $alsoAtVoipMs);
            if (!$deleted['ids']) {
                return [];
            }
            $app->media->remove($deleted['files']);
            if ($alsoAtVoipMs) {
                $app->defer(fn () => $app->deletions->drain(microtime(true) + 20));
            }
            $events->broadcast(['type' => 'deleted', 'conversation' => $repo->getConversation($conversationId), 'messageIds' => $deleted['ids']]);
            $events->broadcast(['type' => 'dids']);
            return $deleted['ids'];
        };

        // ---------------------------------------------------------------- numbers

        $r->add('GET', '/api/dids', fn () => Response::json($repo->listDids()));

        $r->add('PATCH', '/api/dids/{did}', function (Request $req) use ($repo, $events): Response {
            $did = $req->param('did');
            $body = new Input($req->json());
            $patch = [];
            if ($body->has('label')) {
                $patch['label'] = $body->nullableString('label', 40);
            }
            if ($body->has('color')) {
                $patch['color'] = $body->matching('color', '/^#[0-9a-fA-F]{6}$/');
            }
            if ($body->has('visible')) {
                $patch['visible'] = $body->bool('visible');
            }
            if ($body->has('position')) {
                $patch['position'] = $body->int('position', 0, 1000);
            }
            if (!$repo->updateDid($did, $patch)) {
                throw new HttpError(404, 'not_found');
            }
            $events->broadcast(['type' => 'dids']);
            $events->broadcast(['type' => 'reload']);
            return Response::json($repo->getDid($did));
        });

        /** Turns SMS on for a number in the VoIP.ms account, and shows the number. */
        $r->add('POST', '/api/dids/{did}/enable-sms', function (Request $req) use ($app, $repo, $events): Response {
            $did = $req->param('did');
            $current = $repo->getDid($did) ?? throw new HttpError(404, 'not_found');
            if (!$current['smsAvailable']) {
                throw new HttpError(409, 'sms_not_available');
            }
            $account = $app->accounts->forDid($did);
            $client = $account?->client() ?? throw new HttpError(409, 'not_configured');
            if (!$current['smsEnabled']) {
                // With webhooks on, the number calls back from the start.
                $client->enableSms($did, $account->webhook->callbackForNewNumber());
            }
            $info = [];
            foreach ($client->getDids() as $d) {
                if ($d['did'] === $did) {
                    $info = $d;
                }
            }
            $repo->transaction(function () use ($repo, $did, $current, $info, $account): void {
                // VoIP.ms accepted it: trust that over a list that may not show it yet.
                $repo->upsertDid(['smsEnabled' => true] + $info + $current, $account->id);
                $repo->updateDid($did, ['visible' => true]);
            });
            $events->broadcast(['type' => 'dids']);
            $events->broadcast(['type' => 'reload']);
            return Response::json($repo->getDid($did));
        });

        // ---------------------------------------------------------- conversations

        $r->add('GET', '/api/conversations', function (Request $req) use ($repo): Response {
            $query = new Input($req->query);
            $q = $query->optionalString('q', 200);
            $archived = $query->choice('archived', ['0', '1']);
            return Response::json($repo->listConversations(
                did: $query->optionalString('did') ?: null,
                query: $q,
                archived: $archived === null ? null : $archived === '1',
            ));
        });

        $r->add('GET', '/api/conversations/lookup', function (Request $req) use ($repo): Response {
            $query = new Input($req->query);
            $id = $repo->findConversation(Phone::normalize($query->string('did')), Phone::normalize($query->string('phone')));
            return Response::json(['conversation' => $id ? $repo->getConversation($id) : null]);
        });

        $r->add('GET', '/api/conversations/{id}', function (Request $req) use ($repo): Response {
            return Response::json($repo->getConversation(Input::id($req->param('id'))) ?? throw new HttpError(404, 'not_found'));
        });

        $r->add('PATCH', '/api/conversations/{id}', function (Request $req) use ($repo, $events): Response {
            $id = Input::id($req->param('id'));
            $archived = (new Input($req->json()))->bool('archived');
            if (!$repo->getConversation($id)) {
                throw new HttpError(404, 'not_found');
            }
            $repo->setArchived($id, $archived);
            $conversation = $repo->getConversation($id);
            $events->broadcast(['type' => 'conversation', 'conversation' => $conversation]);
            $events->broadcast(['type' => 'dids']);
            return Response::json($conversation);
        });

        /** Deletes the whole conversation; a new text brings it back, with that text only. */
        $r->add('DELETE', '/api/conversations/{id}', function (Request $req) use ($repo, $deleteMessages): Response {
            $id = Input::id($req->param('id'));
            if (!$repo->getConversation($id)) {
                throw new HttpError(404, 'not_found');
            }
            return Response::json(['ok' => true, 'deleted' => count($deleteMessages($id, null, $req))]);
        });

        $r->add('GET', '/api/conversations/{id}/messages', function (Request $req) use ($repo): Response {
            $id = Input::id($req->param('id'));
            $query = new Input($req->query);
            $before = $query->has('before') ? Input::id((string) $query->string('before')) : null;
            $limit = null;
            if ($query->has('limit')) {
                $limit = (int) $query->matching('limit', '/^\d{1,3}$/');
                if ($limit < 1 || $limit > 200) {
                    throw new InvalidRequest('limit: expected 1 to 200');
                }
            }
            if (!$repo->getConversation($id)) {
                throw new HttpError(404, 'not_found');
            }
            return Response::json($repo->listMessages($id, $before, $limit));
        });

        $r->add('POST', '/api/conversations/{id}/read', function (Request $req) use ($repo, $events): Response {
            $id = Input::id($req->param('id'));
            if (!$repo->getConversation($id)) {
                throw new HttpError(404, 'not_found');
            }
            if ($repo->markConversationRead($id)) {
                $events->broadcast(['type' => 'conversation', 'conversation' => $repo->getConversation($id)]);
                $events->broadcast(['type' => 'dids']);
            }
            return Response::json(['ok' => true]);
        });

        // --------------------------------------------------------------- messages

        /** multipart/form-data: did, to, body and up to 3 "files[]". */
        $r->add('POST', '/api/messages', function (Request $req) use ($app): Response {
            $files = self::uploadedFiles($req);
            $field = static fn (string $name) => is_string($req->post[$name] ?? null) ? $req->post[$name] : '';
            $result = $app->sender->queue($field('did'), $field('to'), $field('body'), $files);
            return Response::json($result, 202);
        });

        $r->add('DELETE', '/api/messages/{id}', function (Request $req) use ($repo, $deleteMessages): Response {
            $id = Input::id($req->param('id'));
            $row = $repo->getMessageRow($id);
            if (!$row || !$repo->getConversation($row['conversation_id'])) {
                throw new HttpError(404, 'not_found');
            }
            // Its outcome is not known yet: VoIP.ms may be sending it right now.
            if ($row['status'] === 'sending') {
                throw new HttpError(409, 'still_sending');
            }
            $deleteMessages($row['conversation_id'], [$id], $req);
            return Response::json(['ok' => true]);
        });

        $r->add('POST', '/api/messages/{id}/retry', fn (Request $req) => Response::json($app->sender->retry(Input::id($req->param('id')))));

        $r->add('GET', '/api/media/{id}', function (Request $req) use ($app, $repo): Response {
            $id = Input::id($req->param('id'));
            $row = $repo->getAttachment($id);
            if (!$row || $row['status'] !== 'ready' || !$row['file_name'] || !is_file($file = $app->media->filePath($row['file_name']))) {
                throw new HttpError(404, 'not_found');
            }
            $ext = pathinfo($row['file_name'], PATHINFO_EXTENSION);
            return new Response(200, [
                'Content-Type' => $row['mime'] ?? 'application/octet-stream',
                'Cache-Control' => 'private, max-age=31536000, immutable',
                // Received files are untrusted: never let one run script on this origin.
                'Content-Security-Policy' => "default-src 'none'; img-src 'self' data:; media-src 'self'; style-src 'unsafe-inline'; sandbox",
                'Content-Disposition' => (Media::isInlineSafe($row['mime']) ? 'inline' : 'attachment') . "; filename=\"attachment-$id.$ext\"",
            ], file: $file);
        });

        $r->add('POST', '/api/media/{id}/retry', function (Request $req) use ($app, $repo): Response {
            $id = Input::id($req->param('id'));
            if (!$repo->resetAttachment($id)) {
                throw new HttpError(404, 'not_found');
            }
            $app->media->announce($repo->getAttachment($id)['message_id']);
            $app->defer(fn () => $app->media->drain(microtime(true) + 20));
            return Response::json(['ok' => true]);
        });

        // ------------------------------------------------------------------- sync

        $r->add('GET', '/api/sync/status', fn () => Response::json($app->accounts->status()));

        $r->add('POST', '/api/sync/now', function () use ($app): Response {
            $app->defer(function () use ($app): void {
                foreach ($app->accounts->all() as $account) {
                    $account->sync->syncRecent();
                }
            });
            return Response::json($app->accounts->status());
        });

        /** A tab reports being shown or hidden, so push notifications skip the device it is on screen on. */
        $r->add('POST', '/api/presence', function (Request $req) use ($events): Response {
            $body = new Input($req->json());
            $tab = $body->matching('tab', self::CLIENT_ID, required: true);
            return Response::json(['ok' => $events->setVisibility($tab, $body->bool('visible'))]);
        });

        /** The events since the tab's last poll; checking VoIP.ms when due comes after the response. */
        $r->add('GET', '/api/events/poll', function (Request $req) use ($app, $events): Response {
            $query = new Input($req->query);
            $device = $query->matching('device', self::CLIENT_ID);
            $tab = $query->matching('tab', self::CLIENT_ID);
            $visible = $query->choice('visible', ['0', '1']) !== '0';
            $after = $query->optionalString('after', 100);
            $result = $events->poll($after, $tab, $device, $visible);
            // Like the stream's first frame: a tab starting over learns the sync state.
            if ($after === null || $result['reset']) {
                array_unshift($result['events'], ['type' => 'sync', 'status' => $app->accounts->status()]);
            }
            $app->background(active: true, opening: $after === null);
            return Response::json($result);
        });
    }

    /**
     * The attachments of a send, from $_FILES["files"].
     *
     * @return list<array{bytes: string, mime: string}>
     */
    private static function uploadedFiles(Request $req): array
    {
        $length = (int) ($req->header('content-length') ?? 0);
        if (!$req->post && !$req->files && $length > self::bytes((string) ini_get('post_max_size'))) {
            // PHP drops the whole body when it exceeds post_max_size.
            throw new HttpError(413, 'payload_too_large');
        }
        $upload = $req->files['files'] ?? null;
        if ($upload === null) {
            return [];
        }
        // "files[]" arrives as parallel lists; a lone "files" as single values.
        $names = (array) $upload['tmp_name'];
        if (count($names) > MessageRules::MAX_ATTACHMENTS) {
            throw new HttpError(413, 'too_many_attachments');
        }
        $files = [];
        foreach (array_keys($names) as $i) {
            $error = ((array) $upload['error'])[$i];
            if ($error === UPLOAD_ERR_INI_SIZE || $error === UPLOAD_ERR_FORM_SIZE) {
                throw new HttpError(413, 'attachment_too_large');
            }
            if ($error !== UPLOAD_ERR_OK) {
                throw new HttpError(400, 'upload_failed');
            }
            $mime = strtolower((string) ((array) $upload['type'])[$i]);
            if (!preg_match(self::SENDABLE, $mime)) {
                throw new HttpError(400, 'unsupported_attachment');
            }
            if ((int) ((array) $upload['size'])[$i] > MessageRules::MAX_ATTACHMENT_BYTES) {
                throw new HttpError(413, 'attachment_too_large');
            }
            $files[] = ['bytes' => (string) file_get_contents($names[$i]), 'mime' => $mime];
        }
        return $files;
    }

    /** "8M" -> 8388608. */
    private static function bytes(string $size): int
    {
        $value = (int) $size;
        return match (strtoupper(substr(trim($size), -1))) {
            'G' => $value * 1024 ** 3,
            'M' => $value * 1024 ** 2,
            'K' => $value * 1024,
            default => $value,
        };
    }
}
