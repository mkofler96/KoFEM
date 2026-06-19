#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

cd "$SCRIPT_DIR"

echo "Pulling latest image..."
docker compose pull

echo "Starting updated containers..."
docker compose up -d

echo "Removing unused images..."
docker image prune -f

echo "Done."
