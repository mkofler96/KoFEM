# KoFEM — AI Development Guide

KoFEM is a browser-first finite element analysis application. This file is the primary context for Claude Code when working on this codebase.

## Architecture Overview

The pipeline is: **STEP geometry → OCCT tessellation → Netgen volume mesh → MFEM FEM solve**

```
KoFEM/
├── engine/             # C++ WASM engine (browser entry-point)
│   ├── cpp/engine.cpp  # Full pipeline via Emscripten Embind
│   └── CMakeLists.txt  # emcmake build → kofem_wasm_emcc.js + .wasm
├── crates/
│   ├── kofem-geom/     # OCCT wrapper: STEP import + surface tessellation (native / Python)
│   ├── kofem-mesh/     # Netgen wrapper: quality tetrahedral volume meshing (native / Python)
│   │                   # also defines the shared SurfaceMesh / VolumeMesh types
│   ├── kofem-core/     # MFEM wrapper: linear-elastic FEM via FemSolver trait (native / Python)
│   ├── kofem-py/       # Python bindings (PyO3 / maturin)
│   └── kofem-wasm/     # Legacy Rust WASM bindings (unused for browser build)
├── web/                # React + Three.js frontend (Vite)
├── scripts/
│   ├── build-wasm.sh        # CMake/Emscripten WASM build
│   └── docker-build-wasm.sh # Docker wrapper (Mac / CI)
├── python/             # Python package (maturin build)
└── docs/               # Project specs, roadmap, ADRs
```

### WASM build flow

```
OCCT / Netgen / MFEM  (.a, compiled with emcc)
         ↓
engine/cpp/engine.cpp  (C++17, calls libs directly, Embind API)
         ↓  emcmake cmake + ninja
kofem_wasm_emcc.js + kofem_wasm.wasm
         ↓
web/src/wasm/pkg/kofem_wasm.js  (thin adapter, committed)
         ↓
solver.worker.ts  (unchanged API: init() + named exports)
```

### Incremental Rust migration

When a piece of the pipeline is re-implemented in Rust, compile the relevant
crate as `crate-type = ["staticlib"]` targeting `wasm32-unknown-emscripten`,
expose the new logic via `extern "C"`, and call it from `engine.cpp`.  The
CMakeLists.txt gets one extra `target_link_libraries` entry — nothing else
changes.

### C++ bridge layout (native / Python builds)

Each Rust crate that wraps a C++ library has:
```
crates/kofem-{geom,mesh,core}/
├── build.rs            # detects installed libs, compiles bridge, emits link flags
├── include/            # C header declaring the extern "C" bridge API
└── cpp/                # thin C++ wrapper calling the real library
```

### Solver abstraction

`kofem-core` exposes a `FemSolver` trait.  `MfemSolver` is the default implementation.
To swap MFEM for a different solver, implement `FemSolver` in a new module and wire it
into `kofem-py` — no other crate changes are needed.

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
