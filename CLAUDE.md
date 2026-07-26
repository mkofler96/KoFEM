# KoFEM — AI Development Guide

KoFEM is a browser-first finite element analysis application. This file is the primary context for Claude Code when working on this codebase.

**This file describes how the code works.** Roadmap, decision records, feature
specs and the visual showcase live in Linear — see
[Planning and documentation live in Linear](#planning-and-documentation-live-in-linear).

## Architecture Overview

The solid pipeline is: **STEP geometry → OCCT tessellation → Netgen volume mesh → MFEM FEM solve**.
Thin-walled bodies take a shell path instead — see [Shells and multibody](#shells-and-multibody).

**Everything that ships runs through the C++/WASM engine.** The Rust crates are
type definitions and stubs for a future migration; no product code path calls
them today.

```
KoFEM/
├── engine/             # C++ WASM engine — the production pipeline
│   ├── cpp/
│   │   ├── engine.cpp        # Embind entry point only (~40 lines); the pipeline
│   │   │                     # lives in the modules below
│   │   ├── cad_io.cpp        # STEP/IGES import (OCCT)
│   │   ├── tessellate.cpp    # OCCT surface tessellation (display)
│   │   ├── mesh_netgen.cpp   # Netgen volume meshing
│   │   ├── solve_mfem.cpp    # Linear-elastic solid solve (MFEM)
│   │   ├── shell_core.cpp    # Kirchhoff/DKT shell formulation
│   │   ├── solve_shell.cpp   # Pure-shell solve
│   │   └── solve_coupled.cpp # Mixed shell/solid solve with RBE3 coupling
│   ├── tests/          # Native C++ checks — NOT run by CI (tracked in Linear)
│   └── CMakeLists.txt  # emcmake build → kofem_wasm_emcc.js + .wasm
├── crates/             # Rust stubs for the 3.0 native migration — see below
├── web/                # React + Three.js frontend (Vite) — bun, not npm
├── examples/           # Validation cases, shell-coupling scripts, web examples
├── test_files/         # STEP/IGES fixtures used by tests and examples
└── scripts/
    ├── build-wasm.sh        # CMake/Emscripten WASM build
    ├── docker-build-wasm.sh # Docker wrapper (Mac / CI)
    ├── fetch-wasm-deps.sh   # Pull the precompiled OCCT/Netgen/MFEM WASM libs
    ├── clang-tidy.sh        # C++ lint, mirrors the DeepSource PR gate
    ├── test-bc-validation.sh
    └── test-shell.sh
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
solver.worker.ts  (awaits init(), calls methods on the KofemModule instance)
```

### Shells and multibody

Not every model is a bag of tetrahedra. Two features cut across the pipeline and
touch nearly every layer, so check them before assuming a change is solid-only:

- **Shells.** Thin-walled bodies are meshed as `CTRIA3` and solved with Kirchhoff
  plate/DKT elements (`shell_core.cpp`, `solve_shell.cpp`). Mid-surface extraction
  and the shell mesh assembly live in `web/src/lib/shellize.ts`. Auto-shell
  detection picks the path from a wall-thickness ratio at mesh time and stores a
  mixed `CTRIA3` + `CTETRA` model.
- **Multibody.** Assemblies carry per-body materials and per-body element type
  (shell or solid). Bodies are joined by bonded ties; shell-to-solid interfaces
  use explicit **RBE3** coupling. The mixed solve is `solve_coupled.cpp`.

A change to materials, boundary conditions, loads, or the solve payload almost
always has a shell path, a solid path, and a coupled path. Cover all three.

### The Rust crates are stubs (3.0 migration)

`crates/kofem-{geom,mesh,core}` total ~300 lines. They define the shared
`SurfaceMesh` / `VolumeMesh` / material / BC types and a `FemSolver` trait, and
**every entry point returns an explicit "not implemented" error**. There is no
`build.rs`, no C++ bridge, and no OCCT/Netgen/MFEM linkage — building them needs
nothing but a Rust toolchain.

Rewriting the pipeline in Rust is a real intention, but it is targeted at **3.0**
and no work has started. Until then:

- Do **not** add product logic to the crates, and do not treat `FemSolver` as an
  extension point — implementing it changes nothing that ships.
- To change solver behaviour, edit `engine/cpp/solve_{mfem,shell,coupled}.cpp`.
- When the migration does start, the mechanism is: build the crate as
  `crate-type = ["staticlib"]` for `wasm32-unknown-emscripten`, expose it via
  `extern "C"`, and add one `target_link_libraries` entry in `engine/CMakeLists.txt`.

## First-time setup

```bash
git config core.hooksPath .githooks
```

## Build Commands

```bash
# Rust stubs — no native libraries needed, and there are no tests yet.
cargo check
cargo test

# Build the WASM engine. Needs Emscripten plus the precompiled OCCT/Netgen/MFEM
# WASM libs; scripts/fetch-wasm-deps.sh pulls them, or use the Docker wrapper.
./scripts/build-wasm.sh          # or: ./scripts/docker-build-wasm.sh

# Install and run the web frontend (uses bun, not npm)
cd web && bun install && bun run dev

# The gates CI enforces, in the order CI runs them
cargo fmt --all --check && cargo clippy --workspace --all-targets -- -D warnings
bash scripts/clang-tidy.sh
cd web && bun run typecheck && bun run lint && bun run format:check && bun run test
```

Building the WASM engine rewrites the committed `web/src/wasm/pkg/*.wasm`
(~34 MB). Only rebuild when you have changed C++ sources — an unnecessary rebuild
adds tens of megabytes of history to a repository whose `.git` is already ~80 MB.

## Geometry vs. Mesh — Critical Terminology

There are three distinct representations in this codebase. Using the wrong word is a bug in the code and the UI.

| Concept                   | What it is                                               | Produced by                                               | Used for                                                       |
| ------------------------- | -------------------------------------------------------- | --------------------------------------------------------- | -------------------------------------------------------------- |
| **Geometry tessellation** | Triangles approximating the CAD surface for display only | OCCT (`engine/cpp/tessellate.cpp`)                        | Viewport rendering of the STEP shape (Geometry repr)           |
| **Surface mesh**          | Quality triangulation of the CAD boundary surfaces       | OCCT tessellation **or** Netgen's direct OCCT integration | Input to the volume mesher + display (Surface Mesh repr)       |
| **Volume mesh**           | Tetrahedral elements filling the solid body              | Netgen (`engine/cpp/mesh_netgen.cpp`)                     | FEM analysis — nodes + elements for stiffness matrix and solve |

The surface mesh comes from the **geometry**, not from the volume mesh. It is either the OCCT tessellation repurposed as meshing input, or (preferred) a proper boundary mesh produced by Netgen's built-in OCCT integration, which respects CAD topology and feature edges.

**Rules — never violate these:**

- **Geometry tessellation triangles are NOT a mesh.** They are a visual approximation of the CAD surface. Never call them "mesh", "surface mesh", or use mesh-related variable names (`mesh`, `meshTriangles`, etc.) for them. Correct names: `tessellation`, `stepTessellation`, `stepSurface`, `geomTriangles`.
- **"Mesh" always means FEM mesh** — nodes + elements produced by Netgen and used for analysis. The words `mesh`, `meshing`, `meshResult` are reserved for Netgen output and FEM data.
- **The pipeline:** geometry → tessellation (display) → surface mesh (from geometry, input to Netgen) → volume mesh (FEM) → solve. Tessellation serves display; the volume mesh is what the solver operates on.
- In the UI the three viewport representations map to: **Geometry** shows the OCCT tessellation, **Surface Mesh** shows the boundary triangulation of the FEM model, **Volume Mesh** shows all tetrahedral edges.

## Code Style

- Before committing, always run `cargo fmt` and `cargo clippy`
- C++ (`engine/cpp`): run `bash scripts/clang-tidy.sh` after changes — the checks in `.clang-tidy` mirror the DeepSource rules that gate PRs (no C-style arrays: use `std::array` and pass `.data()` at C-API boundaries, plus the `bugprone-*` family)
- TypeScript: strict mode, no `any`
- Comments only for non-obvious physics/math — reference the paper/equation instead of explaining the code
- ALWAYS prefer clear and information-rich error messages over silent fall-throughs. Avoid defensive try/catch blocks to make debugging easier.

## Planning and documentation live in Linear

**Linear is the source of truth for what to work on and why.** GitHub holds the
code, the pull requests and CI; it is not where planning happens.

| Question                                    | Where the answer lives                      |
| ------------------------------------------- | ------------------------------------------- |
| How does the code work? What are the rules? | This file, `CONTRIBUTING.md`, code comments |
| What should I build, and why?               | Linear issue `KOF-nn`                       |
| Where is the project going?                 | Linear document **Roadmap**                 |
| Why is it built this way?                   | Linear documents **ADR-nnnn**               |
| What shipped? What does the app look like?  | Linear project updates (weekly)             |

Build and architecture facts stay in the repository on purpose: they must be
versioned with the diff that changes them and readable without network access.
Do not move them into Linear, and do not create a `docs/` directory.

### Working an issue

1. Find or create the Linear issue. Move it to **In Progress** when you start.
2. Branch, implement, open the PR. Put `Fixes KOF-nn` in the PR description —
   Linear's GitHub integration links the PR and closes the issue on merge.
   (`closes #<github-number>` is the old convention; it is no longer used.)
3. Move the issue to **In Review** when the PR is open, and record your evidence
   on the issue (below).

### Recording evidence on an issue

When a change has a visible result — a screenshot, a plot, a before/after, a
convergence log — attach it to **the Linear issue**, not to a chat channel:

- **One comment per issue, edited in place.** Update the existing evidence
  comment when you push again; do not add a second comment per push. A stream of
  near-identical posts is noise, and noise is what this workflow exists to avoid.
- Say what the reader is looking at and what it proves. A bare image is not
  evidence.
- Failure screenshots from CI are **not** posted to Linear. They stay as the
  GitHub Actions artifact of the run that produced them.

### The weekly project update

One post per week on the Kofem project, combining a progress digest with the
five-step workflow capture from `web/tests/showcase.spec.ts`.

**CI does not publish it, and there is no Linear credential in this repository.**
It is a scheduled Claude task — the `showcase` skill in `.claude/skills/` — posting
over the Linear MCP connection. Screenshot uploads are anchored to **KOF-209**,
because Linear's file upload is issue-scoped.

Three properties keep it out of the noise category. Any change must preserve all
three:

1. **One post per week.** Digest and screenshots share a body — never a post per
   section, never a post per image.
2. **Screenshots only when they changed.** The SHA-256 of the screenshot set is
   written into the update body as an HTML comment and checked before anything is
   uploaded. An unchanged week posts the digest alone.
3. **No filler.** A week with nothing worth reading says so in one line.

This replaced a Slack pipeline that posted the same images on every CI run, on
every branch and PR.
