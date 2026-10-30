<?php

declare(strict_types=1);

namespace SmsPortal\Http;

use SmsPortal\Viewer;

final class Request
{
    private ?array $json = null;

    /**
     * Who signed the request in (App::handle sets it), as Auth::verify returns it.
     *
     * @var ?array{sessionId: string, userId: ?int, email: ?string, name: ?string, role: string}
     */
    public ?array $user = null;

    /** What they see and may do (App::handle sets it, with $user). */
    public ?Viewer $viewer = null;

    /**
     * @param array<string, string> $headers lowercase names
     * @param array<string, string> $params filled by the router from the path
     */
    public function __construct(
        public readonly string $method,
        public readonly string $path,
        public readonly array $query,
        public readonly array $headers,
        public readonly array $cookies,
        public readonly string $ip,
        public readonly bool $https,
        private readonly string $rawBody = '',
        public readonly array $post = [],
        public readonly array $files = [],
        public array $params = [],
    ) {
    }

    public static function fromGlobals(): self
    {
        $headers = [];
        foreach ($_SERVER as $key => $value) {
            if (str_starts_with($key, 'HTTP_')) {
                $headers[strtolower(str_replace('_', '-', substr($key, 5)))] = (string) $value;
            } elseif ($key === 'CONTENT_TYPE' || $key === 'CONTENT_LENGTH') {
                $headers[strtolower(str_replace('_', '-', $key))] = (string) $value;
            }
        }
        $method = strtoupper($_SERVER['REQUEST_METHOD'] ?? 'GET');
        // The raw path, never decoded: "/%61pi/..." must not reach the API routes.
        $path = (string) parse_url($_SERVER['REQUEST_URI'] ?? '/', PHP_URL_PATH);
        $multipart = str_starts_with($headers['content-type'] ?? '', 'multipart/form-data');
        return new self(
            method: $method,
            path: $path,
            query: $_GET,
            headers: $headers,
            cookies: $_COOKIE,
            ip: (string) ($_SERVER['REMOTE_ADDR'] ?? ''),
            https: (!empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off')
                || strtolower($headers['x-forwarded-proto'] ?? '') === 'https',
            rawBody: $multipart || $method === 'GET' ? '' : (string) file_get_contents('php://input'),
            post: $_POST,
            files: $_FILES,
        );
    }

    public function header(string $name): ?string
    {
        return $this->headers[strtolower($name)] ?? null;
    }

    public function param(string $name): string
    {
        return $this->params[$name] ?? '';
    }

    /** The JSON body, as an object; anything else is an invalid request. */
    public function json(): array
    {
        if ($this->json === null) {
            $data = $this->rawBody === '' ? [] : json_decode($this->rawBody, true);
            if (!is_array($data) || ($data !== [] && array_is_list($data))) {
                throw new InvalidRequest('Expected a JSON object');
            }
            $this->json = $data;
        }
        return $this->json;
    }
}
