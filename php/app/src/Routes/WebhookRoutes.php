<?php

declare(strict_types=1);

namespace SmsPortal\Routes;

use SmsPortal\App;
use SmsPortal\Http\HttpError;
use SmsPortal\Http\Input;
use SmsPortal\Http\InvalidRequest;
use SmsPortal\Http\Request;
use SmsPortal\Http\Response;

/** server/routes/webhook.ts */
final class WebhookRoutes
{
    public static function register(App $app): void
    {
        $r = $app->router;

        $r->add('GET', '/api/webhook', fn () => Response::json($app->webhook->status()));

        $r->add('POST', '/api/webhook/enable', function (Request $req) use ($app): Response {
            $body = new Input($req->json());
            // Numbers whose callback to another address may be replaced.
            $replace = $body->has('replace') ? $body->stringList('replace', 0, 1000) : [];
            foreach ($replace as $did) {
                if (!preg_match('/^\d{10}$/', $did)) {
                    throw new InvalidRequest('replace: expected 10-digit numbers');
                }
            }
            return Response::json($app->webhook->enable($req->header('origin'), $replace));
        });

        $r->add('POST', '/api/webhook/disable', fn () => Response::json($app->webhook->disable()));

        /**
         * VoIP.ms's call for a text one of the numbers received. Public: the secret
         * is in the address. "ok" tells VoIP.ms not to call again for that text;
         * the check of VoIP.ms runs after the answer.
         */
        $r->add('GET', '/api/voipms/callback/{token}', function (Request $req) use ($app): Response {
            if (!$app->webhook->receive($req->param('token'))) {
                throw new HttpError(404, 'not_found');
            }
            return new Response(200, ['Content-Type' => 'text/plain; charset=utf-8'], 'ok');
        }, public: true);
    }
}
