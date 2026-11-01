<?php

declare(strict_types=1);

namespace SmsPortal\Routes;

use SmsPortal\App;
use SmsPortal\Http\Input;
use SmsPortal\Http\Request;
use SmsPortal\Http\Response;

/** New releases, and installing them where the server can replace its own files (not in Docker). */
final class UpdateRoutes
{
    public static function register(App $app): void
    {
        /** The newest release and how to install it; ?refresh=1 asks GitHub now. */
        $app->router->admin('GET', '/api/update', function (Request $req) use ($app): Response {
            $refresh = (new Input($req->query))->choice('refresh', ['0', '1']) === '1';
            return Response::json($app->updates->status($refresh));
        });

        /** Replaces this server's files with the newest release; the next request runs it. */
        $app->router->admin('POST', '/api/update/install', function (Request $req) use ($app): Response {
            // Loaded before its file is replaced.
            class_exists(Response::class);
            $version = $app->updates->install();
            $app->activity->record($req, 'update_installed', $version);
            return Response::json(['version' => $version]);
        });
    }
}
