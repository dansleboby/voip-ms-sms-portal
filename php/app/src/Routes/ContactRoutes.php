<?php

declare(strict_types=1);

namespace SmsPortal\Routes;

use SmsPortal\App;
use SmsPortal\Http\HttpError;
use SmsPortal\Http\Input;
use SmsPortal\Http\InvalidRequest;
use SmsPortal\Http\Request;
use SmsPortal\Http\Response;
use SmsPortal\Phone;
use SmsPortal\Repo;
use SmsPortal\VCard;

/**
 * The address books: each person's own, and those of the numbers (one contact can be in several,
 * or in every number's). Contacts, vCard imports, deleting in bulk.
 */
final class ContactRoutes
{
    /** shared/contact.ts */
    private const ICONS = [
        'heart', 'star', 'house', 'users', 'baby', 'dog', 'briefcase', 'building', 'car', 'wrench', 'stethoscope', 'graduation-cap',
    ];

    /** shared/contact.ts: the client sends longer lists in several requests. */
    private const MAX_DELETE_IDS = 5000;

    public static function register(App $app): void
    {
        $r = $app->router;
        $repo = $app->repo;

        /** The database as the person signed in sees it: their contacts, and the books they may use. */
        $scoped = static fn (Request $req): Repo => $repo->forViewer($req->viewer);

        $changed = static function () use ($app): void {
            $app->events->broadcast(['type' => 'contacts']);
            // Conversation names come from contacts.
            $app->events->broadcast(['type' => 'reload']);
        };

        /** The book a request names, or null; 403 when the person may not put contacts there. */
        $bookOf = static function (Input $body, Repo $repo): ?array {
            if (!$body->has('book')) {
                return null;
            }
            $input = $body->object('book');
            $kind = $input->choice('kind', ['personal', 'all', 'numbers']) ?? throw new InvalidRequest('book.kind: required');
            $book = $kind === 'numbers'
                ? ['kind' => 'numbers', 'dids' => array_values(array_unique(array_map([Phone::class, 'normalize'], $input->stringList('dids', 1, 100))))]
                : ['kind' => $kind];
            if (!$repo->mayUseBook($book)) {
                throw new HttpError(403, 'book_forbidden');
            }
            return $book;
        };

        /** Where a contact goes when no book is named: every number's for whoever sees them all, otherwise one's own. */
        $defaultBook = static fn (Repo $repo): array => $repo->mayUseBook(Repo::ALL_NUMBERS) ? Repo::ALL_NUMBERS : ['kind' => 'personal'];

        $save = static function (?int $id, Request $req) use ($scoped, $changed, $bookOf, $defaultBook): Response {
            $repo = $scoped($req);
            $current = $id === null ? null : ($repo->getContact($id) ?? throw new HttpError(404, 'not_found'));
            if ($current !== null && !$current['editable']) {
                throw new HttpError(403, 'read_only');
            }
            $body = new Input($req->json());
            $name = $body->string('name', 1, 120, trim: true);
            $color = $body->isNull('color') ? null : $body->matching('color', '/^#[0-9a-fA-F]{6}$/');
            $icon = $body->isNull('icon') ? null : $body->choice('icon', self::ICONS);
            $notes = $body->nullableString('notes', 2000);
            $phones = array_values(array_unique(array_map([Phone::class, 'normalize'], $body->stringList('phones', 1, 20))));
            $force = $body->has('force') && $body->bool('force');
            $book = $bookOf($body, $repo) ?? $current['book'] ?? $defaultBook($repo);
            $invalid = array_values(array_filter($phones, static fn (string $p) => !Phone::isValidNanp($p) && !preg_match('/^\d{5,6}$/', $p)));
            if ($invalid) {
                throw new HttpError(400, 'invalid_phone', ['phones' => $invalid]);
            }
            $conflicts = $repo->phoneConflicts($phones, $id, $book);
            $phonesOf = static fn (array $list): array => array_values(array_unique(array_column($list, 'phone')));
            // A number of the same book belongs to a contact they may not change.
            $locked = array_filter($conflicts, static fn (array $c) => !$c['editable']);
            if ($locked) {
                throw new HttpError(409, 'phone_locked', ['phones' => $phonesOf($locked)]);
            }
            // Moving numbers that already belong to another contact needs "force".
            if ($conflicts && !$force) {
                throw new HttpError(409, 'phone_taken', ['phones' => $phonesOf($conflicts)]);
            }
            $contactId = $repo->saveContact($id, $name, $notes, $phones, $color, $icon, $book);
            $changed();
            return Response::json($repo->getContact($contactId), $id === null ? 201 : 200);
        };

        $r->add('GET', '/api/contacts', fn (Request $req) => Response::json($scoped($req)->listContacts()));

        $r->add('POST', '/api/contacts', fn (Request $req) => $save(null, $req));

        $r->add('PUT', '/api/contacts/{id}', fn (Request $req) => $save(Input::id($req->param('id')), $req));

        $r->add('DELETE', '/api/contacts/{id}', function (Request $req) use ($app, $scoped, $changed): Response {
            $repo = $scoped($req);
            $id = Input::id($req->param('id'));
            $contact = $repo->getContact($id) ?? throw new HttpError(404, 'not_found');
            if (!$contact['editable']) {
                throw new HttpError(403, 'read_only');
            }
            $repo->deleteContact($id);
            $app->activity->record($req, 'contact_deleted', $contact['name']);
            $changed();
            return Response::json(['ok' => true]);
        });

        /** Deletes several contacts at once (a whole list imported by mistake); their conversations stay. */
        $r->add('POST', '/api/contacts/delete', function (Request $req) use ($app, $scoped, $changed): Response {
            $ids = array_values(array_unique((new Input($req->json()))->idList('ids', 1, self::MAX_DELETE_IDS)));
            // Those they may change only.
            $deleted = $scoped($req)->deleteContacts($ids);
            if ($deleted) {
                $changed();
                $app->activity->record($req, 'contacts_deleted', null, ['count' => $deleted]);
            }
            return Response::json(['deleted' => $deleted]);
        });

        /**
         * Imports a .vcf file into a book; numbers already given to a contact of that
         * book are left alone. Returns the new contacts' ids, so that the import can be undone.
         */
        $r->add('POST', '/api/contacts/import', function (Request $req) use ($scoped, $changed, $bookOf, $defaultBook): Response {
            $repo = $scoped($req);
            $body = new Input($req->json());
            $vcard = $body->string('vcard', 0, 10 * 1024 * 1024);
            $book = $bookOf($body, $repo) ?? $defaultBook($repo);
            $ids = [];
            $skipped = 0;
            $repo->transaction(function () use ($repo, $vcard, $book, &$ids, &$skipped): void {
                foreach (VCard::parse($vcard) as $contact) {
                    $free = array_values(array_filter($contact['phones'], static fn (string $p) => !$repo->phoneConflicts([$p], null, $book)));
                    if (!$free) {
                        $skipped++;
                        continue;
                    }
                    $ids[] = $repo->saveContact(null, $contact['name'], null, $free, book: $book);
                }
            });
            if ($ids) {
                $changed();
            }
            return Response::json(['imported' => count($ids), 'skipped' => $skipped, 'ids' => $ids]);
        });
    }
}
