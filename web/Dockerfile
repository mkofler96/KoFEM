# Build context is ./web (see .github/workflows/ci.yml, "docker" steps).
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
FROM node:20-bookworm-slim AS builder
COPY --from=oven/bun:latest /usr/local/bin/bun /usr/local/bin/bun

WORKDIR /app

# Copy only dependency manifests first — this layer is cached until
# package.json or bun.lock changes.
COPY package.json bun.lock ./

RUN bun install --frozen-lockfile

# Copy the rest of the source. This includes the pre-compiled WASM engine
# committed under src/wasm/pkg/, so no Emscripten build is needed here.
COPY . .

# Optional version stamp injected by CI. Vite exposes VITE_* vars to the
# bundle via import.meta.env at build time.
ARG VITE_GIT_VERSION=local
ENV VITE_GIT_VERSION=$VITE_GIT_VERSION

RUN bun run build

# Defensive: production images must never contain source maps.
RUN find dist -name '*.map' -type f -delete


# Stage 2: Serve the static bundle with Nginx.
FROM nginx:alpine

COPY --from=builder /app/dist /usr/share/nginx/html

# Render (and similar hosts) inject a dynamic port via $PORT; the nginx
# template is rendered with envsubst at container start.
ENV PORT=10000

COPY nginx.conf.template /etc/nginx/templates/default.conf.template

# Runtime lock toggle: rendered from KOFEM_LOCKED at container start.
COPY docker-entrypoint.d/40-kofem-lock.sh /docker-entrypoint.d/40-kofem-lock.sh
RUN chmod +x /docker-entrypoint.d/40-kofem-lock.sh

EXPOSE 10000

CMD ["nginx", "-g", "daemon off;"]
