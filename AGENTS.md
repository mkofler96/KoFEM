# KoFEM

Browser FEA: STEP → OCCT → Netgen → finite-element solve. Geometry and meshing
are C++/WASM in `engine/cpp/` and stay there. The whole solver side is moving
to Rust: `crates/kofem-fem` (elements, assembly, solvers, shells),
`crates/kofem-shellize` (shell idealisation) and `crates/kofem-wasm` (browser
bindings, a separate WASM module joined to the engine in TS). The other crates
are stubs. Build new finite-element features in Rust only; the C++ solver code
that remains gets bug fixes only. The Roadmap in Linear lists which solver
paths have moved.
The React/TypeScript/Three.js frontend is in `web/`. Use **bun**, not npm.

## Implementation

- Solver paths are routed in `web/src/lib/solve/route.ts`. Solid tetrahedral
  models solve in Rust by default (`lib/solve/amg.ts`); MFEM
  (`solve_mfem.cpp`) is the other choice and takes the solid models Rust does
  not cover. Pure shells solve in Rust (`lib/solve/shellRust.ts`), with
  `solve_shell.cpp` as their test oracle. Mixed models (`solve_coupled.cpp`)
  and topology optimization are still C++. Cover all applicable paths for
  materials, BCs, loads, and solve payload changes, including per-body
  materials.
- Shell is an explicit per-body choice. Mid-surface and mixed-mesh assembly
  live in `crates/kofem-shellize` (one module per stage), reached through
  `web/src/lib/shellize.ts`; shell element math is in
  `crates/kofem-fem/src/shell` and, for the C++ paths, `shell_core.cpp`.
- Geometry tessellation is for display. Never call it a mesh; surface and
  volume meshes are FEM discretisations.
- Use strict TypeScript without `any`, C++ `std::array` instead of C arrays,
  and explicit errors for invalid or missing required data. No silent fallbacks.
  See [CONTRIBUTING.md](CONTRIBUTING.md) for detailed conventions.
- Analytics require opt-in consent. Use `web/src/lib/analytics.ts`; never
  send model data, filenames, results, or raw errors.
- Keep UI copy brief and user-focused; link to technical detail and extended
  limitations. Negative example: [KOF-266 / PR #479](https://github.com/mkofler96/KoFEM/pull/479)
  overloaded the homepage hero with explanations. Read that example only
  when working on homepage copy.

## Build and checks

```sh
git config core.hooksPath .githooks
cd web && bun install && bun run dev
```

Web scripts fetch the matching compiled engine and build the Rust module
(`scripts/build-fem-wasm.sh`; needs Rust, the `wasm32-unknown-unknown` target
and the pinned `wasm-bindgen` CLI). After engine changes, build with
`bash scripts/docker-build-wasm.sh` (or `build-wasm.sh` with Emscripten and
dependencies installed). Never commit generated WASM/JS.

Run checks appropriate to the change; CI definitions are in
[.github/workflows/ci.yml](.github/workflows/ci.yml):

- Rust: `cargo fmt --all --check`, `cargo clippy --workspace --all-targets -- -D warnings`
  and `cargo test --workspace`. `bun run test:validation` includes the
  Rust-vs-C++ checks (`tests/test_fem_wasm.mjs`, `test_amg_solid.mjs`,
  `test_amg_coupling.mjs`, `test_shell_rust.mjs`).
- C++: `bash scripts/clang-tidy.sh` (`docker-clang-tidy.sh` without a local
  emsdk) and relevant `scripts/test-*.sh` suites.
- Frontend, from `web/`: `bun run typecheck && bun run lint && bun run format:check && bun run test`.

## Workflow

- Linear holds issues, specs, and decisions; GitHub holds code and PRs.
  Keep task-specific findings out of this file.
- Branch from `develop` and target PRs there. Use `Fixes KOF-nn` only when
  the PR resolves that issue.
- When you start work on a Linear issue, move it to **In Progress** before
  writing code. After that, let the GitHub integration manage its status.
- Record meaningful evidence on the Linear issue, editing one comment in place.
- Any change a user can see in the UI needs before/after screenshots
  (Playwright, desktop and phone width) on that Linear evidence comment before
  the PR is opened. GitHub does not always accept images, so Linear is the
  record; the PR only links to the comment.
- Feature PRs do not edit `CHANGELOG.md`. Releases require an explicit request;
  `prepare-release` creates the Linear plan and readiness tasks;
  `create-release` rechecks them and opens the version/changelog PR. The legacy
  `release` skill handles assessment and routes those requests. Skills live in
  `.claude/skills/`, with Codex links in `.agents/skills/`. Agents never create
  tags or GitHub Releases; the maintainer merges release PRs and handles
  promotions from `develop` to `main`.
- Preserve pinned dependency/action/image versions and signed build provenance.

## Examples

“Example” means the public example pages at `/examples/`, built from
`examples/gallery/` and `examples/validation/`; read `examples/gallery/README.md`.
Edit generators and regenerate outputs, then check the pages and app.
Models must be buildable through the app. Do not hand-edit generated VTU/JSON,
add Abaqus inputs/readers, or publish unvalidated examples without being asked.
