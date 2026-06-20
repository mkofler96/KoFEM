# KoFEM

KoFEM is a browser-first finite element analysis application. It runs the full
pipeline — **STEP geometry → OCCT tessellation → Netgen volume mesh → MFEM FEM
solve** — directly in the browser via a C++ engine compiled to WebAssembly,
with a React + Three.js frontend.

For architecture and development details, see [`CLAUDE.md`](./CLAUDE.md).

## Running the production app with Docker

The production app is a static frontend (pre-built WASM engine + React UI)
served by Nginx. The image is self-contained: the compiled WASM engine is
committed under `web/src/wasm/pkg/`, so **you do not need Emscripten, Rust, or
the C++ libraries to build or run it** — just Docker.

The container listens on port **10000** inside the image.

### Option A — Build and run the image yourself

```bash
# From the repository root.
# The build context is the web/ directory (the Dockerfile lives at web/Dockerfile).
docker build -t kofem-web ./web

# Run it, mapping host port 8080 → container port 10000.
docker run --rm -p 8080:10000 kofem-web
```

Then open <http://localhost:8080> in your browser. The marketing landing page
is served at `/`, and the solver app at `/app/`.

To stop it, press `Ctrl+C` (or `docker stop <container>` if you ran it
detached with `-d`).

#### Choosing a different port

The container's internal port is configurable via the `PORT` environment
variable (default `10000`). Only change this if something else is already using
10000 _inside_ the container — for normal use, just change the host side of the
`-p` mapping:

```bash
# Serve on http://localhost:3000 instead.
docker run --rm -p 3000:10000 kofem-web
```

#### Optional: stamp a version

CI passes a version string into the bundle via a build arg. You can do the same:

```bash
docker build -t kofem-web --build-arg VITE_GIT_VERSION="$(git describe --tags --always)" ./web
```

### Option B — Use the pre-built image from the registry

Published images are available at `ghcr.io/mkofler96/kofem-web:latest`. The
repository ships a `docker-compose.yaml` and a helper script that pulls and
(re)starts the container:

```bash
# Pulls the latest image and starts it in the background.
./update-prod.sh
```

> **Note:** `docker-compose.yaml` is wired to an external Docker network
> (`dashboard_mybasil-network`) used by the production deployment behind a
> reverse proxy, and `expose`s the port to that network rather than publishing
> it to the host. For a quick local run, prefer **Option A** above, which
> publishes the port directly with `-p`.

## Development

See [`CLAUDE.md`](./CLAUDE.md) for native build prerequisites (OCCT, Netgen,
MFEM), the WASM build flow, and frontend dev commands. The short version for
the web frontend:

```bash
cd web && bun install && bun run dev
```
