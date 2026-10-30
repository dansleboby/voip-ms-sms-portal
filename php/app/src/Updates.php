<?php

declare(strict_types=1);

namespace SmsPortal;

use SmsPortal\Http\HttpError;

/**
 * New versions: whether one was published (from the release.json each
 * release carries), and installing it in
 * place from Settings. The update replaces the files of the sms-portal
 * folder and of the site; config.php and the data folder are never touched.
 *
 * Installing goes in steps that leave the site as it was if one fails: the
 * zip is checked against the SHA-256 the release announced, every new file
 * is written next to its target first, the files it replaces are copied to
 * data/update/backup, and only then are the new ones renamed into place,
 * each rename restored from the backup if a later one fails.
 */
final class Updates
{
    private const LATEST_KEY = 'update.latest';
    private const CHECKED_KEY = 'update.checkedAt';
    private const ERROR_KEY = 'update.error';
    private const CACHE_MS = 6 * 3_600_000;
    private const MAX_NOTES = 20_000;
    private const MAX_PACKAGE_BYTES = 50 * 1024 * 1024;
    /** Suffix of a new file written next to the one it replaces, before the switch. */
    private const STAGED = '.update-new';

    public function __construct(
        private readonly Repo $repo,
        /** "docker": a new image replaces this one, the server never touches its own files. */
        private readonly string $install,
        private readonly string $version,
        private readonly bool $enabled,
        private readonly string $manifestUrl,
        private readonly string $appDir,
        private readonly ?string $siteDir,
        /** Where downloads, unpacked packages and the backup of the previous version go. */
        private readonly string $workDir,
        private readonly string $lockDir,
    ) {
    }

    // ------------------------------------------------------------------ checking

    /** Checks again when the last answer is stale, or when asked to. */
    public function status(bool $refresh = false): array
    {
        $checkedAt = (int) ($this->repo->getSetting(self::CHECKED_KEY) ?? 0);
        if ($this->enabled && ($refresh || $checkedAt === 0 || Time::nowMs() - $checkedAt > self::CACHE_MS)) {
            $this->check();
        }
        $latest = $this->latest();
        [$blocked, $paths] = $this->install === 'docker' ? [null, []] : $this->blocked();
        $status = [
            'current' => $this->version,
            'install' => $this->install,
            'enabled' => $this->enabled,
            'latest' => $latest === null ? null : [
                'version' => $latest['version'],
                'publishedAt' => $latest['publishedAt'],
                'url' => $latest['url'],
                'notes' => $latest['notes'],
            ],
            'available' => $latest !== null && self::isNewer($latest['version'], $this->version),
            'checkedAt' => ((int) ($this->repo->getSetting(self::CHECKED_KEY) ?? 0)) ?: null,
            'error' => $this->repo->getSetting(self::ERROR_KEY),
            'canInstall' => $this->install !== 'docker' && $blocked === null,
            'blocked' => $blocked,
        ];
        if ($paths) {
            $status['paths'] = $paths;
        }
        return $status;
    }

    private function latest(): ?array
    {
        $stored = $this->repo->getSetting(self::LATEST_KEY);
        return $stored === null ? null : self::parseManifest(json_decode($stored, true));
    }

    private function check(): void
    {
        $error = null;
        [$status, $body] = self::get($this->manifestUrl, 15, 1_000_000, $this->version);
        if ($status === 404) {
            // Nothing published yet.
            $this->repo->deleteSetting(self::LATEST_KEY);
        } elseif ($status < 200 || $status >= 300) {
            $error = 'unreachable';
        } else {
            $manifest = self::parseManifest(json_decode((string) $body, true));
            if ($manifest !== null) {
                $this->repo->setSetting(self::LATEST_KEY, json_encode($manifest));
            } else {
                $error = 'invalid_manifest';
            }
        }
        $this->repo->setSetting(self::CHECKED_KEY, (string) Time::nowMs());
        if ($error !== null) {
            $this->repo->setSetting(self::ERROR_KEY, $error);
        } else {
            $this->repo->deleteSetting(self::ERROR_KEY);
        }
    }

    /** release.json as published, or null when it does not have the expected shape. */
    public static function parseManifest(mixed $m): ?array
    {
        if (!is_array($m) || !is_string($m['version'] ?? null) || !preg_match('/^\d+\.\d+\.\d+$/', $m['version'])) {
            return null;
        }
        if (!is_string($m['url'] ?? null) || !preg_match('~^https?://~', $m['url'])) {
            return null;
        }
        $zip = $m['cpanel'] ?? null;
        $validZip = is_array($zip) && is_string($zip['url'] ?? null) && preg_match('~^https?://~', $zip['url'])
            && is_string($zip['sha256'] ?? null) && preg_match('/^[0-9a-f]{64}$/', $zip['sha256']);
        return [
            'version' => $m['version'],
            'publishedAt' => is_string($m['publishedAt'] ?? null) ? $m['publishedAt'] : null,
            'url' => $m['url'],
            'notes' => is_string($m['notes'] ?? null) ? mb_substr($m['notes'], 0, self::MAX_NOTES, 'UTF-8') : '',
            'cpanel' => $validZip ? ['url' => $zip['url'], 'sha256' => $zip['sha256'], 'size' => (int) ($zip['size'] ?? 0)] : null,
        ];
    }

    /** True when version $a comes after $b; false for anything that is not X.Y.Z. */
    public static function isNewer(string $a, string $b): bool
    {
        $pattern = '/^\d+\.\d+\.\d+$/';
        return preg_match($pattern, $a) && preg_match($pattern, $b) && version_compare($a, $b, '>');
    }

    // ---------------------------------------------------------------- installing

    /**
     * Why this server cannot update itself, if it cannot, and the paths at fault.
     *
     * @return array{0: ?string, 1: list<string>}
     */
    private function blocked(): array
    {
        $site = $this->siteDir;
        // A checkout of the project (no VERSION file) is updated with git, not with a package.
        if (!is_file("$this->appDir/VERSION") || $site === null || !is_file("$site/index.html") || !is_file("$site/api.php")) {
            return ['not_packaged', []];
        }
        if (!class_exists(\ZipArchive::class) && !class_exists(\PharData::class)) {
            return ['no_unzip', []];
        }
        $dirs = [$this->appDir, "$this->appDir/src", $site, "$site/assets"];
        if (is_dir("$this->appDir/src")) {
            $tree = new \RecursiveIteratorIterator(
                new \RecursiveDirectoryIterator("$this->appDir/src", \FilesystemIterator::SKIP_DOTS),
                \RecursiveIteratorIterator::SELF_FIRST,
            );
            foreach ($tree as $item) {
                if ($item->isDir()) {
                    $dirs[] = $item->getPathname();
                }
            }
        }
        $readOnly = array_values(array_filter($dirs, static fn (string $dir) => is_dir($dir) && !is_writable($dir)));
        return $readOnly ? ['not_writable', $readOnly] : [null, []];
    }

    /**
     * Installs the newest release. Returns the version now running (from the
     * next request on).
     */
    public function install(): string
    {
        // Loaded before the files they live in are replaced.
        class_exists(HttpError::class);
        class_exists(Log::class);

        if ($this->install === 'docker') {
            throw new HttpError(409, 'install_unsupported');
        }
        $lock = Lock::take($this->lockDir, 'update') ?? throw new HttpError(409, 'update_in_progress');
        try {
            $this->check();
            $latest = $this->latest();
            if ($latest === null || !self::isNewer($latest['version'], $this->version)) {
                throw new HttpError(409, 'up_to_date');
            }
            if ($latest['cpanel'] === null) {
                throw new HttpError(502, 'invalid_manifest');
            }
            [$blocked, $paths] = $this->blocked();
            if ($blocked !== null) {
                throw new HttpError(409, $blocked, $paths ? ['paths' => $paths] : []);
            }
            @set_time_limit(300);
            ignore_user_abort(true);

            @mkdir($this->workDir, 0700, true);
            $zip = $this->download($latest['cpanel']);
            $new = $this->unpack($zip, $latest['version']);
            $this->replace($new);
            self::removeTree($new);
            @unlink($zip);
            Log::info('Updated', ['from' => $this->version, 'to' => $latest['version']]);
            return $latest['version'];
        } finally {
            $lock->release();
        }
    }

    private function download(array $package): string
    {
        // Named after its content: PHP keeps the archives PharData opened, by path, for the
        // life of the process (PHP-FPM workers serve many requests), and would read an
        // earlier download at the same path instead of this one.
        foreach ((array) glob($this->workDir . '/package-*.zip') as $old) {
            @unlink($old);
        }
        $file = $this->workDir . '/package-' . $package['sha256'] . '.zip';
        [$status, $bytes] = self::get($package['url'], 120, self::MAX_PACKAGE_BYTES, $this->version);
        if ($status < 200 || $status >= 300 || $bytes === null) {
            throw new HttpError(502, 'download_failed');
        }
        if (!hash_equals($package['sha256'], hash('sha256', $bytes))) {
            throw new HttpError(502, 'checksum_mismatch');
        }
        if (file_put_contents($file, $bytes) === false) {
            throw new HttpError(500, 'install_failed');
        }
        return $file;
    }

    /** Unpacks the zip in the work folder and checks it is a package of $version. Returns where. */
    private function unpack(string $zip, string $version): string
    {
        $dir = $this->workDir . '/new';
        // Hosts without the zip extension, or with ZipArchive disabled, still have PharData.
        $extractors = [];
        if (class_exists(\ZipArchive::class)) {
            $extractors[] = static function (string $zip, string $dir): void {
                $archive = new \ZipArchive();
                if ($archive->open($zip) !== true) {
                    throw new \RuntimeException('Unreadable zip');
                }
                for ($i = 0; $i < $archive->numFiles; $i++) {
                    self::checkEntry((string) $archive->getNameIndex($i));
                }
                if (!$archive->extractTo($dir)) {
                    throw new \RuntimeException('Extraction failed');
                }
                $archive->close();
            };
        }
        if (class_exists(\PharData::class)) {
            $extractors[] = static function (string $zip, string $dir): void {
                $archive = new \PharData($zip);
                $prefix = 'phar://' . $zip . '/';
                foreach (new \RecursiveIteratorIterator($archive) as $entry) {
                    self::checkEntry(substr($entry->getPathname(), strlen($prefix)));
                }
                $archive->extractTo($dir, null, true);
            };
        }
        $unpacked = false;
        foreach ($extractors as $extract) {
            self::removeTree($dir);
            mkdir($dir, 0700, true);
            try {
                $extract($zip, $dir);
                $unpacked = true;
                break;
            } catch (HttpError $e) {
                // A refused entry: no other way of unpacking makes the package acceptable.
                throw $e;
            } catch (\Throwable $e) {
                Log::warn('Update package unreadable', ['err' => $e]);
            }
        }
        // PharData does not list "../x" entries but extracts them, brought back inside $dir.
        $unexpected = array_diff((array) scandir($dir), ['.', '..', 'sms-portal', 'sms-portal-site', 'INSTALL.txt']);
        if (!$unpacked || $unexpected) {
            throw new HttpError(502, 'invalid_package');
        }
        $packaged = trim((string) @file_get_contents("$dir/sms-portal/VERSION"));
        if ($packaged !== $version || !is_file("$dir/sms-portal/bootstrap.php") || !is_file("$dir/sms-portal-site/index.html") || !is_file("$dir/sms-portal-site/api.php")) {
            throw new HttpError(502, 'invalid_package');
        }
        if (!self::matchesFileList($dir)) {
            Log::warn('Update package unpacked with files that do not match its list');
            throw new HttpError(502, 'invalid_package');
        }
        return $dir;
    }

    /**
     * Every unpacked file is in sms-portal/FILES with the same SHA-256, and
     * nothing else is there: an unzip can go wrong without saying so
     * (PharData on PHP 8.1 misreads some zips and writes garbage).
     */
    private static function matchesFileList(string $dir): bool
    {
        $lines = @file("$dir/sms-portal/FILES", FILE_IGNORE_NEW_LINES | FILE_SKIP_EMPTY_LINES);
        if (!$lines) {
            return false;
        }
        $listed = [];
        foreach ($lines as $line) {
            if (!preg_match('/^([0-9a-f]{64})  ((?:sms-portal|sms-portal-site)\/.+)$/', $line, $m)) {
                return false;
            }
            $listed[$m[2]] = $m[1];
        }
        $unpacked = [];
        foreach (['sms-portal', 'sms-portal-site'] as $folder) {
            foreach (self::files("$dir/$folder") as $relative) {
                if ("$folder/$relative" !== 'sms-portal/FILES') {
                    $unpacked[] = "$folder/$relative";
                }
            }
        }
        sort($unpacked);
        $names = array_keys($listed);
        sort($names);
        if ($unpacked !== $names) {
            return false;
        }
        foreach ($listed as $name => $hash) {
            if (!hash_equals($hash, (string) hash_file('sha256', "$dir/$name"))) {
                return false;
            }
        }
        return true;
    }

    /** Only the package's two folders, and nothing that climbs out of them. */
    private static function checkEntry(string $name): void
    {
        $name = str_replace('\\', '/', $name);
        if (
            $name === '' || $name[0] === '/' || preg_match('~(^|/)\.\.(/|$)~', $name) || str_contains($name, ':')
            || !preg_match('~^(sms-portal|sms-portal-site)(/|$)|^INSTALL\.txt$~', $name)
        ) {
            throw new HttpError(502, 'invalid_package');
        }
    }

    /** Puts the unpacked files in place of the running ones, or leaves everything as it was. */
    private function replace(string $new): void
    {
        $targets = [];
        foreach (['sms-portal' => $this->appDir, 'sms-portal-site' => (string) $this->siteDir] as $folder => $dest) {
            foreach (self::files("$new/$folder") as $relative) {
                // The settings and data of this install are its own.
                if ($folder === 'sms-portal' && ($relative === 'config.php' || str_starts_with($relative, 'data/'))) {
                    continue;
                }
                $targets["$dest/$relative"] = "$new/$folder/$relative";
            }
        }
        // Files the new version no longer has: stale classes, assets of the previous build.
        $stale = [];
        foreach (["$this->appDir/src" => "$new/sms-portal/src", "$this->siteDir/assets" => "$new/sms-portal-site/assets"] as $current => $next) {
            foreach (self::files($current) as $relative) {
                if (!is_file("$next/$relative")) {
                    $stale[] = "$current/$relative";
                }
            }
        }
        // The version file goes last: a failure part way leaves the old version showing.
        $version = "$this->appDir/VERSION";
        uksort($targets, static fn (string $a, string $b) => ($a === $version) <=> ($b === $version));

        $backup = $this->workDir . '/backup';
        self::removeTree($backup);
        $staged = [];
        try {
            foreach ($targets as $target => $source) {
                $dir = dirname($target);
                if (!self::makeDir($dir)) {
                    throw new \RuntimeException("Cannot create $dir");
                }
                if (!copy($source, $target . self::STAGED)) {
                    throw new \RuntimeException("Cannot write $target");
                }
                $staged[] = $target . self::STAGED;
                // copy() leaves the mode to PHP's umask: where it is 027 or 077, the web server could
                // no longer read the site (403 Forbidden on every page). Same mode as the zip gives it,
                // which also mends files an earlier update left unreadable.
                @chmod($target . self::STAGED, 0644);
            }
            foreach (array_merge(array_keys($targets), $stale) as $target) {
                if (is_file($target) && !self::copyTo($target, $backup . '/' . $this->backupName($target))) {
                    throw new \RuntimeException("Cannot back up $target");
                }
            }
        } catch (\Throwable $e) {
            array_map('unlink', array_filter($staged, 'is_file'));
            Log::error('Update not installed', ['err' => $e]);
            throw new HttpError(500, 'install_failed');
        }

        $done = [];
        try {
            foreach (array_keys($targets) as $target) {
                if (!rename($target . self::STAGED, $target)) {
                    throw new \RuntimeException("Cannot replace $target");
                }
                $done[] = $target;
            }
        } catch (\Throwable $e) {
            foreach ($done as $target) {
                $saved = $backup . '/' . $this->backupName($target);
                is_file($saved) ? copy($saved, $target) : unlink($target);
            }
            array_map('unlink', array_filter($staged, 'is_file'));
            Log::error('Update rolled back', ['err' => $e]);
            throw new HttpError(500, 'install_failed');
        }
        foreach ($stale as $file) {
            @unlink($file);
        }
        // Hosts that never revalidate their opcode cache would keep running the old code.
        if (function_exists('opcache_invalidate')) {
            foreach (array_merge(array_keys($targets), $stale) as $file) {
                if (str_ends_with($file, '.php')) {
                    @opcache_invalidate($file, true);
                }
            }
        }
    }

    private function backupName(string $target): string
    {
        return str_starts_with($target, $this->appDir . '/')
            ? 'sms-portal/' . substr($target, strlen($this->appDir) + 1)
            : 'sms-portal-site/' . substr($target, strlen((string) $this->siteDir) + 1);
    }

    /** Creates a folder of the site or the app, readable by the web server whatever PHP's umask. */
    private static function makeDir(string $dir): bool
    {
        if (is_dir($dir)) {
            return true;
        }
        if (!self::makeDir(dirname($dir)) || (!@mkdir($dir) && !is_dir($dir))) {
            return false;
        }
        // Only the folders made here: the host may keep the existing ones closer on purpose.
        @chmod($dir, 0755);
        return true;
    }

    private static function copyTo(string $source, string $destination): bool
    {
        $dir = dirname($destination);
        return (is_dir($dir) || mkdir($dir, 0700, true)) && copy($source, $destination);
    }

    /** @return list<string> the files under $dir, relative to it */
    private static function files(string $dir): array
    {
        if (!is_dir($dir)) {
            return [];
        }
        $files = [];
        $tree = new \RecursiveIteratorIterator(new \RecursiveDirectoryIterator($dir, \FilesystemIterator::SKIP_DOTS));
        foreach ($tree as $item) {
            if ($item->isFile() && !str_ends_with($item->getFilename(), self::STAGED)) {
                $files[] = str_replace('\\', '/', substr($item->getPathname(), strlen($dir) + 1));
            }
        }
        sort($files);
        return $files;
    }

    private static function removeTree(string $dir): void
    {
        if (!is_dir($dir)) {
            return;
        }
        $tree = new \RecursiveIteratorIterator(new \RecursiveDirectoryIterator($dir, \FilesystemIterator::SKIP_DOTS), \RecursiveIteratorIterator::CHILD_FIRST);
        foreach ($tree as $item) {
            $item->isDir() ? @rmdir($item->getPathname()) : @unlink($item->getPathname());
        }
        @rmdir($dir);
    }

    /**
     * GET with redirects (GitHub sends release files to its CDN), at most $maxBytes.
     *
     * @return array{0: int, 1: ?string} the status (0 when unreachable) and the body
     */
    private static function get(string $url, int $timeout, int $maxBytes, string $version): array
    {
        $body = '';
        $curl = curl_init($url);
        curl_setopt_array($curl, [
            CURLOPT_FOLLOWLOCATION => true,
            CURLOPT_MAXREDIRS => 5,
            CURLOPT_PROTOCOLS => CURLPROTO_HTTP | CURLPROTO_HTTPS,
            CURLOPT_REDIR_PROTOCOLS => CURLPROTO_HTTP | CURLPROTO_HTTPS,
            CURLOPT_TIMEOUT => $timeout,
            CURLOPT_CONNECTTIMEOUT => 15,
            CURLOPT_USERAGENT => "voip-ms-sms-portal/$version (PHP)",
            CURLOPT_WRITEFUNCTION => static function ($curl, string $chunk) use (&$body, $maxBytes): int {
                $body .= $chunk;
                return strlen($body) > $maxBytes ? 0 : strlen($chunk);
            },
        ]);
        $ok = curl_exec($curl);
        $status = (int) curl_getinfo($curl, CURLINFO_RESPONSE_CODE);
        curl_close($curl);
        return $ok === false ? [0, null] : [$status, $body];
    }
}
