<?php

declare(strict_types=1);

namespace SmsPortal\Routes;

use SmsPortal\App;
use SmsPortal\Http\HttpError;
use SmsPortal\Http\Input;
use SmsPortal\Http\Request;
use SmsPortal\Http\Response;
use SmsPortal\Log;
use SmsPortal\VoipMs\VoipMsError;

/**
 * The VoIP.ms accounts the portal uses (server/routes/accounts.ts). The first
 * one comes from the setup wizard; the others are added here (an agency keeps
 * one per client).
 */
final class AccountRoutes
{
    public static function register(App $app): void
    {
        $r = $app->router;

        $r->admin('GET', '/api/accounts', fn () => Response::json($app->accounts->list()));

        /** Checks the credentials, keeps them encrypted like the first account's, and fetches the account's numbers. */
        $r->admin('POST', '/api/accounts', function (Request $req) use ($app): Response {
            $body = new Input($req->json());
            $label = $body->has('label') ? $body->nullableString('label', 60) : null;
            $credentials = ['username' => $body->string('username', 3, 200, trim: true), 'password' => $body->string('password', 1, 200)];
            foreach ($app->accounts->list() as $account) {
                if ($account['username'] !== null && strcasecmp($account['username'], $credentials['username']) === 0) {
                    throw new HttpError(409, 'account_exists');
                }
            }
            $connection = SetupRoutes::testConnection($app->clientFor($credentials));
            if ($connection['ip'] === null) {
                throw new HttpError(400, $connection['status']);
            }
            $id = $app->accounts->add($label, $credentials)->id;
            // Its numbers, when VoIP.ms already lets this server in; otherwise with a later refresh.
            if ($connection['status'] === 'success') {
                try {
                    $app->accounts->refreshDids();
                } catch (VoipMsError $e) {
                    Log::warn('Numbers not refreshed', ['err' => $e]);
                }
            }
            foreach ($app->accounts->list() as $account) {
                if ($account['id'] === $id) {
                    return Response::json(['account' => $account, 'connection' => $connection], 201);
                }
            }
            throw new HttpError(500, 'internal_error');
        });

        $r->admin('PATCH', '/api/accounts/{id}', function (Request $req) use ($app): Response {
            $id = Input::id($req->param('id'));
            $label = (new Input($req->json()))->nullableString('label', 60);
            if (!$app->repo->updateAccount($id, $label)) {
                throw new HttpError(404, 'not_found');
            }
            foreach ($app->accounts->list() as $account) {
                if ($account['id'] === $id) {
                    return Response::json($account);
                }
            }
            throw new HttpError(404, 'not_found');
        });
    }
}
