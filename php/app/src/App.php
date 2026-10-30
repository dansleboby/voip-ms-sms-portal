<?php

declare(strict_types=1);

namespace SmsPortal;

use SmsPortal\Http\HttpError;
use SmsPortal\Http\Request;
use SmsPortal\Http\Response;
use SmsPortal\Http\Router;
use SmsPortal\VoipMs\DemoClient;
use SmsPortal\VoipMs\RestClient;
use SmsPortal\VoipMs\VoipMsApi;
use SmsPortal\VoipMs\VoipMsError;

/**
 * The services of one request (or one cron run), and the request's life:
 * routing, the checks every API call goes through, errors, and the work
 * left for after the response (server/app.ts).
 */
final class App
{
    private const SETUP_COMPLETED_KEY = 'setup.completed';
    /** Background work after a response stops starting new tasks after this many seconds. */
    private const BACKGROUND_BUDGET_S = 20;

    public readonly Repo $repo;
    public readonly Events $events;
    public readonly Auth $auth;
    public readonly Credentials $credentials;
    public readonly Media $media;
    /** The VoIP.ms accounts, each checked on its own. */
    public readonly Accounts $accounts;
    public readonly Sender $sender;
    public readonly RemoteDeletions $deletions;
    public readonly Push $push;
    public readonly Updates $updates;
    public readonly Router $router;
    public readonly string $version;

    /** @var list<callable> */
    private array $deferred = [];

    /**
     * @param ?string $siteDir the web root (where api.php is), which updates replace along with the app
     */
    private function __construct(public readonly Config $config, public readonly ?string $siteDir = null)
    {
        $dataDir = $config->dataDir;
        if (!is_dir($dataDir)) {
            @mkdir($dataDir, 0700, true);
        }
        if (!is_dir($dataDir) || !is_writable($dataDir)) {
            throw new ConfigError("Cannot write to the data folder $dataDir. Create it and make it writable by your account (permissions 700 or 755).");
        }
        // In case the folder ever ends up inside the web root.
        if (!is_file("$dataDir/.htaccess")) {
            @file_put_contents("$dataDir/.htaccess", "Require all denied\nDeny from all\n");
        }
        // Docker keeps logs itself (docker logs): with no file, they go to Apache's error log, or stderr.
        if ($config->install !== 'docker') {
            Log::to("$dataDir/portal.log");
        }

        $this->version = self::readVersion($config->appDir);
        $this->repo = new Repo(Db::open("$dataDir/portal.db"), $config->allowedDids, $config->excludedDids);
        $this->events = new Events($this->repo);
        $this->auth = new Auth($this->repo, $config->appPassword, $config->sessionDays);
        $this->credentials = new Credentials(
            $this->repo,
            $config->appPassword,
            $config->demo ? ['username' => 'demo@example.com', 'password' => 'demo'] : $config->voipmsEnv,
        );
        $this->media = new Media("$dataDir/media", $dataDir, $this->repo, $this->events);
        $this->push = new Push(
            $this->repo,
            $this->events,
            $config->vapidSubject,
            fn () => $this->credentials->fingerprint('push-subscriptions'),
            fn () => $this->credentials->legacyFingerprint('push-subscriptions'),
        );
        $this->accounts = new Accounts(
            $this->repo,
            $this->events,
            $this->credentials,
            fn (array $credentials, int $accountId) => $this->clientFor($credentials, $accountId),
            fn (Account $account) => $this->buildAccount($account, $config, $dataDir),
        );
        $this->sender = new Sender(
            $this->repo,
            $this->events,
            $this->media,
            fn (string $did) => $this->accounts->forDid($did),
            $dataDir,
            fn (callable $work) => $this->defer($work),
        );
        $this->deletions = new RemoteDeletions($this->repo, fn (string $did) => $this->accounts->forDid($did)?->client(), $dataDir);
        $this->updates = new Updates(
            repo: $this->repo,
            install: $config->install,
            version: $this->version,
            enabled: $config->updateCheck,
            manifestUrl: $config->updateManifestUrl,
            appDir: $config->appDir,
            siteDir: $siteDir,
            workDir: "$dataDir/update",
            lockDir: $dataDir,
        );

        if ($config->demo && !$this->repo->listContacts()) {
            foreach (DemoClient::CONTACTS as $contact) {
                $this->repo->saveContact(null, $contact['name'], null, $contact['phones'], icon: $contact['icon'] ?? null);
            }
        }

        $this->router = new Router();
        Routes\AuthRoutes::register($this);
        Routes\SetupRoutes::register($this);
        Routes\MessagingRoutes::register($this);
        Routes\ContactRoutes::register($this);
        Routes\PushRoutes::register($this);
        Routes\UpdateRoutes::register($this);
        Routes\WebhookRoutes::register($this);
        Routes\AccountRoutes::register($this);
        Routes\UserRoutes::register($this);
    }

    public static function boot(string $appDir, ?string $siteDir = null): self
    {
        return new self(Config::load($appDir), $siteDir);
    }

    /** What www/api.php runs: one request, start to finish. */
    public static function serve(string $appDir, ?string $siteDir = null): void
    {
        // Hosts that print PHP's warnings into pages would corrupt the JSON, and send the
        // headers early with the wrong status; anything printed is dropped by Response::send.
        @ini_set('display_errors', '0');
        ob_start();
        $request = Request::fromGlobals();
        try {
            $app = self::boot($appDir, $siteDir);
        } catch (ConfigError $e) {
            self::secure(Response::error(500, 'config_error', ['message' => $e->getMessage()]))->send();
            return;
        }
        $app->handle($request)->send();
        $app->runDeferred();
    }

    // -------------------------------------------------------------- VoIP.ms

    /** An account's checks of VoIP.ms, and VoIP.ms calling back for its numbers. */
    private function buildAccount(Account $account, Config $config, string $dataDir): array
    {
        // A call from VoIP.ms checks the account after the answer, once a check already running is
        // done, then fetches the pictures of the MMS it found, as the Docker version does right away.
        $webhook = new Webhook(
            $this->repo,
            fn () => $account->client(),
            $config->publicOrigin,
            fn () => $this->defer(function () use ($account): void {
                $account->sync->syncRecent(wait: true);
                $this->media->drain(microtime(true) + self::BACKGROUND_BUDGET_S);
            }),
            $account->id,
        );
        $sync = new Sync(
            repo: $this->repo,
            events: $this->events,
            getClient: fn () => $account->client(),
            isEnabled: fn () => $this->isSetupCompleted() && $this->credentials->present($account->id),
            timeZone: $config->voipmsTimezone,
            pollActiveMs: $config->pollActiveMs,
            pollIdleMs: $config->pollIdleMs,
            lockDir: $dataDir,
            onIncoming: fn (array $items) => $this->push->notifyIncoming($items),
            // Docker runs the cron job itself: Settings has nothing to ask of anyone there.
            cronCommand: $config->install === 'docker' ? null : self::cronCommand($config->appDir),
            webhook: $webhook,
            accountId: $account->id,
            publish: fn () => $this->accounts->publishStatus(),
        );
        return [$sync, $webhook];
    }

    /** Client for the first account's credentials (the one the wizard sets up), or null. */
    public function client(): ?VoipMsApi
    {
        return $this->accounts->primary()->client();
    }

    /** Client for any credentials (checked before they are saved); the demo has one sample account per id. */
    public function clientFor(array $credentials, int $accountId = Repo::PRIMARY_ACCOUNT): VoipMsApi
    {
        if ($this->config->demo) {
            return new DemoClient($this->repo->db, $this->config->voipmsTimezone, $accountId);
        }
        return new RestClient($credentials['username'], $credentials['password'], $this->config->voipmsApiUrl);
    }

    public function resetClient(): void
    {
        $this->accounts->primary()->resetClient();
    }

    public function isSetupCompleted(): bool
    {
        return $this->repo->getSetting(self::SETUP_COMPLETED_KEY) === '1';
    }

    public function setSetupCompleted(bool $done): void
    {
        $this->repo->setSetting(self::SETUP_COMPLETED_KEY, $done ? '1' : '0');
    }

    // ----------------------------------------------------------- after the response

    public function defer(callable $work): void
    {
        $this->deferred[] = $work;
    }

    /**
     * After a tab's poll: the check of VoIP.ms when due ($opening: the tab's
     * first poll, which checks even while VoIP.ms announces texts), then queued
     * history and media downloads, for a limited time.
     */
    public function background(bool $active, bool $opening = false): void
    {
        $this->defer(function () use ($active, $opening): void {
            $deadline = microtime(true) + self::BACKGROUND_BUDGET_S;
            foreach ($this->accounts->all() as $account) {
                if ($account->sync->isDue($active, $opening)) {
                    $account->sync->syncRecent();
                }
            }
            foreach ($this->accounts->all() as $account) {
                $account->sync->continueImport($deadline);
            }
            $this->media->drain($deadline);
            $this->deletions->drain($deadline);
        });
    }

    public function runDeferred(): void
    {
        if (!$this->deferred) {
            return;
        }
        ignore_user_abort(true);
        @set_time_limit(self::BACKGROUND_BUDGET_S + 70);
        while ($work = array_shift($this->deferred)) {
            try {
                $work();
            } catch (\Throwable $e) {
                Log::error('Background work failed', ['err' => $e]);
            }
        }
    }

    // ---------------------------------------------------------------- requests

    private const PUBLIC_ROUTES = ['/api/health', '/api/session', '/api/auth/login', '/api/auth/logout'];

    public function handle(Request $request): Response
    {
        $match = $this->router->match($request->method, $request->path);
        if ($match === null) {
            return self::secure(Response::error(404, 'not_found'));
        }
        $request->params = $match['params'];
        try {
            if (!in_array($request->method, ['GET', 'HEAD'], true) && !$this->sameOrigin($request)) {
                throw new HttpError(403, 'bad_origin');
            }
            $request->user = $this->auth->verify($request->cookies[Auth::COOKIE] ?? null);
            if (!$match['public'] && $request->user === null) {
                throw new HttpError(401, 'unauthorized');
            }
            if ($match['admin'] && $request->user['role'] === 'user') {
                throw new HttpError(403, 'forbidden');
            }
            $response = ($match['handler'])($request);
        } catch (HttpError $e) {
            $response = Response::error($e->status, $e->errorCode, $e->extra);
        } catch (VoipMsError $e) {
            $response = Response::error(502, $e->errorCode, ['message' => $e->getMessage()]);
        } catch (\Throwable $e) {
            Log::error('Unhandled error', ['path' => $request->path, 'err' => $e]);
            $response = Response::error(500, 'internal_error');
        }
        if (!isset($response->headers['Cache-Control'])) {
            $response->header('Cache-Control', 'no-store');
        }
        return self::secure($response);
    }


    /** Rejects cross-site state-changing requests (on top of SameSite=Lax cookies). */
    private function sameOrigin(Request $request): bool
    {
        $origin = $request->header('origin');
        if ($origin === null) {
            return true;
        }
        $normalized = Origin::of($origin);
        if ($normalized === null) {
            return false;
        }
        $parts = parse_url($origin);
        $host = $parts['host'] . (isset($parts['port']) ? ':' . $parts['port'] : '');
        return $normalized === $this->config->publicOrigin || strcasecmp($host, (string) $request->header('host')) === 0;
    }

    private static function secure(Response $response): Response
    {
        $response->header('X-Content-Type-Options', 'nosniff');
        $response->header('Referrer-Policy', 'no-referrer');
        $response->header('X-Frame-Options', 'DENY');
        if (!isset($response->headers['Content-Security-Policy'])) {
            $response->header(
                'Content-Security-Policy',
                "default-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; style-src 'self' 'unsafe-inline'; "
                . "script-src 'self' 'wasm-unsafe-eval'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
            );
        }
        return $response;
    }

    // ------------------------------------------------------------------ install

    /** The line to give cPanel's Cron Jobs page. */
    private static function cronCommand(string $appDir): string
    {
        // cPanel's own PHP for command lines; "php" when it is elsewhere.
        $php = @is_executable('/usr/local/bin/php') ? '/usr/local/bin/php' : 'php';
        $script = "$appDir/cron.php";
        return "$php " . (preg_match('~^[\w/.-]+$~', $script) ? $script : escapeshellarg($script));
    }

    /** From the VERSION file written by the build, or package.json in a checkout of the project. */
    private static function readVersion(string $appDir): string
    {
        if (is_file("$appDir/VERSION")) {
            return trim((string) file_get_contents("$appDir/VERSION"));
        }
        for ($dir = $appDir; ; $dir = dirname($dir)) {
            $package = @json_decode((string) @file_get_contents("$dir/package.json"), true);
            if (is_array($package) && ($package['name'] ?? null) === 'voip-ms-sms-portal' && isset($package['version'])) {
                return (string) $package['version'];
            }
            if (dirname($dir) === $dir) {
                return 'unknown';
            }
        }
    }
}
