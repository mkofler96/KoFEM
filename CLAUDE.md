# KoFEM — AI Development Guide

KoFEM is a browser-first finite element analysis application. This file is the primary context for Claude Code when working on this codebase.

## Architecture Overview

```
KoFEM/
├── crates/
│   ├── kofem-core/     # no_std Rust solver — runs in WASM and natively
│   ├── kofem-wasm/     # wasm-bindgen bindings for the browser
│   └── kofem-py/       # PyO3 bindings for Python scripting
├── web/                # React + Three.js frontend (Vite)
├── python/             # Python package (maturin build)
└── docs/               # Project specs, roadmap, ADRs
```

## Key Architectural Constraints

- **`kofem-core` must stay `no_std`-compatible.** Never add `std`-only imports without wrapping in `#[cfg(feature = "std")]`. Use `alloc::vec::Vec`, not `std::vec::Vec`.
- **WASM runs in a Web Worker** (`web/src/workers/solver.worker.ts`) — never touch the DOM from there.
- **Coordinate system:** right-handed, Z-up. All positions in meters, forces in Newtons.
- **DOF ordering per node:** `[ux, uy, uz, rx, ry, rz]` (indices 0-5). This is fixed globally.
- **Global stiffness assembly** uses a COO sparse format before converting to CSC for factorization.

## Build Commands

```bash
# Check Rust compiles
cargo check

# Build and test Rust
cargo test

# Build WASM (requires wasm-pack)
wasm-pack build crates/kofem-wasm --target web --out-dir web/src/wasm/pkg

# Install and run the web frontend
cd web && npm install && npm run dev

# Build Python bindings (requires maturin)
cd python && maturin develop
```

## Current Implementation Status

| Component | Status |
|-----------|--------|
| `Mesh` data structure | Done |
| `IsotropicElastic` material | Done |
| `Beam2Element` local stiffness | Done (needs global transform) |
| `Shell4Element` (MITC4) | Stub — needs Gauss integration |
| `LinearStaticSolver` | Skeleton — element assembly loop missing |
| Global DOF mapping / scatter | Not started |
| WASM JSON model deserialization | Not started |
| React viewport rendering mesh | Stub |
| Result colormap / legend | Not started |

## Next Priorities (see docs/ROADMAP.md)

1. **Sparse global stiffness assembly** — implement scatter loop in `solver/linear.rs`
2. **Beam2 global transformation** — rotation matrix from local to global in `elements/beam.rs`
3. **MITC4 shell stiffness** — Gauss integration loop in `elements/shell.rs`
4. **WASM model deserialization** — parse JSON in `kofem-wasm/src/lib.rs`
5. **Mesh rendering in Three.js** — `MeshScene.tsx` BufferGeometry from store

## FEM Conventions

- Gauss integration: use 2×2×2 for volume, 2×2 for surface elements
- Element stiffness: `K_e = ∫ Bᵀ D B dV`, assembled via `scatter_add` into global K
- Shell formulation: MITC4 (Bathe & Dvorkin 1985) — mixed interpolation to avoid shear locking
- Beam formulation: Euler-Bernoulli for slender beams; add Timoshenko shear factor κ for thick beams
- BCs: penalty method currently (1e14 × max diagonal); switch to elimination for production

## Testing

- Unit test element stiffness matrices against Abaqus/textbook reference values
- Integration test: cantilever beam tip deflection `δ = PL³/(3EI)`, error < 1%
- Integration test: simply supported beam midspan deflection `δ = 5wL⁴/(384EI)`
- Run tests: `cargo test`

## File Format Support (planned)

- Import: Nastran BDF (`.bdf`), Abaqus INP (`.inp`), Gmsh MSH v4 (`.msh`)
- Export: VTK Unstructured Grid (`.vtu`) for ParaView compatibility

## Code Style

- Rust: `rustfmt` defaults, `clippy` clean at `warn` level
- TypeScript: strict mode, no `any`
- Comments only for non-obvious physics/math — reference the paper/equation instead of explaining the code
