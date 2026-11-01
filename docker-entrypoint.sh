#!/bin/sh
# Starts the portal: Apache for the site and the API, and the checks of
# VoIP.ms that run while no tab is open (php/app/cron.php, which shared
# hosting runs from cPanel's cron jobs).
#
# Docker creates a missing bind-mounted folder (./data) owned by root. When
# started as root (the default), give the data folder to PUID/PGID (default
# 1000:1000, e.g. to match file ownership on a NAS), then run Apache's
# workers and the checks as that user.
set -eu

APP_DIR=/app/sms-portal
DATA_DIR="${DATA_DIR:-/data}"

if [ "${1:-}" != "apache2-foreground" ]; then
  exec "$@"
fi

# A mistake in the settings stops the container, with its reason in the logs.
php "$APP_DIR/cron.php" --check

if [ "$(id -u)" = "0" ]; then
  uid="${PUID:-1000}"
  gid="${PGID:-1000}"
  mkdir -p "$DATA_DIR"
  # Only touch what is not already owned, so restarts stay fast with many media files.
  find "$DATA_DIR" \( ! -user "$uid" -o ! -group "$gid" \) -exec chown "$uid:$gid" {} +
  export APACHE_RUN_USER="#$uid" APACHE_RUN_GROUP="#$gid"
  as_user() { setpriv --reuid="$uid" --regid="$gid" --clear-groups "$@"; }
else
  if [ ! -w "$DATA_DIR" ]; then
    echo "Cannot write to $DATA_DIR as uid $(id -u). Fix its owner (chown -R $(id -u):$(id -g) on the host folder) or start the container as root." >&2
    exit 1
  fi
  as_user() { "$@"; }
fi

# TRUST_PROXY=true trusts proxies on private networks only (Docker networks,
# localhost), so a client reaching the port directly cannot spoof
# X-Forwarded-For. A list of addresses or subnets also works.
proxies=$(printf '%s' "${TRUST_PROXY:-}" | tr ',' ' ' | xargs)
case "$(printf '%s' "$proxies" | tr '[:upper:]' '[:lower:]')" in
  '' | 0 | false | no | off) proxies='' ;;
  1 | true | yes | on) proxies='127.0.0.0/8 ::1 169.254.0.0/16 fe80::/10 10.0.0.0/8 172.16.0.0/12 192.168.0.0/16 fc00::/7' ;;
esac
export SMS_PORTAL_PROXIES="${proxies:-127.0.0.1}"
if [ -n "$proxies" ]; then
  set -- "$@" -DTRUST_PROXY
fi

# Every 10 seconds; each run decides whether a check of VoIP.ms is due
# (POLL_INTERVAL_IDLE, faster while a tab is open), and a run still going
# makes the next one wait its turn.
(
  while :; do
    as_user php "$APP_DIR/cron.php" || true
    sleep 10
  done
) &

exec "$@"
