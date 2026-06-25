#!/bin/sh
# Runtime mode toggle. The nginx:alpine entrypoint runs every
# /docker-entrypoint.d/*.sh before starting nginx, so this renders the
# mode-dependent pieces from the KOFEM_MODE env var (set by update-prod.sh via
# docker-compose) — no image rebuild needed to switch between modes.
#
# Renders three files:
#   /etc/nginx/conf.d/kofem-app.inc    : body of the `location /app/` block.
#   /etc/nginx/conf.d/kofem-server.inc : server-level block (beta proxy + gate).
#   <html-root>/mode-state.js          : window.KOFEM_MODE for the landing page.
#
# live : serve the app normally.
# beta : gate /app/ behind the password (auth_request -> kofem-access) and
#        proxy /api/* to kofem-access for login + "request access".
set -eu

HTML_ROOT="${KOFEM_HTML_ROOT:-/usr/share/nginx/html}"
APP_INC=/etc/nginx/conf.d/kofem-app.inc
SERVER_INC=/etc/nginx/conf.d/kofem-server.inc
MODE="${KOFEM_MODE:-live}"

case "$MODE" in
  beta)
    cat >"$APP_INC" <<'EOF'
auth_request /__kofem_beta_verify;
error_page 401 = @kofem_beta_gate;
try_files $uri $uri/ /app/index.html;
EOF
    # Variable proxy_pass + resolver defers DNS to request time, so nginx still
    # boots if kofem-access is momentarily down (it returns 502 on /api, not a
    # startup failure). 127.0.0.11 is Docker's embedded DNS on user networks.
    cat >"$SERVER_INC" <<'EOF'
resolver 127.0.0.11 ipv6=off valid=30s;
set $kofem_access http://kofem-access:8080;

location @kofem_beta_gate {
    return 302 /beta/;
}

location /api/ {
    client_max_body_size 8k;
    proxy_pass $kofem_access;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
}

location = /__kofem_beta_verify {
    internal;
    proxy_pass $kofem_access/api/beta/verify;
    proxy_pass_request_body off;
    proxy_set_header Content-Length "";
    proxy_set_header Cookie $http_cookie;
}
EOF
    echo 'window.KOFEM_MODE = "beta";' >"$HTML_ROOT/mode-state.js"
    echo "[kofem] BETA mode: /app/ gated behind password, /api -> kofem-access"
    ;;
  live)
    echo 'try_files $uri $uri/ /app/index.html;' >"$APP_INC"
    : >"$SERVER_INC"
    echo 'window.KOFEM_MODE = "live";' >"$HTML_ROOT/mode-state.js"
    echo "[kofem] LIVE mode: solver open"
    ;;
  *)
    echo "[kofem] ERROR: unknown KOFEM_MODE='$MODE' (expected live|beta)" >&2
    exit 1
    ;;
esac
