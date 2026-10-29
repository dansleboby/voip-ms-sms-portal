<?php

declare(strict_types=1);

namespace SmsPortal\Routes;

use SmsPortal\App;
use SmsPortal\Http\HttpError;
use SmsPortal\Http\Input;
use SmsPortal\Http\Request;
use SmsPortal\Http\Response;
use SmsPortal\VoipMs\VoipMsApi;
use SmsPortal\VoipMs\VoipMsError;

/** server/routes/setup.ts */
final class SetupRoutes
{
    /** getIP works from any address (it only checks credentials); getBalance needs a whitelisted IP. */
    public static function testConnection(VoipMsApi $client): array
    {
        try {
            $ip = $client->getIP();
        } catch (\Throwable $e) {
            return ['ip' => null, 'status' => $e instanceof VoipMsError ? $e->errorCode : 'internal_error', 'balance' => null];
        }
        try {
            $balance = $client->getBalance();
            return ['ip' => $ip, 'status' => 'success', 'balance' => is_nan($balance) ? null : $balance];
        } catch (\Throwable $e) {
            return ['ip' => $ip, 'status' => $e instanceof VoipMsError ? $e->errorCode : 'internal_error', 'balance' => null];
        }
    }

    private static function client(App $app): VoipMsApi
    {
        return $app->client() ?? throw new HttpError(409, 'not_configured');
    }

    public static function register(App $app): void
    {
        $r = $app->router;

        $r->add('GET', '/api/setup/status', fn () => Response::json([
            'completed' => $app->isSetupCompleted(),
            'credentialsSource' => $app->credentials->source(),
            'username' => $app->credentials->get()['username'] ?? null,
        ]));

        /** Checks and stores credentials entered in the wizard, then reports whether the IP is allowed. */
        $r->add('POST', '/api/setup/credentials', function (Request $req) use ($app): Response {
            if ($app->credentials->source() === 'env') {
                throw new HttpError(409, 'credentials_from_env');
            }
            $body = new Input($req->json());
            $credentials = ['username' => $body->string('username', 3, 200, trim: true), 'password' => $body->string('password', 1, 200)];
            $result = self::testConnection($app->clientFor($credentials));
            if ($result['ip'] === null) {
                throw new HttpError(400, $result['status']);
            }
            $app->credentials->save($credentials);
            $app->resetClient();
            return Response::json($result);
        });

        $r->add('POST', '/api/setup/test', fn () => Response::json(self::testConnection(self::client($app))));

        /** Refreshes the numbers of every VoIP.ms account and returns them with their local names and colors. */
        $r->add('GET', '/api/setup/dids', function () use ($app): Response {
            self::client($app);
            $app->accounts->refreshDids();
            return Response::json($app->repo->listDids());
        });

        /** Queues the last `days` of history; progress shows in the sync status. */
        $r->add('POST', '/api/setup/import', function (Request $req) use ($app): Response {
            $days = (new Input($req->json()))->int('days', 0, 3650);
            self::client($app);
            if ($days > 0) {
                // The history of the account the wizard sets up.
                $sync = $app->accounts->primary()->sync;
                $sync->startImport($days);
                $app->defer(fn () => $sync->continueImport(microtime(true) + 20));
            }
            return Response::json(['ok' => true], 202);
        });

        $r->add('POST', '/api/setup/complete', function () use ($app): Response {
            self::client($app);
            $app->setSetupCompleted(true);
            $app->defer(function () use ($app): void {
                foreach ($app->accounts->all() as $account) {
                    $account->sync->syncRecent();
                }
            });
            return Response::json(['ok' => true]);
        });
    }
}
