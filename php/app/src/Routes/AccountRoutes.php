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
 * The VoIP.ms accounts the portal uses. The first
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
            $credentials = self::credentials($app, $body, null);
            $connection = self::check($app, $credentials, null);
            $id = $app->accounts->add($label, $credentials)->id;
            $app->activity->record($req, 'account_added', $label ?? $credentials['username']);
            // Its numbers, when VoIP.ms already lets this server in; otherwise with a later check.
            self::refreshDids($app, $connection);
            return Response::json(['account' => self::find($app, $id), 'connection' => $connection], 201);
        });

        $r->admin('PATCH', '/api/accounts/{id}', function (Request $req) use ($app): Response {
            $id = Input::id($req->param('id'));
            $label = (new Input($req->json()))->nullableString('label', 60);
            if (!$app->repo->updateAccount($id, $label)) {
                throw new HttpError(404, 'not_found');
            }
            $account = self::find($app, $id);
            $app->activity->record($req, 'account_changed', $account['label'] ?? $account['username'], ['changes' => ['label']]);
            return Response::json($account);
        });

        /** New credentials for an account (after a new API password), checked like a new account's. */
        $r->admin('PUT', '/api/accounts/{id}/credentials', function (Request $req) use ($app): Response {
            $id = Input::id($req->param('id'));
            $account = $app->accounts->get($id) ?? throw new HttpError(404, 'not_found');
            if ($app->credentials->source(accountId: $id) === 'env') {
                throw new HttpError(409, 'credentials_env');
            }
            $credentials = self::credentials($app, new Input($req->json()), $id);
            $connection = self::check($app, $credentials, $id);
            $app->credentials->save($credentials, $id);
            $account->resetClient();
            self::refreshDids($app, $connection);
            $found = self::find($app, $id);
            $app->activity->record($req, 'account_changed', $found['label'] ?? $found['username'], ['changes' => ['credentials']]);
            return Response::json(['account' => $found, 'connection' => $connection]);
        });

        /** Whether VoIP.ms lets this server in with the account's credentials (the IP to allow otherwise); fetches its numbers when it does. */
        $r->admin('POST', '/api/accounts/{id}/test', function (Request $req) use ($app): Response {
            $id = Input::id($req->param('id'));
            $client = ($app->accounts->get($id) ?? throw new HttpError(404, 'not_found'))->client() ?? throw new HttpError(409, 'not_configured');
            $connection = SetupRoutes::testConnection($client);
            self::refreshDids($app, $connection);
            return Response::json(['account' => self::find($app, $id), 'connection' => $connection]);
        });
    }

    /** The username and API password of a request; 409 when another account has that username. */
    private static function credentials(App $app, Input $body, ?int $exceptId): array
    {
        $credentials = ['username' => $body->string('username', 3, 200, trim: true), 'password' => $body->string('password', 1, 200)];
        foreach ($app->accounts->list() as $account) {
            if ($account['id'] !== $exceptId && $account['username'] !== null && strcasecmp($account['username'], $credentials['username']) === 0) {
                throw new HttpError(409, 'account_exists');
            }
        }
        return $credentials;
    }

    /** Asks VoIP.ms about the credentials: 400 when it refuses them outright (not only this server's IP). */
    private static function check(App $app, array $credentials, ?int $accountId): array
    {
        $connection = SetupRoutes::testConnection($app->clientFor($credentials, $accountId ?? count($app->accounts->all()) + 1));
        if ($connection['ip'] === null) {
            throw new HttpError(400, $connection['status']);
        }
        return $connection;
    }

    private static function refreshDids(App $app, array $connection): void
    {
        if ($connection['status'] !== 'success') {
            return;
        }
        try {
            $app->accounts->refreshDids();
        } catch (VoipMsError $e) {
            Log::warn('Numbers not refreshed', ['err' => $e]);
        }
    }

    private static function find(App $app, int $id): array
    {
        foreach ($app->accounts->list() as $account) {
            if ($account['id'] === $id) {
                return $account;
            }
        }
        throw new HttpError(404, 'not_found');
    }
}
