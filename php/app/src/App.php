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
    public readonly Sync $sync;
    public readonly Sender $sender;
    public readonly Push $push;
    public readonly Updates $updates;
    public readonly Router $router;
    public readonly string $version;

    private ?VoipMsApi $client = null;
    private bool $clientLoaded = false;
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
        Log::to("$dataDir/portal.log");

        $this->version = self::readVersion($config->appDir);
        $this->repo = new Repo(Db::open("$dataDir/portal.db"));
        $this->events = new Events($this->repo);
        $this->auth = new Auth($this->repo, $config->appPassword, $config->sessionDays);
        $this->credentials = new Credentials(
            $this->repo,
            $config->appPassword,
            $config->demo ? ['username' => 'demo@example.com', 'password' => 'demo'] : $config->voipmsEnv,
        );
        $this->media = new Media("$dataDir/media", $dataDir, $this->repo, $this->events);
        $this->push = new Push($this->repo, $this->events, $config->vapidSubject, fn () => $this->credentials->fingerprint('push-subscriptions'));
        $this->sync = new Sync(
            repo: $this->repo,
            events: $this->events,
            getClient: fn () => $this->client(),
            isEnabled: fn () => $this->isSetupCompleted() && $this->credentials->present(),
            timeZone: $config->voipmsTimezone,
            pollActiveMs: $config->pollActiveMs,
            pollIdleMs: $config->pollIdleMs,
            lockDir: $dataDir,
            onIncoming: fn (array $items) => $this->push->notifyIncoming($items),
            cronCommand: self::cronCommand($config->appDir),
        );
        $this->sender = new Sender($this->repo, $this->events, $this->media, $this->sync, fn () => $this->client(), $dataDir, fn (callable $work) => $this->defer($work));
        $this->updates = new Updates(
            repo: $this->repo,
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
                $this->repo->saveContact(null, $contact['name'], null, $contact['phones']);
            }
        }

        $this->router = new Router();
        Routes\AuthRoutes::register($this);
        Routes\SetupRoutes::register($this);
        Routes\MessagingRoutes::register($this);
        Routes\ContactRoutes::register($this);
        Routes\PushRoutes::register($this);
        Routes\UpdateRoutes::register($this);
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

    /** Client for the configured credentials, or null. */
    public function client(): ?VoipMsApi
    {
        if (!$this->clientLoaded) {
            $credentials = $this->credentials->get();
            $this->client = $credentials ? $this->clientFor($credentials) : null;
            $this->clientLoaded = true;
        }
        return $this->client;
    }

    /** Client for any credentials (the wizard checks them before saving). */
    public function clientFor(array $credentials): VoipMsApi
    {
        if ($this->config->demo) {
            return new DemoClient($this->repo->db, $this->config->voipmsTimezone);
        }
        return new RestClient($credentials['username'], $credentials['password'], $this->config->voipmsApiUrl);
    }

    public function resetClient(): void
    {
        $this->clientLoaded = false;
        $this->client = null;
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
     * After a tab's poll: the check of VoIP.ms when due, then queued history
     * and media downloads, for a limited time.
     */
    public function background(bool $active): void
    {
        $this->defer(function () use ($active): void {
            $deadline = microtime(true) + self::BACKGROUND_BUDGET_S;
            if ($this->sync->isDue($active)) {
                $this->sync->syncRecent();
            }
            $this->sync->continueImport($deadline);
            $this->media->drain($deadline);
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
            if (!$match['public'] && !$this->auth->verify($request->cookies[Auth::COOKIE] ?? null)) {
                throw new HttpError(401, 'unauthorized');
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

    public function signedIn(Request $request): bool
    {
        return $this->auth->verify($request->cookies[Auth::COOKIE] ?? null);
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
                . "script-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
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
