#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

cd "$SCRIPT_DIR"

# Locked / "coming soon" mode. Default is live (solver enabled). Pass --locked
# to serve the landing page with the launch buttons swapped to "Coming soon"
# and the solver at /app/ made inaccessible. The flag is read at container
# start via the KOFEM_LOCKED env var (see docker-compose.yaml) — no rebuild.
KOFEM_LOCKED=0
for arg in "$@"; do
  case "$arg" in
    --locked)
      KOFEM_LOCKED=1
      ;;
    --live|--unlocked)
      KOFEM_LOCKED=0
      ;;
    *)
      echo "Unknown option: $arg" >&2
      echo "Usage: $0 [--locked]" >&2
      exit 1
      ;;
  esac
done
export KOFEM_LOCKED

if [ "$KOFEM_LOCKED" = "1" ]; then
  echo "Mode: LOCKED (coming soon — solver disabled)"
else
  echo "Mode: LIVE (solver enabled)"
fi

echo "Pulling latest image..."
docker compose pull

echo "Starting updated containers..."
docker compose up -d

echo "Removing unused images..."
docker image prune -f

echo "Done."
