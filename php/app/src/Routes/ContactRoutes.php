<?php

declare(strict_types=1);

namespace SmsPortal\Routes;

use SmsPortal\App;
use SmsPortal\Http\HttpError;
use SmsPortal\Http\Input;
use SmsPortal\Http\Request;
use SmsPortal\Http\Response;
use SmsPortal\Phone;
use SmsPortal\VCard;

/** server/routes/contacts.ts */
final class ContactRoutes
{
    public static function register(App $app): void
    {
        $r = $app->router;
        $repo = $app->repo;

        $changed = static function () use ($app): void {
            $app->events->broadcast(['type' => 'contacts']);
            // Conversation names come from contacts.
            $app->events->broadcast(['type' => 'reload']);
        };

        $save = static function (?int $id, Request $req) use ($repo, $changed): Response {
            $body = new Input($req->json());
            $name = $body->string('name', 1, 120, trim: true);
            $notes = $body->nullableString('notes', 2000);
            $phones = array_values(array_unique(array_map([Phone::class, 'normalize'], $body->stringList('phones', 1, 20))));
            $force = $body->has('force') && $body->bool('force');
            $invalid = array_values(array_filter($phones, static fn (string $p) => !Phone::isValidNanp($p) && !preg_match('/^\d{5,6}$/', $p)));
            if ($invalid) {
                throw new HttpError(400, 'invalid_phone', ['phones' => $invalid]);
            }
            $conflicts = $repo->conflictingPhones($phones, $id);
            // Moving numbers that already belong to another contact needs "force".
            if ($conflicts && !$force) {
                throw new HttpError(409, 'phone_taken', ['phones' => $conflicts]);
            }
            $contactId = $repo->saveContact($id, $name, $notes, $phones);
            $changed();
            return Response::json($repo->getContact($contactId), $id === null ? 201 : 200);
        };

        $r->add('GET', '/api/contacts', fn () => Response::json($repo->listContacts()));

        $r->add('POST', '/api/contacts', fn (Request $req) => $save(null, $req));

        $r->add('PUT', '/api/contacts/{id}', function (Request $req) use ($repo, $save): Response {
            $id = Input::id($req->param('id'));
            if (!$repo->getContact($id)) {
                throw new HttpError(404, 'not_found');
            }
            return $save($id, $req);
        });

        $r->add('DELETE', '/api/contacts/{id}', function (Request $req) use ($repo, $changed): Response {
            if (!$repo->deleteContact(Input::id($req->param('id')))) {
                throw new HttpError(404, 'not_found');
            }
            $changed();
            return Response::json(['ok' => true]);
        });

        /** Imports a .vcf file; numbers already given to a contact are left alone. */
        $r->add('POST', '/api/contacts/import', function (Request $req) use ($repo, $changed): Response {
            $vcard = (new Input($req->json()))->string('vcard', 0, 10 * 1024 * 1024);
            $imported = 0;
            $skipped = 0;
            $repo->transaction(function () use ($repo, $vcard, &$imported, &$skipped): void {
                foreach (VCard::parse($vcard) as $contact) {
                    $free = array_values(array_filter($contact['phones'], static fn (string $p) => !$repo->conflictingPhones([$p], null)));
                    if (!$free) {
                        $skipped++;
                        continue;
                    }
                    $repo->saveContact(null, $contact['name'], null, $free);
                    $imported++;
                }
            });
            if ($imported) {
                $changed();
            }
            return Response::json(['imported' => $imported, 'skipped' => $skipped]);
        });
    }
}
