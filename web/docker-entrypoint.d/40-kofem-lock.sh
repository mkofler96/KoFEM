#!/bin/sh
# Runtime lock toggle. The nginx:alpine entrypoint runs every
# /docker-entrypoint.d/*.sh before starting nginx, so this renders the
# lock-dependent pieces from the KOFEM_LOCKED env var (set by update-prod.sh
# via docker-compose) — no image rebuild needed to flip between modes.
#
# Writes two files:
#   - /etc/nginx/conf.d/kofem-app.inc : the body of the `/app/` location.
#     Locked -> redirect away (solver unreachable); live -> serve the app.
#   - <html-root>/lock-state.js       : exposes window.KOFEM_LOCKED so the
#     static landing page can swap the launch buttons to "Coming soon".
set -eu

HTML_ROOT="${KOFEM_HTML_ROOT:-/usr/share/nginx/html}"
APP_INC=/etc/nginx/conf.d/kofem-app.inc

if [ "${KOFEM_LOCKED:-0}" = "1" ]; then
  echo "return 302 /;" >"$APP_INC"
  echo "window.KOFEM_LOCKED = true;" >"$HTML_ROOT/lock-state.js"
  echo "[kofem] LOCKED mode: solver disabled, landing shows coming-soon"
else
  echo 'try_files $uri $uri/ /app/index.html;' >"$APP_INC"
  echo "window.KOFEM_LOCKED = false;" >"$HTML_ROOT/lock-state.js"
  echo "[kofem] LIVE mode: solver enabled"
fi
