# SMS Portal for VoIP.ms

A web app for sending and receiving the texts of a VoIP.ms account: a React client and one server, in PHP.

- **Server** (`php/`): PHP 8.4+ with no Composer packages, and SQLite. Each request is a process of its own,
  so live updates, open tabs and sync state live in the database, and file locks keep jobs from overlapping.
  VoIP.ms is checked after requests and by `php/app/cron.php`.
- **One package, two ways to host it** (`npm run build:cpanel`):
  - cPanel shared hosting runs the zip, with a cron job.
  - The Docker image serves the same files with Apache and the same `.htaccess`, and runs `cron.php` every
    10 seconds. `SMS_PORTAL_INSTALL=docker` tells the server it runs there.
- Until 2.0 the Docker image ran a Node server. Its databases open as they are; what it encrypted with
  scrypt is read once (`Scrypt.php`) and stored again the PHP way.

`DEMO_MODE=true` swaps VoIP.ms for made-up numbers and conversations, and no real texts are sent.

## Layout

- `php/app/src/`: the server.
  - `Routes/`: the API.
  - `VoipMs/`: the REST client and the demo client.
  - `Db.php`: migrations. `Repo.php`: reads and writes.
  - `Accounts.php`: the VoIP.ms accounts, each with its client, `Sync` and `Webhook`.
  - `Auth.php`, `Passwords.php`: sessions (stored in the database) and the Team mode's user passwords.
  - `Sync.php`, `Sender.php`, `RemoteDeletions.php`, `Media.php`, `Push.php`, `Webhook.php`: work done after responses and by the cron job.
- `php/app/cron.php` runs the checks while no tab is open; `cron.php --check` only checks the settings.
- `php/www/` is the public entry point. `php/dev-router.php` stands in for its `.htaccess` under `php -S`.
- `Dockerfile`, `docker/`, `docker-entrypoint.sh`: the image.
- `shared/`: code the client imports, which the tests use too: phone formatting, SMS/MMS rules, and the
  API's JSON shapes (`types.ts`).
- `web/src/`: the React client.
  - `components/`.
  - `lib/`.
  - `store.ts`: state and live updates.
  - `i18n/`: `fr.ts` is the source of the `MessageKey` type, and `en.ts` must have the same keys.
- `tests/`:
  - `api.test.ts`: the API as the client uses it, in demo mode.
  - `backends.ts` starts the server under `php -S`.
  - `fake-voipms.ts` stands in for VoIP.ms over HTTP.
  - `php/unit/*.php`: the server's classes, tested in PHP (`php/harness.php`), run by `php-unit.test.ts`.
- `scripts/`: the dev server, the cPanel zip, release preparation, the release manifest, README screenshots.

## Commands

```bash
DEMO_MODE=true APP_PASSWORD=dev npm run dev   # API (php -S) on :8080, UI on http://localhost:5173
npm test                                      # vitest: client units, the API, and the PHP tests
npm run typecheck                             # tsc for the client, shared/, the tests and scripts (no ESLint here)
npm run build:cpanel                          # dist/sms-portal-cpanel-<version>.zip
docker build -t sms-portal .                  # the Docker image
npm run screenshots                           # README screenshots; lists the ones that changed
```

The tests need PHP 8.4+ on the PATH; CI runs them on PHP 8.4 and 8.5, and starts the Docker image. Run the
whole `tests/api.test.ts` file rather than filtering with `-t`, because its cases share the setup in
`beforeAll`.

## Conventions

- **An API change** goes into `php/app/src/` with a case in `tests/api.test.ts`, and its JSON shape into
  `shared/types.ts`. Logic below the API gets a PHP test in `tests/php/unit/`.
- **Migrations** are appended to `MIGRATIONS` in `php/app/src/Db.php`, never edited.
- **VoIP.ms accounts.** The first one (id 1, `PRIMARY_ACCOUNT`) keeps the settings keys of 1.x;
  the others' go through `accountKey()`, and their message ids through `storedRemoteId()`.
- **Who may call a route.** Every `/api` route needs a session unless it is public. One that changes the
  portal itself (numbers, VoIP.ms, users, updates) is for admins: `admin: true` or `$r->admin()`. The owner
  (`APP_PASSWORD`) passes that check.
- **PHP 8.4 is the oldest supported**, as `engines.php` in `package.json` says. `release.json` announces it,
  and the updater waits for a site's PHP to reach it; `api.php` and `bootstrap.php` check it (a test keeps the
  three in step). Raising it goes through all three, with a line for users in the changelog.
- **Every user-visible string goes through i18n**, in `fr.ts` and `en.ts`.
- **User-facing changes go under `## Unreleased` in `CHANGELOG.md`**, written for users.
  Keep the two READMEs (`README.md` and `README.fr.md`) in step.
- **After a UI change, run `npm run screenshots`** and commit the screenshots it reports as changed.
- **Comments and commit messages explain why**, in plain sentences. Match the surrounding code.
- **To release:**
  1. Run `npm run release:prepare -- minor` (or `patch` or `major`).
  2. Open a pull request.
  3. On merge to `main`, the Release workflow tags the version and publishes the GitHub release,
     the cPanel zip, `release.json` and the GHCR image.

  Never tag by hand.
