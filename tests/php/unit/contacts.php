<?php

// Address books: each person's own, and those of the numbers.

declare(strict_types=1);

require __DIR__ . '/../harness.php';

use SmsPortal\Db;
use SmsPortal\Repo;
use SmsPortal\Time;
use SmsPortal\Viewer;

const MONTREAL = '5145550100';
const LAVAL = '4505550199';
const MARIE = '4385550142';

/** A conversation on $did with $phone, with one text in it. */
function conversationWith(Repo $repo, string $did, string $phone): int
{
    $repo->ensureDid($did);
    $id = $repo->getOrCreateConversation($did, $phone);
    $repo->insertMessage(['conversationId' => $id, 'kind' => 'sms', 'remoteId' => null, 'direction' => 'in', 'body' => 'Allô', 'sentAt' => Time::nowMs(), 'status' => 'received']);
    $repo->touchConversation($id);
    return $id;
}

function nameIn(Repo $repo, int $conversationId): ?string
{
    return $repo->getConversation($conversationId)['contact']['name'] ?? null;
}

function numbers(string ...$dids): array
{
    return ['kind' => 'numbers', 'dids' => $dids];
}

test('keeps the contacts of 1.x in every number’s book, phones in their order', function (): void {
    $file = tempDir() . '/portal.db';
    $db = Db::open($file, 14);
    Db::run($db, "INSERT INTO contacts (id, name, created_at, updated_at) VALUES (1, 'Marie Tremblay', 0, 0)");
    Db::run($db, "INSERT INTO contact_phones (phone, contact_id) VALUES ('4385550199', 1), ('4385550142', 1)");
    $repo = new Repo(Db::open($file));
    $conversation = conversationWith($repo, LAVAL, MARIE);
    $contact = $repo->forViewer(new Viewer(Viewer::OWNER))->listContacts()[0];
    assertSame(['4385550199', MARIE], $contact['phones']);
    assertSame(['kind' => 'all'], $contact['book']);
    assertTrue($contact['editable']);
    assertSame('Marie Tremblay', nameIn($repo, $conversation));
});

test('names a conversation from the viewer’s own book first, then from its number’s', function (): void {
    $repo = freshRepo();
    $montreal = conversationWith($repo, MONTREAL, MARIE);
    $laval = conversationWith($repo, LAVAL, MARIE);
    $owner = $repo->forViewer(new Viewer(Viewer::OWNER));
    $owner->saveContact(null, 'Marie (bureau)', null, [MARIE], book: numbers(MONTREAL));
    assertSame('Marie (bureau)', nameIn($owner, $montreal));
    assertSame(null, nameIn($owner, $laval), 'not in the book of Laval');

    $marc = $repo->forViewer(new Viewer(5, [MONTREAL => true, LAVAL => true]));
    $marc->saveContact(null, 'Ma sœur', null, [MARIE], book: ['kind' => 'personal']);
    assertSame('Ma sœur', nameIn($marc, $montreal));
    assertSame('Ma sœur', nameIn($marc, $laval));
    assertSame('Marie (bureau)', nameIn($owner, $montreal), 'nobody else sees it');
    assertSame(['Marie (bureau)'], array_column($owner->listContacts(), 'name'));
    // Searching goes by the names the viewer sees.
    assertSame([$laval, $montreal], array_column($marc->listConversations(null, 'SŒUR'), 'id'));
    assertSame([], $owner->listConversations(null, 'SŒUR'));
});

test('shows users the contacts of their numbers’ books, and lets them change those of numbers they text from', function (): void {
    $repo = freshRepo();
    $repo->ensureDid(MONTREAL);
    $repo->ensureDid(LAVAL);
    $admin = $repo->forViewer(new Viewer(1));
    $admin->saveContact(null, 'Garage', null, ['4505550111'], book: numbers(LAVAL));
    $admin->saveContact(null, 'Pharmacie', null, ['5145550111'], book: numbers(MONTREAL));
    $admin->saveContact(null, 'Partout', null, ['5145550122']);
    $admin->saveContact(null, 'Les deux', null, ['5145550133'], book: numbers(MONTREAL, LAVAL));

    $marc = $repo->forViewer(new Viewer(5, [MONTREAL => true, LAVAL => false]));
    $seen = array_column($marc->listContacts(), 'editable', 'name');
    assertSame(['Garage' => false, 'Les deux' => false, 'Partout' => false, 'Pharmacie' => true], $seen);
    assertTrue($marc->mayUseBook(numbers(MONTREAL)));
    assertFalse($marc->mayUseBook(numbers(LAVAL)), 'read only');
    assertFalse($marc->mayUseBook(['kind' => 'all']));
    assertTrue($marc->mayUseBook(['kind' => 'personal']));
    assertTrue($admin->mayUseBook(numbers(MONTREAL, LAVAL)));
    assertFalse($admin->mayUseBook(numbers('9995550000')), 'not a number of the portal');

    $julie = $repo->forViewer(new Viewer(6, [LAVAL => true]));
    assertSame(['Garage', 'Les deux', 'Partout'], array_column($julie->listContacts(), 'name'));
    // Deleting in bulk skips those they may not change.
    $ids = array_column($admin->listContacts(), 'id');
    assertSame(1, $marc->deleteContacts($ids));
    assertSame(['Garage', 'Les deux', 'Partout'], array_column($admin->listContacts(), 'name'));
});

test('gives a phone to one contact per book', function (): void {
    $repo = freshRepo();
    $repo->ensureDid(MONTREAL);
    $repo->ensureDid(LAVAL);
    $admin = $repo->forViewer(new Viewer(1));
    $bureau = $admin->saveContact(null, 'Marie (bureau)', null, [MARIE], book: numbers(MONTREAL));
    $phones = static fn (array $conflicts) => array_column($conflicts, 'contactId');
    assertSame([], $admin->phoneConflicts([MARIE], null, numbers(LAVAL)));
    assertSame([$bureau], $phones($admin->phoneConflicts([MARIE], null, numbers(LAVAL, MONTREAL))));
    assertSame([$bureau], $phones($admin->phoneConflicts([MARIE], null, ['kind' => 'all'])));
    assertSame([], $admin->phoneConflicts([MARIE], null, ['kind' => 'personal']));
    assertSame([], $admin->phoneConflicts([MARIE], $bureau, numbers(MONTREAL)), 'itself');

    $maison = $admin->saveContact(null, 'Marie (maison)', null, [MARIE], book: numbers(LAVAL));
    assertSame(['Marie (bureau)', 'Marie (maison)'], array_column($admin->listContacts(), 'name'));
    // Moved into a book that covers both: the others lose the phone, and go with nothing left.
    $admin->saveContact(null, 'Marie', null, [MARIE]);
    assertSame(['Marie'], array_column($admin->listContacts(), 'name'));
    assertSame(null, $admin->getContact($maison));

    $marc = $repo->forViewer(new Viewer(5, [MONTREAL => true]));
    $conflict = $marc->phoneConflicts([MARIE], null, numbers(MONTREAL))[0];
    assertFalse($conflict['editable'], 'every number’s book is the admins’');
});

test('forgets a deleted user’s own contacts', function (): void {
    $repo = freshRepo();
    $userId = $repo->createUser('marc@example.com', null, 'hash', 'user');
    $repo->forViewer(new Viewer($userId, []))->saveContact(null, 'Ma sœur', null, [MARIE], book: ['kind' => 'personal']);
    $repo->saveContact(null, 'Pharmacie', null, ['5145550111']);
    $repo->deleteUser($userId);
    assertSame(['Pharmacie'], array_column($repo->run('SELECT name FROM contacts')->fetchAll(), 'name'));
});
