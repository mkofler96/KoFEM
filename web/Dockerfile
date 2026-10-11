# Build context is ./web, plus the named context "gallery" = ./examples/gallery/site
# (the /examples/ gallery, which lives outside web/). See .github/workflows/ci.yml,
# "docker" steps:
#
#   docker build --build-context gallery=./examples/gallery/site ./web
#
# Stage 1: Build the static frontend bundle.
#
# Base image is Node with the Bun binary copied in. Bun drives the
# frozen-lockfile install, but `vite` must run under Node: the bun-only image
# has no Node, so vite would run on Bun's runtime, which is incompatible with
# vite-plugin-top-level-await (TypeError: virtualModule.require is not a
# function). With Node present, the `#!/usr/bin/env node` shebang on the vite
# binary resolves to Node and the build succeeds. This is an isolated,
# production-mode build (no source maps), independent of whatever the CI test
# step left in web/dist.
#
# Base images are pinned by digest (the tag is kept for readability): a
# rebuilt tag upstream must not change what ships without a reviewable diff.
# Dependabot proposes the bumps (.github/dependabot.yml).
FROM node:20-bookworm-slim@sha256:2cf067cfed83d5ea958367df9f966191a942351a2df77d6f0193e162b5febfc0 AS builder
COPY --from=oven/bun:1.3.6@sha256:f20d9cf365ab35529384f1717687c739c92e6f39157a35a95ef06f4049a10e4a /usr/local/bin/bun /usr/local/bin/bun

WORKDIR /app

# Copy only dependency manifests first — this layer is cached until
# package.json or bun.lock changes.
COPY package.json bun.lock ./

RUN bun install --frozen-lockfile

# Copy the rest of the source. src/wasm/pkg must already hold the compiled engine
# — it is a build output published as a GitHub Release rather than committed
# (KOF-186), so populate it before building the image:
#
#   bash scripts/fetch-wasm-engine.sh && docker build --build-context gallery=./examples/gallery/site ./web
#
# The `bun run build` below would normally fetch it via its package.json pre-hook,
# but the build context is web/ alone and the repo's scripts/ is not in it; the
# hook detects that and leaves whatever was copied in place. No Emscripten needed.
COPY . .
# vite.config.ts reads the gallery from ../examples/gallery/site.
COPY --from=gallery . /examples/gallery/site

# Optional version stamp injected by CI. Vite exposes VITE_* vars to the
# bundle via import.meta.env at build time.
ARG VITE_GIT_VERSION=local
ENV VITE_GIT_VERSION=$VITE_GIT_VERSION

# Optional Google Analytics (GA4) measurement ID, e.g. G-XXXXXXXXXX. When empty
# (the default) analytics and the cookie-consent banner are omitted from the
# build. When set, GA4 loads only after the visitor accepts the consent banner.
ARG VITE_GA_ID=
ENV VITE_GA_ID=$VITE_GA_ID

RUN bun run build

# Defensive: production images must never contain source maps.
RUN find dist -name '*.map' -type f -delete


# Stage 2: Serve the static bundle with Nginx.
FROM nginx:alpine@sha256:df221db836e1754089190208cee7eeda94f233197056426eda74a43ab1abeac2

COPY --from=builder /app/dist /usr/share/nginx/html

# Render (and similar hosts) inject a dynamic port via $PORT; the nginx
# template is rendered with envsubst at container start.
ENV PORT=10000

# Google Analytics measurement ID, applied to the served HTML at container start
# (see docker-entrypoint.d/40-kofem-ga-config.sh). Set at `docker run` time, e.g.
# `-e VITE_GA_ID=G-XXXXXXXXXX`. Empty (the default) leaves analytics disabled, so
# the same image works with or without analytics — no rebuild required.
ENV VITE_GA_ID=""

COPY nginx.conf.template /etc/nginx/templates/default.conf.template

# Deployment channel, applied at container start (see
# docker-entrypoint.d/30-kofem-channel.sh): empty for production, "dev" for a
# development deployment, which is then marked as such and kept out of search
# engines.
ENV KOFEM_CHANNEL=""

# Run before nginx starts (the base image executes /docker-entrypoint.d/*.sh in
# name order).
COPY docker-entrypoint.d/30-kofem-channel.sh /docker-entrypoint.d/30-kofem-channel.sh
COPY docker-entrypoint.d/40-kofem-ga-config.sh /docker-entrypoint.d/40-kofem-ga-config.sh
RUN chmod +x /docker-entrypoint.d/30-kofem-channel.sh /docker-entrypoint.d/40-kofem-ga-config.sh

EXPOSE 10000

CMD ["nginx", "-g", "daemon off;"]
