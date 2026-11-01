<?php

declare(strict_types=1);

namespace SmsPortal\Routes;

use SmsPortal\App;
use SmsPortal\Base64Url;
use SmsPortal\Http\HttpError;
use SmsPortal\Http\Input;
use SmsPortal\Http\InvalidRequest;
use SmsPortal\Http\Request;
use SmsPortal\Http\Response;
use SmsPortal\WebPush;

/** Push subscriptions of the browsers, and the test notification. */
final class PushRoutes
{
    private const BASE64URL = '/^[\w-]+={0,2}$/';

    public static function register(App $app): void
    {
        $r = $app->router;
        $repo = $app->repo;

        $r->add('GET', '/api/push/key', function () use ($app): Response {
            $app->push->checkOwner();
            return Response::json(['publicKey' => $app->push->publicKey()]);
        });

        /** PushSubscription.toJSON() from the browser, plus who it belongs to. */
        $r->add('POST', '/api/push/subscriptions', function (Request $req) use ($app, $repo): Response {
            $body = new Input($req->json());
            $endpoint = $body->string('endpoint', 1, 2048);
            if (filter_var($endpoint, FILTER_VALIDATE_URL) === false || !str_starts_with($endpoint, 'https://')) {
                throw new InvalidRequest('The push endpoint must be an https URL');
            }
            $keys = $body->object('keys');
            $p256dh = $keys->matching('p256dh', self::BASE64URL, required: true);
            $auth = $keys->matching('auth', self::BASE64URL, required: true);
            if (strlen($p256dh) > 200 || !WebPush::isValidPublicKey(Base64Url::decode($p256dh) ?? '')) {
                throw new InvalidRequest('Invalid p256dh key');
            }
            if (strlen($auth) > 200 || strlen(Base64Url::decode($auth) ?? '') !== 16) {
                throw new InvalidRequest('Invalid auth secret');
            }
            $device = $body->matching('device', '/^[\w-]{8,64}$/');
            $lang = $body->choice('lang', ['fr', 'en']);
            // Sent by the service worker when the browser renewed the subscription.
            $replaces = $body->optionalString('replaces', 2048);

            $app->push->checkOwner();
            $previous = $replaces !== null ? $repo->getPushSubscription($replaces) : null;
            $current = $repo->getPushSubscription($endpoint);
            $userKey = $req->viewer->key;
            $repo->transaction(function () use ($repo, $endpoint, $p256dh, $auth, $device, $lang, $replaces, $previous, $current, $userKey): void {
                if ($previous && $replaces !== $endpoint) {
                    $repo->deletePushSubscription($previous['endpoint']);
                }
                $repo->savePushSubscription([
                    'endpoint' => $endpoint,
                    'p256dh' => rtrim($p256dh, '='),
                    'auth' => rtrim($auth, '='),
                    'device' => $device ?? $previous['device'] ?? $current['device'] ?? null,
                    'lang' => $lang ?? $previous['lang'] ?? $current['lang'] ?? 'fr',
                    // Whoever signed in on the browser last gets its notifications.
                    'userKey' => $userKey,
                ]);
            });
            return Response::json(['ok' => true]);
        });

        $r->add('POST', '/api/push/unsubscribe', function (Request $req) use ($repo): Response {
            $endpoint = (new Input($req->json()))->string('endpoint', 0, 2048);
            return Response::json(['ok' => $repo->deletePushSubscription($endpoint)]);
        });

        $r->add('POST', '/api/push/test', function (Request $req) use ($app): Response {
            $endpoint = (new Input($req->json()))->string('endpoint', 0, 2048);
            $status = $app->push->sendTest($endpoint);
            if ($status === null) {
                throw new HttpError(404, 'not_subscribed');
            }
            if ($status === 0 || $status >= 300) {
                throw new HttpError(502, 'push_failed', ['status' => $status ?: null]);
            }
            return Response::json(['ok' => true]);
        });
    }
}
