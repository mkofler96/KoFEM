#!/bin/sh
# Runs at container start (nginx image executes /docker-entrypoint.d/*.sh before
# starting nginx). Fills the Google Analytics measurement ID into the pre-built
# static HTML so the image can be built ONCE — without a GA ID — and configured
# at runtime via the VITE_GA_ID env var. No rebuild needed to set, change, or
# disable analytics.
#
# The build ships a placeholder token inside the consent-gated gtag loader; this
# replaces it with $VITE_GA_ID across every served HTML file. If VITE_GA_ID is
# unset/empty the placeholder is left in place and the loader treats it as "not
# configured" (no banner, no analytics, no cookies). Kept in sync with the
# GA_PLACEHOLDER constant in web/vite-analytics.ts.
set -eu

ROOT="/usr/share/nginx/html"
PLACEHOLDER="__KOFEM_GA_ID__"
ID="${VITE_GA_ID:-}"

if [ -z "$ID" ]; then
  echo "[kofem] VITE_GA_ID not set — Google Analytics disabled."
  exit 0
fi

# Only accept a well-formed GA measurement ID; refuse anything else so a stray
# runtime value can't inject markup or script into the served pages.
if ! printf '%s' "$ID" | grep -Eq '^[A-Za-z0-9_-]+$'; then
  echo "[kofem] VITE_GA_ID='$ID' is not a valid measurement ID — analytics disabled." >&2
  exit 0
fi

echo "[kofem] Enabling Google Analytics ($ID)."
find "$ROOT" -type f -name '*.html' -exec sed -i "s/${PLACEHOLDER}/${ID}/g" {} +
