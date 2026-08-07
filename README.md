<p align="center">
  <img src="web/public/kofem_logo.svg" alt="KoFEM logo" width="256" />
</p>

<h1 align="center">KoFEM</h1>

KoFEM is Finite element analysis tool made to run in your browser, without installation and without sending data to any server or cloud. It runs the full pipeline — **STEP geometry → OCCT tessellation → Netgen
volume mesh → MFEM FEM solve** — directly in the browser via a C++ engine
compiled to WebAssembly, with a React + Three.js frontend. The software can be launched from the official website [kofem.org](https://kofem.org/) or run locally via docker.

## Examples

![](web/screenshots/plate-with-hole_screenshot.png)

Click here to view this example on KoFEM web [Plate with Hole](https://kofem.org/app/?example=plate-with-hole)

![](web/screenshots/beam-torsion_screenshot.png)
Click here to view this example on KoFEM web [Beam Torsion](https://kofem.org/app/?example=beam-torsion)

For more examples visit [KoFEM Examples](https://kofem.org/examples/)

## Run it with Docker

The app is a static frontend (pre-built WASM engine + React UI) served by Nginx.
The compiled WASM engine is downloaded as a prebuilt binary, so **you don't need
Emscripten, Rust, or the C++ libraries — just Docker.** The container listens on
port **10000**.

Option A — Pull the published image (recommended)

```bash
docker run ghcr.io/mkofler96/kofem-web:latest
```

Option B — Build it yourself

```bash
# Fetch the prebuilt engine into web/src/wasm/pkg/ (see Development below).
bash scripts/fetch-wasm-engine.sh

# Build context is the web/ directory (Dockerfile lives at web/Dockerfile).
docker build -t kofem-web ./web
docker run kofem-web
```

## Development

```bash
cd web && bun install && bun run dev
```

That is all you need — the compiled engine (~34 MB) is a build output, so it is
published as a GitHub Release rather than committed, and `bun run dev`, `build`
and `test` download the one matching your checkout via
`scripts/fetch-wasm-engine.sh`. You can also run that script directly.

To change the engine you do need the C++ toolchain. `bash scripts/docker-build-wasm.sh`
compiles it inside a Docker container and writes `web/src/wasm/pkg/` itself; from
then on the fetch step sees your local build and leaves it alone. CI publishes the
release for your sources once they land on `main`.

> [!NOTE]
> The wasm docker build is layered on top of [KoFEM-Dependencies](https://github.com/mkofler96/KoFEM-Dependencies), which contains the precompiled wasm OCCT, Netgen and MFEM libraries. KoFEM can be compiled without docker using the script `scripts/build-wasm.sh`, but then the OCCT, Netgen and MFEM source code must be downloaded and will be compiled during the KoFEM compilation. This will take some time.

## Disclaimer

KoFEM is research-grade software provided for education and exploration. It is
**not** a certified engineering tool. Finite element results are approximations
and may be wrong; **no result should be relied upon without independent
verification** by a qualified engineer. The authors accept **no liability** for
any real-world failure, damage, or loss arising from use of this software or its
output. See [DISCLAIMER.md](DISCLAIMER.md) for the full text. By using KoFEM you
accept these terms.

## License

KoFEM is free and open-source software, licensed under the
**[GNU Affero General Public License v3.0 or later](LICENSE)** (AGPL-3.0-or-later).

KoFEM builds on third-party libraries — **OpenCASCADE** (LGPL-2.1 with an
exception), **Netgen** (LGPL-2.1), and **MFEM** (BSD-3-Clause) — each retaining
its own license. See [THIRD-PARTY-LICENSES.md](THIRD-PARTY-LICENSES.md) for the
full attribution and compatibility notes.

## Funding

If you enjoyed what I built, consider [buying me a coffee ☕](https://buymeacoffee.com/mkofler). Thanks for your support!
