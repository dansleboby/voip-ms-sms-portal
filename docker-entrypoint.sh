#!/bin/sh
# Starts the portal as an unprivileged user.
#
# Docker creates a missing bind-mounted folder (./data) owned by root, which
# the "node" user cannot write to. When started as root (the default), give
# the data folder to the target user, then drop privileges. PUID/PGID choose
# that user (default: node, 1000:1000), e.g. to match file ownership on a NAS.
set -eu

DATA_DIR="${DATA_DIR:-/data}"

if [ "$(id -u)" = "0" ]; then
  uid="${PUID:-$(id -u node)}"
  gid="${PGID:-$(id -g node)}"
  mkdir -p "$DATA_DIR"
  # Only touch what is not already owned, so restarts stay fast with many media files.
  find "$DATA_DIR" \( ! -user "$uid" -o ! -group "$gid" \) -exec chown "$uid:$gid" {} +
  exec setpriv --reuid="$uid" --regid="$gid" --clear-groups "$@"
fi

if [ ! -w "$DATA_DIR" ]; then
  echo "Cannot write to $DATA_DIR as uid $(id -u). Fix its owner (chown -R $(id -u):$(id -g) on the host folder) or start the container as root." >&2
  exit 1
fi
exec "$@"
