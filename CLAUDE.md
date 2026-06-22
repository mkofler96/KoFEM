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
│   ├── kofem-geom/     # OCCT wrapper: STEP import + surface tessellation (native)
│   ├── kofem-mesh/     # Netgen wrapper: quality tetrahedral volume meshing (native)
│   │                   # also defines the shared SurfaceMesh / VolumeMesh types
│   └── kofem-core/     # MFEM wrapper: linear-elastic FEM via FemSolver trait (native)
├── web/                # React + Three.js frontend (Vite)
├── scripts/
│   ├── build-wasm.sh        # CMake/Emscripten WASM build
│   └── docker-build-wasm.sh # Docker wrapper (Mac / CI)
└── docs/               # Project specs, roadmap, ADRs
```

### WASM build flow

```
OCCT / Netgen / MFEM  (.a, compiled with emcc)
         ↓
engine/cpp/engine.cpp  (C++17, calls libs directly, Embind API)
         ↓  emcmake cmake + ninja
kofem_wasm_emcc.js + kofem_wasm_emcc.wasm
         ↓
web/src/wasm/pkg/kofem_wasm.js  (thin adapter, committed)
         ↓
solver.worker.ts  (unchanged API: init() + named exports)
```

### Incremental Rust migration

When a piece of the pipeline is re-implemented in Rust, compile the relevant
crate as `crate-type = ["staticlib"]` targeting `wasm32-unknown-emscripten`,
expose the new logic via `extern "C"`, and call it from `engine.cpp`. The
CMakeLists.txt gets one extra `target_link_libraries` entry — nothing else
changes.

### C++ bridge layout (native builds)

Each Rust crate that wraps a C++ library has:

```
crates/kofem-{geom,mesh,core}/
├── build.rs            # detects installed libs, compiles bridge, emits link flags
├── include/            # C header declaring the extern "C" bridge API
└── cpp/                # thin C++ wrapper calling the real library
```

### Solver abstraction

`kofem-core` exposes a `FemSolver` trait. `MfemSolver` is the default implementation.
To swap MFEM for a different solver, implement `FemSolver` in a new module — no other
crate changes are needed.

## Native prerequisites

Install the three C++ libraries before building natively:

| Library            | Version | Install hint                                     |
| ------------------ | ------- | ------------------------------------------------ |
| OpenCASCADE (OCCT) | ≥ 7.6   | `apt install libocct-*-dev` or build from source |
| Netgen             | ≥ 6.2   | build from source, installs `libnglib`           |
| MFEM               | ≥ 4.6   | `apt install libmfem-dev` or build from source   |

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

## Geometry vs. Mesh — Critical Terminology

There are three distinct representations in this codebase. Using the wrong word is a bug in the code and the UI.

| Concept                   | What it is                                               | Produced by                                               | Used for                                                       |
| ------------------------- | -------------------------------------------------------- | --------------------------------------------------------- | -------------------------------------------------------------- |
| **Geometry tessellation** | Triangles approximating the CAD surface for display only | OCCT (`kofem-geom`)                                       | Viewport rendering of the STEP shape (Geometry repr)           |
| **Surface mesh**          | Quality triangulation of the CAD boundary surfaces       | OCCT tessellation **or** Netgen's direct OCCT integration | Input to the volume mesher + display (Surface Mesh repr)       |
| **Volume mesh**           | Tetrahedral elements filling the solid body              | Netgen (`kofem-mesh`)                                     | FEM analysis — nodes + elements for stiffness matrix and solve |

The surface mesh comes from the **geometry**, not from the volume mesh. It is either the OCCT tessellation repurposed as meshing input, or (preferred) a proper boundary mesh produced by Netgen's built-in OCCT integration, which respects CAD topology and feature edges.

**Rules — never violate these:**

- **Geometry tessellation triangles are NOT a mesh.** They are a visual approximation of the CAD surface. Never call them "mesh", "surface mesh", or use mesh-related variable names (`mesh`, `meshTriangles`, etc.) for them. Correct names: `tessellation`, `stepTessellation`, `stepSurface`, `geomTriangles`.
- **"Mesh" always means FEM mesh** — nodes + elements produced by Netgen and used for analysis. The words `mesh`, `meshing`, `meshResult` are reserved for Netgen output and FEM data.
- **The pipeline:** geometry → tessellation (display) → surface mesh (from geometry, input to Netgen) → volume mesh (FEM) → solve. Tessellation serves display; the volume mesh is what the solver operates on.
- In the UI the three viewport representations map to: **Geometry** shows the OCCT tessellation, **Surface Mesh** shows the boundary triangulation of the FEM model, **Volume Mesh** shows all tetrahedral edges.

## Code Style

- Before committing, always run `cargo fmt` and `cargo clippy`
- TypeScript: strict mode, no `any`
- Comments only for non-obvious physics/math — reference the paper/equation instead of explaining the code
- ALWAYS prefer clear and information-rich error messages over silent fall-throughs. Avoid defensive try/catch blocks to make debugging easier.

## Pull Request Convention

Always include `closes #<issue-number>` in the PR description body so that merging the PR automatically closes the linked issue on GitHub.
