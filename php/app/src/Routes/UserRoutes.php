<?php

declare(strict_types=1);

namespace SmsPortal\Routes;

use SmsPortal\App;
use SmsPortal\Auth;
use SmsPortal\Http\HttpError;
use SmsPortal\Http\Input;
use SmsPortal\Http\InvalidRequest;
use SmsPortal\Http\Request;
use SmsPortal\Http\Response;
use SmsPortal\Passwords;
use SmsPortal\Repo;

/**
 * The Team mode (server/routes/users.ts): the owner turns it on by creating
 * the first admin, admins manage the users and the numbers each one texts
 * from, and everyone sees and ends their own sessions.
 */
final class UserRoutes
{
    /** Long enough to resist guessing at the sign-in rate limit; nothing more is asked. */
    private const MIN_PASSWORD_LENGTH = 8;
    /** What a session list shows of a session's id: enough to tell them apart, not to sign in. */
    private const PUBLIC_ID_LENGTH = 16;

    public static function register(App $app): void
    {
        $r = $app->router;
        $repo = $app->repo;

        $teamOnly = static function () use ($app): void {
            if ($app->auth->mode() !== 'team') {
                throw new HttpError(409, 'team_mode_off');
            }
        };

        /** Turns the Team mode on, for good, with the first admin. Only the owner can. */
        $r->add('POST', '/api/team', function (Request $req) use ($app, $repo): Response {
            if (($req->user['role'] ?? null) !== 'owner') {
                throw new HttpError(403, 'forbidden');
            }
            if ($app->auth->mode() === 'team') {
                throw new HttpError(409, 'team_mode_on');
            }
            $body = new Input($req->json());
            $id = $repo->createUser(self::email($body), self::name($body), Passwords::hash(self::password($body, 'password')), 'admin');
            $repo->setSetting(Auth::TEAM_KEY, '1');
            return Response::json($repo->getUser($id), 201);
        });

        $r->add('GET', '/api/users', function () use ($repo, $teamOnly): Response {
            $teamOnly();
            return Response::json($repo->listUsers());
        }, admin: true);

        $r->add('POST', '/api/users', function (Request $req) use ($repo, $teamOnly): Response {
            $teamOnly();
            $body = new Input($req->json());
            $email = self::email($body);
            $name = self::name($body);
            $password = self::password($body, 'password');
            $role = $body->choice('role', ['admin', 'user']) ?? throw new InvalidRequest('role: required');
            $numbers = self::numbers($body, $repo);
            if ($repo->findUserByEmail($email) !== null) {
                throw new HttpError(409, 'email_taken');
            }
            $id = $repo->createUser($email, $name, Passwords::hash($password), $role);
            if ($numbers !== null) {
                $repo->setUserNumbers($id, $numbers);
            }
            return Response::json($repo->getUser($id), 201);
        }, admin: true);

        $r->add('PATCH', '/api/users/{id}', function (Request $req) use ($repo, $teamOnly): Response {
            $teamOnly();
            $id = Input::id($req->param('id'));
            $body = new Input($req->json());
            if ($repo->getUserRow($id) === null) {
                throw new HttpError(404, 'not_found');
            }
            $patch = [];
            if ($body->has('name')) {
                $patch['name'] = self::name($body);
            }
            if ($body->has('role')) {
                $patch['role'] = $body->choice('role', ['admin', 'user']);
            }
            if ($body->has('disabled')) {
                $patch['disabled'] = $body->bool('disabled');
            }
            $password = $body->has('password') ? self::password($body, 'password') : null;
            $numbers = self::numbers($body, $repo);
            // An admin cannot lock themselves out; the owner (APP_PASSWORD) always can get back in anyway.
            if ($id === $req->user['userId'] && (($patch['disabled'] ?? false) || ($patch['role'] ?? null) === 'user')) {
                throw new HttpError(409, 'cannot_change_self');
            }
            if ($password !== null) {
                $patch['passwordHash'] = Passwords::hash($password);
            }
            $repo->updateUser($id, $patch);
            if ($numbers !== null) {
                $repo->setUserNumbers($id, $numbers);
            }
            // A new password, or no access at all: their other browsers are signed out.
            if ($password !== null || ($patch['disabled'] ?? false)) {
                $repo->deleteUserSessions($id, $id === $req->user['userId'] ? $req->user['sessionId'] : null);
            }
            return Response::json($repo->getUser($id));
        }, admin: true);

        $r->add('DELETE', '/api/users/{id}', function (Request $req) use ($repo, $teamOnly): Response {
            $teamOnly();
            $id = Input::id($req->param('id'));
            if ($id === $req->user['userId']) {
                throw new HttpError(409, 'cannot_change_self');
            }
            if (!$repo->deleteUser($id)) {
                throw new HttpError(404, 'not_found');
            }
            return Response::json(['ok' => true]);
        }, admin: true);

        /** A user's own name and password. The owner's password is APP_PASSWORD, set on the server. */
        $r->add('PATCH', '/api/me', function (Request $req) use ($repo): Response {
            $userId = $req->user['userId'];
            if ($userId === null) {
                throw new HttpError(409, 'owner_has_no_account');
            }
            $body = new Input($req->json());
            $patch = [];
            if ($body->has('name')) {
                $patch['name'] = self::name($body);
            }
            if ($body->has('password')) {
                $password = $body->object('password');
                if (!Passwords::verify($password->string('current', 0, 1000), $repo->getUserRow($userId)['password_hash'])) {
                    throw new HttpError(400, 'wrong_password');
                }
                $patch['passwordHash'] = Passwords::hash(self::password($password, 'next'));
            }
            $repo->updateUser($userId, $patch);
            if (isset($patch['passwordHash'])) {
                $repo->deleteUserSessions($userId, $req->user['sessionId']);
            }
            return Response::json($repo->getUser($userId));
        });

        $r->add('GET', '/api/sessions', fn (Request $req) => Response::json(array_map(static fn (array $row) => [
            'id' => substr($row['id'], 0, self::PUBLIC_ID_LENGTH),
            'createdAt' => $row['created_at'],
            'lastSeenAt' => $row['last_seen_at'],
            'userAgent' => $row['user_agent'],
            'current' => $row['id'] === $req->user['sessionId'],
        ], $repo->listSessions($req->user['userId']))));

        /** Signs one of the user's own browsers out. */
        $r->add('DELETE', '/api/sessions/{id}', function (Request $req) use ($app, $repo): Response {
            $id = $req->param('id');
            foreach ($repo->listSessions($req->user['userId']) as $row) {
                if (substr($row['id'], 0, self::PUBLIC_ID_LENGTH) === $id) {
                    $app->auth->close($row['id']);
                    return Response::json(['ok' => true]);
                }
            }
            throw new HttpError(404, 'not_found');
        });
    }

    private static function email(Input $body): string
    {
        $email = strtolower(trim($body->string('email', 3, 254)));
        if (!preg_match('/^[^@\s]+@[^@\s]+\.[^@\s]+$/', $email)) {
            throw new InvalidRequest('email: expected an email address');
        }
        return $email;
    }

    private static function name(Input $body): ?string
    {
        $name = $body->nullableString('name', 200);
        $name = $name === null ? null : trim($name);
        if ($name !== null && mb_strlen($name) > 80) {
            throw new InvalidRequest('name: at most 80 characters');
        }
        return $name === '' ? null : $name;
    }

    private static function password(Input $body, string $key): string
    {
        return $body->string($key, self::MIN_PASSWORD_LENGTH, 1000);
    }

    /**
     * The "numbers" of a request, if given: existing numbers only.
     *
     * @return ?list<array{did: string, canSend: bool}>
     */
    private static function numbers(Input $body, Repo $repo): ?array
    {
        if (!$body->has('numbers')) {
            return null;
        }
        $raw = $body->raw('numbers');
        if (!is_array($raw) || !array_is_list($raw) || count($raw) > 1000) {
            throw new InvalidRequest('numbers: expected a list');
        }
        $numbers = [];
        $unknown = [];
        foreach ($raw as $item) {
            if (!is_array($item) || !is_string($item['did'] ?? null) || !preg_match('/^\d{10}$/', $item['did']) || !is_bool($item['canSend'] ?? null)) {
                throw new InvalidRequest('numbers: expected {did, canSend} items');
            }
            if ($repo->getDid($item['did']) === null) {
                $unknown[] = $item['did'];
            }
            $numbers[] = ['did' => $item['did'], 'canSend' => $item['canSend']];
        }
        if ($unknown) {
            throw new HttpError(400, 'unknown_did', ['dids' => $unknown]);
        }
        return $numbers;
    }
}
