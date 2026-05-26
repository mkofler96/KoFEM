# KoFEM — AI Development Guide

KoFEM is a browser-first finite element analysis application. This file is the primary context for Claude Code when working on this codebase.

## Architecture Overview

The pipeline is: **STEP geometry → OCCT tessellation → Netgen volume mesh → MFEM FEM solve**

```
KoFEM/
├── crates/
│   ├── kofem-geom/     # OCCT wrapper: STEP import + surface tessellation
│   ├── kofem-mesh/     # Netgen wrapper: quality tetrahedral volume meshing
│   │                   # also defines the shared SurfaceMesh / VolumeMesh types
│   ├── kofem-core/     # MFEM wrapper: linear-elastic FEM via FemSolver trait
│   ├── kofem-py/       # Python bindings (PyO3 / maturin)
│   └── kofem-wasm/     # WASM bindings (wasm-bindgen, Emscripten target)
├── web/                # React + Three.js frontend (Vite)
├── scripts/
│   └── build-wasm.sh  # Emscripten WASM build script
├── python/             # Python package (maturin build)
└── docs/               # Project specs, roadmap, ADRs
```

### C++ bridge layout

Each crate that wraps a C++ library has:
```
crates/kofem-{geom,mesh,core}/
├── build.rs            # detects installed libs, compiles bridge, emits link flags
├── include/            # C header declaring the extern "C" bridge API
└── cpp/                # thin C++ wrapper calling the real library
```

### Solver abstraction

`kofem-core` exposes a `FemSolver` trait.  `MfemSolver` is the default implementation.
To swap MFEM for a different solver, implement `FemSolver` in a new module and wire it
into `kofem-wasm`/`kofem-py` — no other crate changes are needed.

## Native prerequisites

Install the three C++ libraries before building natively:

| Library | Version | Install hint |
|---------|---------|--------------|
| OpenCASCADE (OCCT) | ≥ 7.6 | `apt install libocct-*-dev` or build from source |
| Netgen | ≥ 6.2 | build from source, installs `libnglib` |
| MFEM | ≥ 4.6 | `apt install libmfem-dev` or build from source |

Point the build system at non-standard install prefixes via environment variables:
```bash
export OCCT_ROOT=/opt/occt
export NETGEN_ROOT=/opt/netgen
export MFEM_DIR=/opt/mfem
```

## First-time setup

```bash
git config core.hooksPath .githooks
```

## Build Commands

```bash
# Check Rust compiles (requires native libs installed)
cargo check

# Build and test Rust
cargo test

# Build WASM (requires Emscripten + pre-compiled WASM libs — see scripts/build-wasm.sh)
OCCT_WASM_ROOT=... NETGEN_WASM_ROOT=... MFEM_WASM_ROOT=... ./scripts/build-wasm.sh

# Install and run the web frontend (uses bun, not npm)
cd web && bun install && bun run dev
```

## Code Style

- Before committing, always run `cargo fmt` and `cargo clippy`
- TypeScript: strict mode, no `any`
- Comments only for non-obvious physics/math — reference the paper/equation instead of explaining the code
- ALWAYS prefer clear and information-rich error messages over silent fall-throughs. Avoid defensive try/catch blocks to make debugging easier.

## Pull Request Convention

Always include `closes #<issue-number>` in the PR description body so that merging the PR automatically closes the linked issue on GitHub.
