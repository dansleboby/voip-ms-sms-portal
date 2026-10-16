<?php

declare(strict_types=1);

namespace SmsPortal\Http;

final class Response
{
    /** @var list<string> */
    public array $cookies = [];

    /**
     * @param array<string, string> $headers
     */
    public function __construct(
        public int $status = 200,
        public array $headers = [],
        public string $body = '',
        /** Sent from disk instead of $body. */
        public ?string $file = null,
    ) {
    }

    public static function json(mixed $data, int $status = 200): self
    {
        $body = json_encode($data, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_INVALID_UTF8_SUBSTITUTE | JSON_THROW_ON_ERROR);
        return new self($status, ['Content-Type' => 'application/json; charset=utf-8'], $body);
    }

    public static function error(int $status, string $code, array $extra = []): self
    {
        return self::json(['error' => $code] + $extra, $status);
    }

    public function header(string $name, string $value): self
    {
        $this->headers[$name] = $value;
        return $this;
    }

    public function cookie(string $name, string $value, array $options): self
    {
        $cookie = $name . '=' . $value . '; Path=' . ($options['path'] ?? '/');
        if (isset($options['maxAge'])) {
            $cookie .= '; Max-Age=' . $options['maxAge'];
            $cookie .= '; Expires=' . gmdate('D, d M Y H:i:s \G\M\T', time() + $options['maxAge']);
        }
        if (!empty($options['httpOnly'])) {
            $cookie .= '; HttpOnly';
        }
        if (!empty($options['secure'])) {
            $cookie .= '; Secure';
        }
        if (!empty($options['sameSite'])) {
            $cookie .= '; SameSite=' . $options['sameSite'];
        }
        $this->cookies[] = $cookie;
        return $this;
    }

    /**
     * Sends everything and lets the browser go: the rest of the script (work
     * deferred until after the response) no longer holds it up.
     */
    public function send(): void
    {
        // Compressed output is held until the script ends, work after the response included.
        @ini_set('zlib.output_compression', '0');
        while (ob_get_level() > 0) {
            ob_end_clean();
        }
        http_response_code($this->status);
        foreach ($this->headers as $name => $value) {
            header("$name: $value");
        }
        foreach ($this->cookies as $cookie) {
            header("Set-Cookie: $cookie", false);
        }
        if ($this->file !== null) {
            header('Content-Length: ' . filesize($this->file));
            readfile($this->file);
        } else {
            header('Content-Length: ' . strlen($this->body));
            echo $this->body;
        }
        if (function_exists('fastcgi_finish_request')) {
            fastcgi_finish_request();
        } elseif (function_exists('litespeed_finish_request')) {
            litespeed_finish_request();
        } else {
            // With the length known, the browser has the whole response once it is flushed.
            flush();
        }
    }
}
