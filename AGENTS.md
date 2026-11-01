# KoFEM

Browser FEA: STEP → OCCT → Netgen → MFEM. Production code is C++/WASM in
`engine/cpp/`; `crates/` contains Rust stubs, not product extension points.
The React/TypeScript/Three.js frontend is in `web/`. Use **bun**, not npm.

## Implementation

- Solver paths: `solve_mfem.cpp` (solid), `solve_shell.cpp` (shell), and
  `solve_coupled.cpp` (mixed). Cover all applicable paths for materials, BCs,
  loads, and solve payload changes, including per-body materials.
- Shell is an explicit per-body choice. Mid-surface and mixed-mesh assembly
  live in `web/src/lib/shellize.ts`; shell element math is in `shell_core.cpp`.
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

Web scripts fetch the matching compiled engine automatically. After engine
changes, build with `bash scripts/docker-build-wasm.sh` (or `build-wasm.sh`
with Emscripten and dependencies installed). Never commit generated WASM/JS.

Run checks appropriate to the change; CI definitions are in
[.github/workflows/ci.yml](.github/workflows/ci.yml):

- Rust: `cargo fmt --all --check` and `cargo clippy --workspace --all-targets -- -D warnings`.
- C++: `bash scripts/clang-tidy.sh` and relevant `scripts/test-*.sh` suites.
- Frontend, from `web/`: `bun run typecheck && bun run lint && bun run format:check && bun run test`.

## Workflow

- Linear holds issues, specs, and decisions; GitHub holds code and PRs.
  Keep task-specific findings out of this file.
- Branch from `develop` and target PRs there. Use `Fixes KOF-nn` only when
  the PR resolves that issue.
- When you start work on a Linear issue, move it to **In Progress** before
  writing code. After that, let the GitHub integration manage its status.
- Record meaningful evidence on the Linear issue, editing one comment in place.
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
