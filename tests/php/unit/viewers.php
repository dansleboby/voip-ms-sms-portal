<?php

// What each person sees of the database (Repo::forViewer), and who they are (Auth).

declare(strict_types=1);

require __DIR__ . '/../harness.php';

use SmsPortal\Auth;
use SmsPortal\Db;
use SmsPortal\Repo;
use SmsPortal\Time;
use SmsPortal\Viewer;

const MONTREAL = '5145550100';
const LAVAL = '4505550199';
const GATINEAU = '8195550123';

/** A conversation on $did with one incoming text, unread. */
function conversationOn(Repo $repo, string $did, string $phone): int
{
    $repo->ensureDid($did);
    $id = $repo->getOrCreateConversation($did, $phone);
    incoming($repo, $id, Time::nowMs());
    return $id;
}

/** A text received at $at; new ones count as unread, those of a history import do not. */
function incoming(Repo $repo, int $conversationId, int $at, bool $new = true): int
{
    $id = $repo->insertMessage([
        'conversationId' => $conversationId,
        'kind' => 'sms',
        'remoteId' => null,
        'direction' => 'in',
        'body' => 'Allô',
        'sentAt' => $at,
        'status' => 'received',
    ]);
    $repo->touchConversation($conversationId, $new ? 1 : 0);
    if ($new) {
        $repo->unarchiveConversation($conversationId);
    }
    return $id;
}

function unread(Repo $repo, int $conversationId): ?int
{
    return $repo->getConversation($conversationId)['unreadCount'] ?? null;
}

test('shows a user the numbers given to them only, within those of the configuration', function (): void {
    $repo = new Repo(Db::open(tempDir() . '/portal.db'), [MONTREAL, LAVAL]);
    $montreal = conversationOn($repo, MONTREAL, '4385550142');
    $laval = conversationOn($repo, LAVAL, '4505550111');
    conversationOn($repo, GATINEAU, '8195550111');

    $user = $repo->forViewer(new Viewer(5, [LAVAL => false, GATINEAU => true]));
    assertSame([[LAVAL, false]], array_map(static fn (array $d) => [$d['did'], $d['canSend']], $user->listDids()));
    assertSame([$laval], array_column($user->listConversations(), 'id'));
    assertSame(null, $user->getConversation($montreal));
    assertSame($laval, $user->getConversation($laval)['id'] ?? null);

    $owner = $repo->forViewer(new Viewer(Viewer::OWNER));
    assertSame([MONTREAL, LAVAL], array_column($owner->listDids(), 'did'));
    assertSame([true, true], array_column($owner->listDids(), 'canSend'));
    // Nobody: no number at all.
    assertSame([], $repo->forViewer(new Viewer(6, []))->listDids());
});

test('shares unread counts and archives by default', function (): void {
    $repo = freshRepo();
    $id = conversationOn($repo, MONTREAL, '4385550142');
    $owner = $repo->forViewer(new Viewer(Viewer::OWNER));
    $user = $repo->forViewer(new Viewer(5, [MONTREAL => true]));
    assertTrue($user->markConversationRead($id));
    assertSame(0, unread($owner, $id));
    $owner->setArchived($id, true);
    assertTrue($user->getConversation($id)['archived']);
    assertSame(0, (int) $repo->run('SELECT COUNT(*) FROM conversation_states')->fetchColumn());
});

test('keeps them per person on a number set so, each starting from the shared ones', function (): void {
    $repo = freshRepo();
    $id = conversationOn($repo, MONTREAL, '4385550142');
    assertTrue($repo->updateDid(MONTREAL, ['sharedState' => false]));
    assertFalse($repo->getDid(MONTREAL)['sharedState']);
    $owner = $repo->forViewer(new Viewer(Viewer::OWNER));
    $user = $repo->forViewer(new Viewer(5, [MONTREAL => true]));
    assertSame(1, unread($owner, $id));
    assertSame(1, unread($user, $id));

    assertTrue($user->markConversationRead($id));
    assertFalse($user->markConversationRead($id), 'nothing left to read');
    assertSame(0, unread($user, $id));
    assertSame(1, unread($owner, $id));
    assertSame(0, $user->listDids()[0]['unreadCount']);
    assertSame(1, $owner->listDids()[0]['unreadCount']);

    Time::travelTo(Time::nowMs() + 60_000);
    incoming($repo, $id, Time::nowMs());
    assertSame(1, unread($user, $id));
    assertSame(2, unread($owner, $id));
    // Older texts a history import brings in are no news.
    incoming($repo, $id, Time::nowMs() - 3_600_000, new: false);
    assertSame(1, unread($user, $id));

    $owner->setArchived($id, true);
    assertTrue($owner->getConversation($id)['archived']);
    assertFalse($user->getConversation($id)['archived']);
    assertFalse($repo->getConversation($id)['archived'], 'the shared archive');
    assertSame([], $owner->listConversations());
    // A new text brings it back for everyone.
    incoming($repo, $id, Time::nowMs() + 1000);
    assertFalse($owner->getConversation($id)['archived']);
});

test('counts nothing as unread for a user given such a number afterwards', function (): void {
    $repo = freshRepo();
    $id = conversationOn($repo, MONTREAL, '4385550142');
    $repo->updateDid(MONTREAL, ['sharedState' => false]);
    incoming($repo, $id, Time::nowMs() + 1000);
    $userId = $repo->createUser('marc@example.com', null, 'hash', 'user');
    $repo->setUserNumbers($userId, [['did' => MONTREAL, 'canSend' => true]]);
    $user = $repo->forViewer(new Viewer($userId, $repo->userNumbers($userId)));
    assertSame(0, unread($user, $id));
    assertSame(2, unread($repo->forViewer(new Viewer(Viewer::OWNER)), $id));
    incoming($repo, $id, Time::nowMs() + 2000);
    assertSame(1, unread($user, $id));
    // Changing what they may do with it keeps what they read.
    $repo->setUserNumbers($userId, [['did' => MONTREAL, 'canSend' => false]]);
    assertSame(1, unread($user, $id));
});

test('counts what someone read as read when the number is shared again', function (): void {
    $repo = freshRepo();
    $id = conversationOn($repo, MONTREAL, '4385550142');
    $repo->updateDid(MONTREAL, ['sharedState' => false]);
    $repo->forViewer(new Viewer(5, [MONTREAL => true]))->markConversationRead($id);
    Time::travelTo(Time::nowMs() + 60_000);
    incoming($repo, $id, Time::nowMs());
    $repo->forViewer(new Viewer(Viewer::OWNER))->setArchived($id, true);

    $repo->updateDid(MONTREAL, ['sharedState' => true]);
    $owner = $repo->forViewer(new Viewer(Viewer::OWNER));
    assertSame(1, unread($owner, $id));
    assertFalse($owner->getConversation($id)['archived'], 'the shared archive again');
    assertSame(0, (int) $repo->run('SELECT COUNT(*) FROM conversation_states')->fetchColumn());
});

test('says who sent a text: a user, the owner, or nobody known', function (): void {
    $repo = freshRepo();
    $repo->ensureDid(MONTREAL);
    $conversation = $repo->getOrCreateConversation(MONTREAL, '4385550142');
    $sent = static fn (?array $sentBy) => $repo->getMessage($repo->insertMessage([
        'conversationId' => $conversation, 'kind' => 'sms', 'remoteId' => null, 'direction' => 'out',
        'body' => 'Salut', 'sentAt' => Time::nowMs(), 'status' => 'sent', 'sentBy' => $sentBy,
    ]))['sentBy'];
    assertSame(['userId' => 5, 'name' => 'Marc'], $sent(['key' => 5, 'name' => 'Marc']));
    assertSame(['userId' => null, 'name' => null], $sent(['key' => Viewer::OWNER, 'name' => null]));
    assertSame(null, $sent(null));
});

test('forgets what a deleted user read, and their browsers', function (): void {
    $repo = freshRepo();
    $id = conversationOn($repo, MONTREAL, '4385550142');
    $repo->updateDid(MONTREAL, ['sharedState' => false]);
    $userId = $repo->createUser('marc@example.com', null, 'hash', 'user');
    $repo->forViewer(new Viewer($userId, [MONTREAL => true]))->markConversationRead($id);
    $repo->savePushSubscription(['endpoint' => 'https://push.example.net/1', 'p256dh' => 'k', 'auth' => 'a', 'device' => null, 'lang' => 'fr', 'userKey' => $userId]);
    $repo->savePushSubscription(['endpoint' => 'https://push.example.net/2', 'p256dh' => 'k', 'auth' => 'a', 'device' => null, 'lang' => 'fr']);
    assertTrue($repo->deleteUser($userId));
    assertSame(0, (int) $repo->run('SELECT COUNT(*) FROM conversation_states')->fetchColumn());
    assertSame([Viewer::OWNER], array_column($repo->listPushSubscriptions(), 'user_key'));
});

test('knows what each person sees from who they are', function (): void {
    $repo = freshRepo();
    $auth = new Auth($repo, 'pw', 30);
    $userId = $repo->createUser('marc@example.com', null, 'hash', 'user');
    $adminId = $repo->createUser('julie@example.com', null, 'hash', 'admin');
    $repo->setUserNumbers($userId, [['did' => MONTREAL, 'canSend' => false]]);

    assertSame(null, $auth->viewerForKey(Viewer::OWNER)?->dids());
    assertSame(Viewer::OWNER, $auth->viewerForKey(Viewer::OWNER)?->key);
    // Users only sign in in the Team mode.
    assertSame(null, $auth->viewerForKey($userId));
    $repo->setSetting(Auth::TEAM_KEY, '1');
    $user = $auth->viewerForKey($userId);
    assertSame([MONTREAL], $user?->dids());
    assertTrue($user->sees(MONTREAL));
    assertFalse($user->canSend(MONTREAL));
    assertFalse($user->sees(LAVAL));
    assertSame(null, $auth->viewerForKey($adminId)?->dids(), 'admins see every number');
    assertTrue($auth->viewerForKey($adminId)->canSend(LAVAL));
    $repo->updateUser($userId, ['disabled' => true]);
    assertSame(null, $auth->viewerForKey($userId));
    assertSame(null, $auth->viewerForKey(99));
});
