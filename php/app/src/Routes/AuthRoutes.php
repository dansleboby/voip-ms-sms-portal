<?php

declare(strict_types=1);

namespace SmsPortal\Routes;

use SmsPortal\App;
use SmsPortal\Auth;
use SmsPortal\Http\HttpError;
use SmsPortal\Http\Input;
use SmsPortal\Http\Request;
use SmsPortal\Http\Response;
use SmsPortal\Time;

/** server/routes/auth.ts */
final class AuthRoutes
{
    private const LOGIN_ATTEMPTS_PER_MINUTE = 10;

    public static function register(App $app): void
    {
        $r = $app->router;

        $r->add('GET', '/api/health', fn () => Response::json(['ok' => true]), public: true);

        $r->add('GET', '/api/session', function (Request $req) use ($app): Response {
            $authenticated = $app->signedIn($req);
            // Reading stored credentials costs a key derivation: not for whoever asks.
            $credentialsReadable = $authenticated ? $app->credentials->get() !== null : $app->credentials->present();
            return Response::json([
                'authenticated' => $authenticated,
                // Unreadable credentials (APP_PASSWORD changed) send the user back to the wizard.
                'setupCompleted' => $app->isSetupCompleted() && $credentialsReadable,
                'credentialsSource' => $app->credentials->source(verify: $authenticated),
                'demo' => $app->config->demo,
                'version' => $app->version,
                'pollActiveSeconds' => (int) round($app->config->pollActiveMs / 1000),
                'pollIdleSeconds' => (int) round($app->config->pollIdleMs / 1000),
                // A PHP request cannot hold a stream open.
                'liveUpdates' => 'poll',
                'didsRestricted' => $app->config->allowedDids !== null || $app->config->excludedDids !== [],
            ]);
        }, public: true);

        $r->add('POST', '/api/auth/login', function (Request $req) use ($app): Response {
            self::limitAttempts($app, $req->ip);
            $password = (new Input($req->json()))->string('password', 0, 1000);
            if (!$app->auth->checkPassword($password)) {
                throw new HttpError(401, 'wrong_password');
            }
            return Response::json(['ok' => true])->cookie(Auth::COOKIE, $app->auth->issue(), [
                'path' => '/',
                'httpOnly' => true,
                'sameSite' => 'Lax',
                'secure' => $req->https || str_starts_with($app->config->publicOrigin ?? '', 'https:'),
                'maxAge' => $app->auth->maxAgeSeconds(),
            ]);
        }, public: true);

        $r->add('POST', '/api/auth/logout', fn () => Response::json(['ok' => true])
            ->cookie(Auth::COOKIE, '', ['path' => '/', 'maxAge' => 0]), public: true);
    }

    /** Ten sign-in attempts a minute per address, like the Docker version. */
    private static function limitAttempts(App $app, string $ip): void
    {
        $repo = $app->repo;
        $now = Time::nowMs();
        $repo->run('DELETE FROM login_attempts WHERE at < ?', [$now - 60_000]);
        if ((int) $repo->run('SELECT COUNT(*) FROM login_attempts WHERE ip = ?', [$ip])->fetchColumn() >= self::LOGIN_ATTEMPTS_PER_MINUTE) {
            throw new HttpError(429, 'rate_limited');
        }
        $repo->run('INSERT INTO login_attempts (ip, at) VALUES (?, ?)', [$ip, $now]);
    }
}
