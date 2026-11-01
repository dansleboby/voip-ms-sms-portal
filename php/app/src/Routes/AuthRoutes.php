<?php

declare(strict_types=1);

namespace SmsPortal\Routes;

use SmsPortal\App;
use SmsPortal\Auth;
use SmsPortal\Http\HttpError;
use SmsPortal\Http\Input;
use SmsPortal\Http\Request;
use SmsPortal\Http\Response;
use SmsPortal\Passwords;
use SmsPortal\Time;

/** The session, signing in and out. */
final class AuthRoutes
{
    private const LOGIN_ATTEMPTS_PER_MINUTE = 10;

    public static function register(App $app): void
    {
        $r = $app->router;

        $r->add('GET', '/api/health', fn () => Response::json(['ok' => true]), public: true);

        $r->add('GET', '/api/session', function (Request $req) use ($app): Response {
            $user = $req->user;
            $authenticated = $user !== null;
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
                // Tabs opened before 2.0, from the Docker image's Node server, would otherwise open an event stream.
                'liveUpdates' => 'poll',
                'didsRestricted' => $app->config->allowedDids !== null || $app->config->excludedDids !== [],
                'mode' => $app->auth->mode(),
                'user' => $user === null ? null : ['id' => $user['userId'], 'email' => $user['email'], 'name' => $user['name'], 'role' => $user['role']],
            ]);
        }, public: true);

        $r->add('POST', '/api/auth/login', function (Request $req) use ($app): Response {
            self::limitAttempts($app, $req->ip);
            // No email: the owner's APP_PASSWORD. With an email: a user of the Team mode.
            $body = new Input($req->json());
            $password = $body->string('password', 0, 1000);
            $email = $body->has('email') ? strtolower(trim($body->string('email', 0, 254))) : '';
            $userId = null;
            $who = ['userId' => null, 'email' => null, 'name' => null];
            if ($email !== '') {
                $user = $app->auth->mode() === 'team' ? $app->repo->findUserByEmail($email) : null;
                // Compared against something even when nobody has that email, so that the answer takes as long.
                $ok = Passwords::verify($password, $user['password_hash'] ?? self::missingUserHash());
                if ($user === null || !$ok || $user['disabled_at'] !== null) {
                    $app->activity->recordAs(null, $req, 'sign_in_failed', $email);
                    throw new HttpError(401, 'wrong_password');
                }
                $userId = $user['id'];
                $who = ['userId' => $user['id'], 'email' => $user['email'], 'name' => $user['name']];
            } elseif (!$app->auth->checkPassword($password)) {
                $app->activity->recordAs(null, $req, 'sign_in_failed');
                throw new HttpError(401, 'wrong_password');
            }
            $app->activity->recordAs($who, $req, 'sign_in', $req->header('user-agent'));
            return self::signIn($app, $req, Response::json(['ok' => true]), $userId);
        }, public: true);

        $r->add('POST', '/api/auth/logout', function (Request $req) use ($app): Response {
            if ($req->user !== null) {
                $app->auth->close($req->user['sessionId']);
            }
            return Response::json(['ok' => true])->cookie(Auth::COOKIE, '', ['path' => '/', 'maxAge' => 0]);
        }, public: true);
    }

    /** Adds the session cookie of a new sign-in (null: the owner). */
    public static function signIn(App $app, Request $req, Response $response, ?int $userId): Response
    {
        return $response->cookie(Auth::COOKIE, $app->auth->open($userId, $req->header('user-agent')), [
            'path' => '/',
            'httpOnly' => true,
            'sameSite' => 'Lax',
            'secure' => $req->https || str_starts_with($app->config->publicOrigin ?? '', 'https:'),
            'maxAge' => $app->auth->maxAgeSeconds(),
        ]);
    }

    private static function missingUserHash(): string
    {
        return 'pbkdf2-sha256$' . Passwords::ITERATIONS . '$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
    }

    /** Ten sign-in attempts a minute per address. */
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
