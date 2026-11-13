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

- Solver paths are routed in `web/src/lib/solve/route.ts`. Solid models of
  tetrahedra, hexahedra or both solve in Rust by default (`lib/solve/amg.ts`;
  couplings take tetrahedra only); MFEM (`solve_mfem.cpp`) is the other choice
  and takes the solid models Rust does not cover. Pure shells solve in Rust
  (`lib/solve/shellRust.ts`), with `solve_shell.cpp` as their test oracle.
  Mixed shell/solid models solve in Rust (`lib/solve/coupledRust.ts`), with
  `solve_coupled.cpp` as their test oracle; all-solid models with couplings
  that AMG cannot take still use `solve_coupled.cpp`. Topology optimization
  is still C++. Cover all applicable paths for materials, BCs, loads, and
  solve payload changes, including per-body materials.
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
bash scripts/install-tools.sh   # just and wasm-bindgen, pinned
just setup                      # web dependencies, the engine, the Rust module
cd web && bun run dev
```

`just` is the one interface for checks and tests, and CI runs the same recipes
([.github/workflows/ci.yml](.github/workflows/ci.yml)). `just` alone lists
them; whatever follows a recipe name goes to its runner
(`just test-e2e couplings --repeat-each 20`).

| Command          | Runs                                                   | For changes to             |
| ---------------- | ------------------------------------------------------ | -------------------------- |
| `just check`     | `cargo fmt`, `clippy`, `tsc`, `eslint`, `prettier`     | anything                   |
| `just check-cpp` | `clang-tidy` (`docker-clang-tidy.sh` without an emsdk) | `engine/cpp`               |
| `just test-rust` | `cargo test --workspace`                               | `crates/`                  |
| `just test-cpp`  | `ctest` on `engine/tests`, native and MFEM/WASM        | `engine/cpp`               |
| `just test-web`  | `bun test`: `web/tests/unit`, `web/tests/integration`  | `web/src`, any solver path |
| `just test-e2e`  | Playwright: `web/tests/*.spec.ts`                      | anything a user sees       |
| `just test`      | all four                                               | several parts, before a PR |

Web scripts fetch the matching compiled engine and build the Rust module
(`scripts/build-fem-wasm.sh`; needs Rust, the `wasm32-unknown-unknown` target
and the pinned `wasm-bindgen` CLI). After engine changes, build with
`bash scripts/docker-build-wasm.sh` (or `build-wasm.sh` with Emscripten and
dependencies installed). Never commit generated WASM/JS.

## Test-driven development

Work red → green → refactor: write a failing test that specifies the behaviour
before any production code (it must compile and fail for the right reason),
write the minimal code that makes it pass, then clean up with the suite green.

- Never implement a feature without a test written first. When a Linear issue
  gives acceptance criteria as a test, copy it verbatim into the test file
  before touching implementation code.
- Run the relevant test after every change. For Rust solver code, start with
  `just test-rust -p <crate>`. For everything that ships, run
  `just test-e2e <spec>` or `just test-web <name>`: shipped behaviour runs
  through the web app and both WASM modules.
- `cargo test` does not cover the `kofem-wasm` browser bindings, the C++
  engine, or how the app calls either module. A green `cargo test` alone is
  not coverage of a solver path; also run its Rust-vs-C++ check
  (`web/tests/integration/{fem-wasm,amg-solid,amg-coupling,shell-rust,coupled-rust}.test.mjs`).
- A new test goes where its runner looks, and nowhere lists test files:
  - Rust numerics: `crates/<crate>/tests`.
  - TypeScript logic without WebAssembly: `web/tests/unit/<name>.test.ts`.
  - The engine or the Rust module without a browser:
    `web/tests/integration/<name>.test.mjs`, loading them through
    `web/tests/support/wasm.mjs`.
  - What a user sees: `web/tests/<name>.spec.ts`. End the title with
    `@pipeline` when the test imports real CAD, meshes a real part or runs a
    full flow.
  - A C++ unit: `engine/tests/<name>.cpp` and one `kofem_test()` line in
    `engine/tests/CMakeLists.txt`.
- Prefer small, focused tests, so a failure pinpoints the broken unit.
- Tests wait on state, never on time. Time budgets are set once per runner
  (`web/playwright.config.ts`, `web/tests/support/setup.mjs`); a spec sets no
  timeout and never sleeps. Click the 3D viewport through
  `web/tests/fixtures/viewport.ts`, which waits for the settled view. Test a
  race with a gate the test releases, not a delay.
- A flaky test is a bug in the test or the app. CI retries it and reports it;
  the nightly flake hunt fails on it. Fix the cause: do not raise a budget, add
  a retry or re-run until green.

## Workflow

- Linear holds issues, specs, and decisions; GitHub holds code and PRs.
  Keep task-specific findings out of this file.
- Branch from `develop` and target PRs there. Use `Fixes KOF-nn` only when
  the PR resolves that issue, and `Refs KOF-nn` otherwise: the link starts the
  issue and queues it to close on merge. Mention ongoing operational issues
  in prose.
- When you start work on a Linear issue, move it to **In Progress** before
  writing code. After that, let the GitHub integration manage its status.
- Record meaningful evidence on the Linear issue in one comment, edited in
  place on later pushes; a comment per push buries the record. Say what the
  reader is looking at and what it proves, for example: "Auto-shell now
  detects the I-beam flanges as thin-walled (t/L = 0.04, below the 0.1
  threshold). Left: previous solid mesh, 48k tets. Right: mixed
  CTRIA3+CTETRA, 3.1k elements, tip deflection within 2% of the solid
  reference." Keep CI failure screenshots (they stay as the run's GitHub
  Actions artifact), routine green-run screenshots and progress narration off
  the issue.
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
