# Build context is ./web (see .github/workflows/docker-image.yml).
#
# Stage 1: Build the static frontend bundle with Bun.
FROM oven/bun:latest AS builder

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


# Stage 2: Serve the static bundle with Nginx.
FROM nginx:alpine

COPY --from=builder /app/dist /usr/share/nginx/html

# Render (and similar hosts) inject a dynamic port via $PORT; the nginx
# template is rendered with envsubst at container start.
ENV PORT=10000

COPY nginx.conf.template /etc/nginx/templates/default.conf.template

EXPOSE 10000

CMD ["nginx", "-g", "daemon off;"]
