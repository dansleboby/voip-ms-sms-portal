# SMS Portal for VoIP.ms

A web app for sending and receiving the texts of a VoIP.ms account. The same
React client runs on two servers that answer the same API:

- **Node** (`server/`): Node 22+, Fastify, SQLite (better-sqlite3). It is shipped as the Docker image.
- **PHP** (`php/`): PHP 8.1+ with no Composer packages, for cPanel shared hosting. It uses the same
  database schema. There is no long-running process, so what Node keeps in memory (live updates,
  open tabs, sync state) lives in the database, and file locks keep jobs from overlapping.

`DEMO_MODE=true` swaps VoIP.ms for made-up numbers and conversations, and no real texts are sent.

## Layout

- `server/`: the Node server.
  - `routes/`: the API.
  - `voipms/`: the REST client and the demo client.
  - `db.ts`: migrations and `Repo`.
  - `sync.ts`, `send.ts`, `deletions.ts`: background work.
- `php/app/src/`: the PHP server, one class per Node module.
  - `Routes/`, `VoipMs/`, `Http/`, `Db.php`, `Repo.php`, `Sync.php`, `Sender.php`, `RemoteDeletions.php`.
  - `php/app/cron.php` runs the checks while no tab is open.
  - `php/www/` is the public entry point. `php/dev-router.php` stands in for its `.htaccess` under `php -S`.
- `shared/`: code both the client and the Node server import: phone formatting, SMS/MMS rules, API types.
- `web/src/`: the React client.
  - `components/`.
  - `lib/`.
  - `store.ts`: state and live updates.
  - `i18n/`: `fr.ts` is the source of the `MessageKey` type, and `en.ts` must have the same keys.
- `tests/`: contract tests.
  - `api.test.ts` runs every case against both servers.
  - `backends.ts` starts them in demo mode.
  - `fake-voipms.ts` stands in for VoIP.ms over HTTP for the PHP client.
- `scripts/`: build of the cPanel zip, release preparation, the release manifest, README screenshots.

## Commands

```bash
DEMO_MODE=true APP_PASSWORD=dev npm run dev   # API on :8080, UI on http://localhost:5173
npm test                                      # vitest: unit tests, and the API tests on both servers
npm run typecheck                             # tsc for the server and the client (no ESLint here)
npm run build                                 # dist/web and dist/node
npm run build:cpanel                          # dist/sms-portal-cpanel-<version>.zip
npm run screenshots                           # README screenshots; lists the ones that changed
```

To run the PHP server locally, first run `npm run build:web`, then:
`SMS_PORTAL_DIR=php/app DEMO_MODE=true APP_PASSWORD=dev php -S 127.0.0.1:8090 -t dist/web php/dev-router.php`

`npm test` skips the PHP server when `php` is missing. CI sets `REQUIRE_PHP` and runs PHP 8.1. Run the
whole `tests/api.test.ts` file rather than filtering with `-t`, because its cases share the setup in
`beforeAll`.

## Conventions

- **Keep the two servers in parity.** An API change goes into both `server/` and `php/app/src/`,
  with a case in `tests/api.test.ts`.
- **Migrations** are appended, never edited. Add each one to both `MIGRATIONS` in `server/db.ts`
  and `php/app/src/Db.php`, in the same order.
- **PHP code must run on 8.1.** That rules out typed class constants, `readonly` classes and
  `json_validate`.
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
