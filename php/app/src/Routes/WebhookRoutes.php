<?php

declare(strict_types=1);

namespace SmsPortal\Routes;

use SmsPortal\Account;
use SmsPortal\App;
use SmsPortal\Http\HttpError;
use SmsPortal\Http\Input;
use SmsPortal\Http\InvalidRequest;
use SmsPortal\Http\Request;
use SmsPortal\Http\Response;

/** VoIP.ms calling back when texts arrive: turning it on and off, and the callback itself. */
final class WebhookRoutes
{
    public static function register(App $app): void
    {
        $r = $app->router;

        // The first account's unless another is asked for: the setup wizard sets up the first one.
        $r->admin('GET', '/api/webhook', fn (Request $req) => Response::json(
            self::account($app, isset($req->query['account']) ? Input::id((string) $req->query['account']) : null)->webhook->status(),
        ));

        $r->admin('POST', '/api/webhook/enable', function (Request $req) use ($app): Response {
            // Numbers whose callback to another address may be replaced.
            $replace = self::numbers(new Input($req->json()), 'replace');
            $status = $app->accounts->primary()->webhook->enable($req->header('origin'), $replace);
            $app->activity->record($req, 'webhook_enabled');
            return Response::json($status);
        });

        $r->admin('POST', '/api/webhook/disable', function (Request $req) use ($app): Response {
            $status = $app->accounts->primary()->webhook->disable();
            $app->activity->record($req, 'webhook_disabled');
            return Response::json($status);
        });

        /** Which numbers of an account VoIP.ms calls, and which go back to checks on a schedule. */
        $r->admin('POST', '/api/webhook/numbers', function (Request $req) use ($app): Response {
            $body = new Input($req->json());
            $account = self::account($app, $body->has('account') ? $body->int('account', 1) : null);
            $instant = self::numbers($body, 'instant');
            $regular = self::numbers($body, 'regular');
            $status = $account->webhook->setNumbers($req->header('origin'), $instant, $regular);
            $name = null;
            foreach ($app->accounts->list() as $listed) {
                if ($listed['id'] === $account->id) {
                    $name = $listed['label'] ?? $listed['username'];
                }
            }
            foreach ($instant as $did) {
                $app->activity->record($req, 'webhook_enabled', $name, ['did' => $did]);
            }
            foreach ($regular as $did) {
                $app->activity->record($req, 'webhook_disabled', $name, ['did' => $did]);
            }
            return Response::json($status);
        });

        /**
         * VoIP.ms's call for a text one of the numbers received. Public: the secret
         * is in the address. "ok" tells VoIP.ms not to call again for that text;
         * the check of VoIP.ms runs after the answer.
         */
        $r->add('GET', '/api/voipms/callback/{token}', function (Request $req) use ($app): Response {
            if (!$app->accounts->receive($req->param('token'))) {
                throw new HttpError(404, 'not_found');
            }
            return new Response(200, ['Content-Type' => 'text/plain; charset=utf-8'], 'ok');
        }, public: true);
    }

    /** The account a request names; the first one when it names none. */
    private static function account(App $app, ?int $id): Account
    {
        return $id === null ? $app->accounts->primary() : ($app->accounts->get($id) ?? throw new HttpError(404, 'not_found'));
    }

    /** @return list<string> 10-digit numbers, from an optional list. */
    private static function numbers(Input $body, string $key): array
    {
        $numbers = $body->has($key) ? $body->stringList($key, 0, 1000) : [];
        foreach ($numbers as $did) {
            if (!preg_match('/^\d{10}$/', $did)) {
                throw new InvalidRequest("$key: expected 10-digit numbers");
            }
        }
        return $numbers;
    }
}
