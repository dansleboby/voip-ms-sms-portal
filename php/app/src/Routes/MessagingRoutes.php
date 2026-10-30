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
use SmsPortal\Repo;

/**
 * Numbers, conversations, messages, attachments, and the live updates tabs poll for.
 * A user of the Team mode sees the numbers given to them only, and texts (or deletes)
 * from those they may send from.
 */
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

        /** The database as the person signed in sees it: their numbers, and their own state where a number keeps one per person. */
        $scoped = static fn (Request $req): Repo => $repo->forViewer($req->viewer);

        /** A conversation they see, or 404; with $send, on a number they may text from, or 403. */
        $conversation = static function (Request $req, int $id, bool $send = false) use ($scoped): array {
            $conversation = $scoped($req)->getConversation($id) ?? throw new HttpError(404, 'not_found');
            if ($send && !$req->viewer?->canSend($conversation['did'])) {
                throw new HttpError(403, 'read_only');
            }
            return $conversation;
        };

        /** The attachment, if it belongs to a conversation they see. */
        $attachment = static function (Request $req, int $id) use ($repo, $conversation): array {
            $row = $repo->getAttachment($id) ?? throw new HttpError(404, 'not_found');
            $conversation($req, $repo->getMessageRow($row['message_id'])['conversation_id'] ?? 0);
            return $row;
        };

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

        $r->add('GET', '/api/dids', fn (Request $req) => Response::json($scoped($req)->listDids()));

        $r->admin('PATCH', '/api/dids/{did}', function (Request $req) use ($repo, $events, $scoped): Response {
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
            if ($body->has('sharedState')) {
                $patch['sharedState'] = $body->bool('sharedState');
            }
            if (!$repo->updateDid($did, $patch)) {
                throw new HttpError(404, 'not_found');
            }
            $events->broadcast(['type' => 'dids']);
            $events->broadcast(['type' => 'reload']);
            return Response::json($scoped($req)->getDid($did));
        });

        /** What the person signed in chose for a number, for themselves: hidden from their list, or muted. */
        $r->add('PATCH', '/api/me/dids/{did}', function (Request $req) use ($events, $scoped): Response {
            $repo = $scoped($req);
            $did = $req->param('did');
            if ($repo->getDid($did) === null) {
                throw new HttpError(404, 'not_found');
            }
            $body = new Input($req->json());
            $patch = [];
            foreach (['hidden', 'muted'] as $field) {
                if ($body->has($field)) {
                    $patch[$field] = $body->bool($field);
                }
            }
            $repo->setDidPrefs($did, $patch);
            // Their tabs only.
            $events->broadcast(['type' => 'dids', 'userKey' => $req->viewer->key]);
            $events->broadcast(['type' => 'reload', 'userKey' => $req->viewer->key]);
            return Response::json($repo->getDid($did));
        });

        /** Turns SMS on for a number in the VoIP.ms account, and shows the number. */
        $r->admin('POST', '/api/dids/{did}/enable-sms', function (Request $req) use ($app, $repo, $events, $scoped): Response {
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
            return Response::json($scoped($req)->getDid($did));
        });

        // ---------------------------------------------------------- conversations

        $r->add('GET', '/api/conversations', function (Request $req) use ($scoped): Response {
            $query = new Input($req->query);
            $q = $query->optionalString('q', 200);
            $archived = $query->choice('archived', ['0', '1']);
            return Response::json($scoped($req)->listConversations(
                did: $query->optionalString('did') ?: null,
                query: $q,
                archived: $archived === null ? null : $archived === '1',
            ));
        });

        $r->add('GET', '/api/conversations/lookup', function (Request $req) use ($scoped): Response {
            $query = new Input($req->query);
            $repo = $scoped($req);
            $id = $repo->findConversation(Phone::normalize($query->string('did')), Phone::normalize($query->string('phone')));
            return Response::json(['conversation' => $id ? $repo->getConversation($id) : null]);
        });

        $r->add('GET', '/api/conversations/{id}', fn (Request $req) => Response::json($conversation($req, Input::id($req->param('id')))));

        /** Archives for everyone, or for them only where the number keeps an archive per person. */
        $r->add('PATCH', '/api/conversations/{id}', function (Request $req) use ($events, $scoped, $conversation): Response {
            $id = Input::id($req->param('id'));
            $archived = (new Input($req->json()))->bool('archived');
            $conversation($req, $id);
            $repo = $scoped($req);
            $repo->setArchived($id, $archived);
            $result = $repo->getConversation($id);
            $events->broadcast(['type' => 'conversation', 'conversation' => $result]);
            $events->broadcast(['type' => 'dids']);
            return Response::json($result);
        });

        /** Deletes the whole conversation; a new text brings it back, with that text only. */
        $r->add('DELETE', '/api/conversations/{id}', function (Request $req) use ($deleteMessages, $conversation): Response {
            $id = Input::id($req->param('id'));
            $conversation($req, $id, send: true);
            return Response::json(['ok' => true, 'deleted' => count($deleteMessages($id, null, $req))]);
        });

        $r->add('GET', '/api/conversations/{id}/messages', function (Request $req) use ($repo, $conversation): Response {
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
            $conversation($req, $id);
            return Response::json($repo->listMessages($id, $before, $limit));
        });

        $r->add('POST', '/api/conversations/{id}/read', function (Request $req) use ($events, $scoped, $conversation): Response {
            $id = Input::id($req->param('id'));
            $conversation($req, $id);
            $repo = $scoped($req);
            if ($repo->markConversationRead($id)) {
                $events->broadcast(['type' => 'conversation', 'conversation' => $repo->getConversation($id)]);
                $events->broadcast(['type' => 'dids']);
            }
            return Response::json(['ok' => true]);
        });

        // --------------------------------------------------------------- messages

        /** multipart/form-data: did, to, body and up to 3 "files[]". */
        $r->add('POST', '/api/messages', function (Request $req) use ($app, $scoped): Response {
            $files = self::uploadedFiles($req);
            $field = static fn (string $name) => is_string($req->post[$name] ?? null) ? $req->post[$name] : '';
            $did = Phone::normalize($field('did'));
            $repo = $scoped($req);
            if ($repo->getDid($did) === null) {
                throw new HttpError(400, 'unknown_did');
            }
            if (!$req->viewer?->canSend($did)) {
                throw new HttpError(403, 'read_only');
            }
            // The owner has no name: the client says "the owner".
            $sentBy = ['key' => $req->viewer->key, 'name' => $req->user['userId'] === null ? null : ($req->user['name'] ?? $req->user['email'])];
            $result = $app->sender->queue($did, $field('to'), $field('body'), $files, $sentBy);
            $result['conversation'] = $repo->getConversation($result['conversation']['id']) ?? $result['conversation'];
            return Response::json($result, 202);
        });

        $r->add('DELETE', '/api/messages/{id}', function (Request $req) use ($repo, $deleteMessages, $conversation): Response {
            $id = Input::id($req->param('id'));
            $row = $repo->getMessageRow($id) ?? throw new HttpError(404, 'not_found');
            $conversation($req, $row['conversation_id'], send: true);
            // Its outcome is not known yet: VoIP.ms may be sending it right now.
            if ($row['status'] === 'sending') {
                throw new HttpError(409, 'still_sending');
            }
            $deleteMessages($row['conversation_id'], [$id], $req);
            return Response::json(['ok' => true]);
        });

        $r->add('POST', '/api/messages/{id}/retry', function (Request $req) use ($app, $repo, $conversation): Response {
            $id = Input::id($req->param('id'));
            $row = $repo->getMessageRow($id) ?? throw new HttpError(404, 'not_found');
            $conversation($req, $row['conversation_id'], send: true);
            return Response::json($app->sender->retry($id));
        });

        $r->add('GET', '/api/media/{id}', function (Request $req) use ($app, $attachment): Response {
            $id = Input::id($req->param('id'));
            $row = $attachment($req, $id);
            if ($row['status'] !== 'ready' || !$row['file_name'] || !is_file($file = $app->media->filePath($row['file_name']))) {
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

        $r->add('POST', '/api/media/{id}/retry', function (Request $req) use ($app, $repo, $attachment): Response {
            $id = Input::id($req->param('id'));
            $attachment($req, $id);
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
        $r->add('GET', '/api/events/poll', function (Request $req) use ($app, $events, $scoped): Response {
            $query = new Input($req->query);
            $device = $query->matching('device', self::CLIENT_ID);
            $tab = $query->matching('tab', self::CLIENT_ID);
            $visible = $query->choice('visible', ['0', '1']) !== '0';
            $after = $query->optionalString('after', 100);
            $result = $events->poll($after, $tab, $device, $visible);
            $result['events'] = self::forViewer($result['events'], $scoped($req), $req->viewer->key);
            // Like the stream's first frame: a tab starting over learns the sync state.
            if ($after === null || $result['reset']) {
                array_unshift($result['events'], ['type' => 'sync', 'status' => $app->accounts->status()]);
            }
            $app->background(active: true, opening: $after === null);
            return Response::json($result);
        });
    }

    /**
     * The events as the one polling sees them: about the conversations on their numbers
     * only, each conversation as it is now for them (their own unread count and archive,
     * where its number keeps them per person). An event with a userKey is for that person only.
     *
     * @param list<array> $events
     * @return list<array>
     */
    private static function forViewer(array $events, Repo $repo, int $viewerKey): array
    {
        $conversations = [];
        $visible = [];
        foreach ($events as $event) {
            if (array_key_exists('userKey', $event)) {
                if ($event['userKey'] !== $viewerKey) {
                    continue;
                }
                unset($event['userKey']);
            }
            if (isset($event['conversation']['id'])) {
                $id = $event['conversation']['id'];
                if (!array_key_exists($id, $conversations)) {
                    $conversations[$id] = $repo->getConversation($id);
                }
                if ($conversations[$id] === null) {
                    continue;
                }
                $event['conversation'] = $conversations[$id];
            }
            $visible[] = $event;
        }
        return $visible;
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
