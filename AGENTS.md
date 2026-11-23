# KoFEM

Browser FEA: STEP → OCCT → Netgen → finite-element solve. Geometry and meshing
are C++/WASM in `engine/cpp/` (OCCT and Netgen only). The whole solver side is
Rust: `crates/kofem-fem` (elements, assembly, solvers, shells, topology),
`crates/kofem-shellize` (shell idealisation) and `crates/kofem-wasm` (browser
bindings, a separate WASM module joined to the engine in TS). The other crates
are stubs. Finite-element code goes in Rust only.
The React/TypeScript/Three.js frontend is in `web/`. Use **bun**, not npm.

## Implementation

- Solver paths are routed in `web/src/lib/solve/route.ts`, which refuses a
  model no path takes. Solid models of tetrahedra, hexahedra or both solve
  with `lib/solve/amg.ts` (couplings take tetrahedra only) with either
  Solve-panel preconditioner, AMG or Gauss–Seidel; pure shells with
  `lib/solve/shellRust.ts`; mixed shell/solid models with
  `lib/solve/coupledRust.ts`; topology optimization (SIMP on solid, shell and
  coupled domains, the level-set method on solids) with
  `lib/solve/topOptRust.ts`. What the removed C++ solvers computed is kept as
  stored references: `web/tests/fixtures/engine-solves` for the Rust-vs-C++
  tests and `examples/validation/oracle-reference.json` for the examples.
  Cover all applicable paths for materials, BCs, loads, and solve payload
  changes, including per-body materials.
- Shell is an explicit per-body choice. Mid-surface and mixed-mesh assembly
  live in `crates/kofem-shellize` (one module per stage), reached through
  `web/src/lib/shellize.ts`; shell element math is in
  `crates/kofem-fem/src/shell`.
- Prefer Rust for new logic: numerics, geometry and mesh processing, result
  post-processing, and anything both the app and a script compute. TypeScript
  keeps the UI, state, wiring and the calls into the WASM modules. Use
  TypeScript or JavaScript only where Rust would be clearly cumbersome, for
  example on a page that does not load the Rust module, and say why in the PR.
- Geometry tessellation is for display. Never call it a mesh; surface and
  volume meshes are FEM discretisations.
- Use strict TypeScript without `any`, C++ `std::array` instead of C arrays,
  and explicit errors for invalid or missing required data. No silent fallbacks.
  See [CONTRIBUTING.md](CONTRIBUTING.md) for detailed conventions.
- Agents copy what they find, so a comment or lint exemption becomes a
  template. Comments say why the code does something it cannot say itself;
  they never narrate removed code. Keep `KOF-nn` tags. A repeated exemption
  means the shape is wrong: fix the shape, or the rule. `/no-comments` reviews
  a diff for this.
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

| Command          | Runs                                                   | For changes to                           |
| ---------------- | ------------------------------------------------------ | ---------------------------------------- |
| `just check`     | `cargo fmt`, `clippy`, `tsc`, `eslint`, `prettier`     | anything                                 |
| `just check-cpp` | `clang-tidy` (`docker-clang-tidy.sh` without an emsdk) | `engine/cpp`                             |
| `just test-rust` | `cargo test --workspace`                               | `crates/`                                |
| `just test-web`  | `bun test`: `web/tests/unit`, `web/tests/integration`  | `web/src`, `engine/cpp`, any solver path |
| `just test-e2e`  | Playwright: `web/tests/*.spec.ts`                      | anything a user sees                     |
| `just test`      | all three                                              | several parts, before a PR               |

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
  (`web/tests/integration/{fem-wasm,amg-solid,amg-coupling,shell-rust,coupled-rust}.test.mjs`),
  which compares against the stored C++ results. Their inputs are part of the
  stored record: a test that changes them has no C++ result left to compare.
- A new test goes where its runner looks, and nowhere lists test files:
  - Rust numerics: `crates/<crate>/tests`.
  - TypeScript logic without WebAssembly: `web/tests/unit/<name>.test.ts`.
  - The engine or the Rust module without a browser:
    `web/tests/integration/<name>.test.mjs`, loading them through
    `web/tests/support/wasm.mjs`.
  - What a user sees: `web/tests/<name>.spec.ts`. End the title with
    `@pipeline` when the test imports real CAD, meshes a real part or runs a
    full flow.
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
- Branch from `develop` and target PRs there. Write `Fixes KOF-nn` for every
  issue whose scope the PR delivers, parents and sub-issues alike, even when
  follow-ups are split into new issues; `Fixes` closes the issue on merge.
  Write `Refs KOF-nn` only for an issue that stays open after the merge,
  because work in its own scope remains: `Refs` moves it to In Progress and
  nothing closes it. Mention ongoing operational issues in prose.
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
