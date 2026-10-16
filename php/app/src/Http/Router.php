<?php

declare(strict_types=1);

namespace SmsPortal\Http;

final class Router
{
    /** @var list<array{method: string, regex: string, handler: callable, public: bool}> */
    private array $routes = [];

    /**
     * @param string $pattern like "/api/conversations/{id}/messages"; a parameter never spans a "/"
     * @param callable(Request): Response $handler
     * @param bool $public reachable without signing in
     */
    public function add(string $method, string $pattern, callable $handler, bool $public = false): void
    {
        $regex = '#^' . preg_replace('#\\\\\{(\w+)\\\\\}#', '(?P<$1>[^/]+)', preg_quote($pattern, '#')) . '$#';
        $this->routes[] = ['method' => $method, 'regex' => $regex, 'handler' => $handler, 'public' => $public];
    }

    /**
     * The first route matching the method and path, in the order they were added.
     *
     * @return array{handler: callable, public: bool, params: array<string, string>}|null
     */
    public function match(string $method, string $path): ?array
    {
        foreach ($this->routes as $route) {
            if ($route['method'] !== $method && !($method === 'HEAD' && $route['method'] === 'GET')) {
                continue;
            }
            if (preg_match($route['regex'], $path, $m)) {
                $params = array_map('rawurldecode', array_filter($m, 'is_string', ARRAY_FILTER_USE_KEY));
                return ['handler' => $route['handler'], 'public' => $route['public'], 'params' => $params];
            }
        }
        return null;
    }
}
