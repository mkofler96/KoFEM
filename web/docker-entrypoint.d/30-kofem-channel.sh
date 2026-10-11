#!/bin/sh
# Runs at container start (nginx image executes /docker-entrypoint.d/*.sh before
# starting nginx). Marks the deployment channel in the served site, so one image
# serves kofem.org and the dev deployment alike:
#
#   KOFEM_CHANNEL unset/empty — production: the site is served as built.
#   KOFEM_CHANNEL=dev         — every HTML page gets <meta name="robots"
#                               content="noindex, nofollow"> and
#                               <meta name="kofem-channel" content="dev"> (the app
#                               shows a DEV badge from it), and robots.txt
#                               disallows everything.
#
# Any other value stops the container: a typo must not quietly publish a dev
# build as if it were production.
set -eu

ROOT="/usr/share/nginx/html"
CHANNEL="${KOFEM_CHANNEL:-}"

case "$CHANNEL" in
  "")
    echo "[kofem] Channel: production."
    exit 0
    ;;
  dev) ;;
  *)
    echo "[kofem] KOFEM_CHANNEL='$CHANNEL' is not a known channel (expected empty or 'dev')." >&2
    exit 1
    ;;
esac

echo "[kofem] Channel: dev — noindex, DEV badge."
META='<meta name="robots" content="noindex, nofollow"><meta name="kofem-channel" content="dev">'
find "$ROOT" -type f -name '*.html' -exec sed -i "s#</head>#${META}</head>#" {} +
printf 'User-agent: *\nDisallow: /\n' > "$ROOT/robots.txt"
