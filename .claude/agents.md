# KoFEM Agent Guidelines

Read [CLAUDE.md](../CLAUDE.md) first — it describes the architecture, the build
commands, and the terminology rules. This file covers how an agent should work a
task from start to finish.

## Test-Driven Development (red → green)

Follow strict red-green TDD for all implementation work:

1. **Red** — write a failing test that specifies the desired behaviour *before* writing any production code. The test must compile and fail for the right reason (not a compile error).
2. **Green** — write the minimal production code needed to make the test pass. Do not add logic beyond what the failing test requires.
3. **Refactor** — clean up duplication and style while keeping the test suite green.

### Practical rules

- Never implement a feature without a corresponding test written first.
- Run the relevant test command after every change to confirm the transition
  red → green. In practice that is `cd web && bunx playwright test <spec>` or a
  script under `examples/validation/` — the behaviour that ships is exercised
  through the web app and the WASM engine.
- `cargo test` currently exercises nothing: `crates/` holds stubs with no tests
  (see CLAUDE.md). Do not treat a green `cargo test` as coverage of anything.
- For acceptance criteria given in a Linear issue, copy the test verbatim into
  the test file before touching implementation code.
- Prefer small, focused tests over large integration tests so failures pinpoint the broken unit.

## Tracking work in Linear

Linear (team `KOF`) is the tracker and the source of truth for what to build.

1. **Start** — move the issue to **In Progress**.
2. **Open the PR** — put `Fixes KOF-nn` in the description, and move the issue to
   **In Review**.
3. **Evidence** — if the change has a visible result, attach it to the issue.

### How to attach evidence

Use one comment on the issue and **edit it in place** on subsequent pushes.
Never add a new comment per push — that is exactly the noise this workflow
replaced.

A useful evidence comment states what the reader is looking at and what it
proves, for example:

> Auto-shell now detects the I-beam flanges as thin-walled (t/L = 0.04, below the
> 0.1 threshold). Left: previous solid mesh, 48k tets. Right: mixed CTRIA3+CTETRA,
> 3.1k elements, tip deflection within 2% of the solid reference.

What does **not** go on a Linear issue:

- CI failure screenshots — they stay as the GitHub Actions artifact of the run.
- Routine green-run screenshots — the weekly showcase covers "what the app looks
  like now" (see CLAUDE.md).
- Progress narration. Move the status; don't post that you are still working.
