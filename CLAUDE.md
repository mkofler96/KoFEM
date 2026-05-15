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

# Install and run the web frontend (uses bun, not npm)
cd web && bun install && bun run dev

# Build Python bindings (uses uv + maturin)
cd python && uv run maturin develop
```

## Element Library (Nastran naming)

All element types use Nastran names. The property card, not the element type, determines the formulation:

| Element | Property | DOF/node | Formulation | Status |
|---------|----------|----------|-------------|--------|
| CBAR / CBEAM | PBAR / PBEAM | 6 | Euler-Bernoulli beam | Local K done; global transform TODO |
| CTRIA3 | PSHELL | 6 | DKT shell | Stub |
| CTRIA3 | PLPLANE | 2 | CST plane stress/strain | **Full B-matrix, exact integration** |
| CQUAD4 | PSHELL | 6 | MITC4 shell | Stub |
| CQUAD4 | PLPLANE | 2 | Bilinear quad, 2×2 Gauss | **Full B-matrix** |
| CTRIA6, CQUAD8 | PSHELL | 6 | Higher-order shell | Stub |
| CTETRA (4-node) | PSOLID | 3 | Linear tet, constant strain | **Full B-matrix, exact integration** |
| CHEXA (8-node) | PSOLID | 3 | Trilinear hex, 2×2×2 Gauss | **Full B-matrix** |
| CPENTA (6-node) | PSOLID | 3 | Wedge | Stub |
| CPYRAM (5-node) | PSOLID | 3 | Pyramid | Stub |

## Current Implementation Status

| Component | Status |
|-----------|--------|
| `Mesh` data structure | Done |
| `PropertyCard` (PBAR/PBEAM/PSHELL/PLPLANE/PSOLID) | Done |
| `IsotropicElastic` material | Done |
| `CbarElement` local stiffness | Done (needs global transform) |
| `Ctria3PlaneElement` (CST) | **Full stiffness + mass** |
| `Cquad4PlaneElement` (2×2 Gauss) | **Full stiffness + mass** |
| `Ctetra4Element` (linear tet) | **Full stiffness + mass** |
| `Chexa8Element` (2×2×2 Gauss) | **Full stiffness + mass** |
| `Cquad4ShellElement` (MITC4) | Stub |
| `Ctria3ShellElement` (DKT) | Stub |
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

- Gauss integration: 2×2×2 for CHEXA, 2×2 for CQUAD4, exact for CTETRA and CTRIA3
- Element stiffness: `K_e = ∫ Bᵀ D B dV`, assembled via `scatter_add` into global K
- 2D plane B-matrix has 3 rows [εxx, εyy, γxy]; 3D solid B-matrix has 6 rows [εxx, εyy, εzz, γxy, γyz, γzx]
- Shell formulation: MITC4 (Bathe & Dvorkin 1985) — mixed interpolation to avoid shear locking
- Beam formulation: Euler-Bernoulli; Timoshenko shear factor κ is on the PBEAM roadmap
- BCs: penalty method currently (1e14 × max diagonal); switch to elimination for production
- Dual-use elements (CTRIA3, CQUAD4): the property card (PSHELL vs PLPLANE) determines DOF per node
  and which element struct to instantiate. This mirrors Nastran's design exactly.

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

## Pull Request Convention

Always include `closes #<issue-number>` in the PR description body so that merging the PR automatically closes the linked issue on GitHub.
