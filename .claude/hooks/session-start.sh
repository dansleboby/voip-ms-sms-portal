#!/bin/bash
# Prepares a Claude Code cloud session: npm dependencies for the tests and the
# typecheck, PHP for the PHP server's tests, and origin/HEAD for commands that
# compare with the default branch (git diff origin/HEAD..., /security-review).
set -euo pipefail

if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

cd "$CLAUDE_PROJECT_DIR"

# npm install rather than npm ci: it reuses the node_modules the container keeps.
# Playwright is only for npm run screenshots, and the image brings its browser.
PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm install --no-audit --no-fund

# The server and its tests need PHP 8.4+ with pdo_sqlite, openssl, curl, mbstring and intl.
if ! command -v php >/dev/null 2>&1; then
  if command -v apt-get >/dev/null 2>&1 && [ "$(id -u)" = "0" ]; then
    apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq php-cli php-sqlite3 php-curl php-mbstring php-intl >/dev/null \
      || echo "PHP could not be installed: the tests need PHP 8.4 or later." >&2
  else
    echo "PHP is not installed: the tests need PHP 8.4 or later." >&2
  fi
fi
if command -v php >/dev/null 2>&1 && ! php -r 'exit(PHP_VERSION_ID >= 80400 ? 0 : 1);'; then
  echo "PHP $(php -r 'echo PHP_VERSION;') is too old for the tests, which need 8.4 or later (Debian 13 has it; Ubuntu 24.04 does not)." >&2
fi

# A clone of one branch has no origin/HEAD: point it at the default branch.
if ! git symbolic-ref -q refs/remotes/origin/HEAD >/dev/null; then
  default=$(git ls-remote --symref origin HEAD 2>/dev/null | sed -n 's|^ref: refs/heads/\(.*\)\tHEAD$|\1|p')
  default=${default:-main}
  if git fetch -q origin "+refs/heads/$default:refs/remotes/origin/$default" 2>/dev/null \
    || git rev-parse -q --verify "refs/remotes/origin/$default" >/dev/null; then
    git symbolic-ref refs/remotes/origin/HEAD "refs/remotes/origin/$default"
  else
    echo "Could not reach origin to set origin/HEAD." >&2
  fi
fi
