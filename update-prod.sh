#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

cd "$SCRIPT_DIR"

# Deploy mode. Default is live (solver open to everyone). Pass --beta to run the
# closed beta: /app/ is gated behind a password and the "Request access" form is
# wired up. The mode is read at container start via the KOFEM_MODE env var (see
# docker-compose.yaml) — the web image is pre-built, so no rebuild is needed.
KOFEM_MODE=live
for arg in "$@"; do
  case "$arg" in
    --beta)
      KOFEM_MODE=beta
      ;;
    --live)
      KOFEM_MODE=live
      ;;
    *)
      echo "Unknown option: $arg" >&2
      echo "Usage: $0 [--beta]" >&2
      exit 1
      ;;
  esac
done
export KOFEM_MODE

PROFILE_ARGS=()
if [ "$KOFEM_MODE" = "beta" ]; then
  # Load .env so we can verify the master password is set (compose also reads it).
  if [ -f .env ]; then
    set -a
    # shellcheck disable=SC1091
    . ./.env
    set +a
  fi
  if [ -z "${KOFEM_BETA_MASTER:-}" ]; then
    echo "Error: beta mode needs a master password, but KOFEM_BETA_MASTER is not set." >&2
    echo "Add it to .env, e.g.:" >&2
    echo "  echo 'KOFEM_BETA_MASTER=choose-a-strong-password' >> .env" >&2
    exit 1
  fi
  PROFILE_ARGS=(--profile beta)
  echo "Mode: BETA (app gated behind a password; /api routed to kofem-access)"
else
  echo "Mode: LIVE (solver open)"
  # Tear down the beta gate service if it was running, so the volume's data
  # persists but the container stops.
  docker compose --profile beta rm -sf kofem-access >/dev/null 2>&1 || true
fi

echo "Pulling latest web image..."
docker compose pull kofem-web

echo "Starting updated containers..."
docker compose "${PROFILE_ARGS[@]}" up -d --build

echo "Removing unused images..."
docker image prune -f

echo "Done."
