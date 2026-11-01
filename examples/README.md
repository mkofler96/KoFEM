<!--
SPDX-FileCopyrightText: 2026 Michael Kofler
SPDX-License-Identifier: AGPL-3.0-or-later
-->

# Examples

Every example model lives here, and only here.

| Folder            | What it holds                                                                                                                      |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `gallery/`        | The public examples at [kofem.org/examples](https://kofem.org/examples/): showcase generators, and `site/`, served at `/examples/` |
| `unvalidated/`    | Models taken off the examples (or not yet on them) because their result is not trusted yet. Never served                           |
| `validation/`     | Benchmarks against closed-form or published references, and the example pages' generator; run by `bun run test` in CI              |
| `shell-coupling/` | Dev script: the crane holder as shells coupled to solids; run by `bun run test`                                                    |
| `topopt-shell/`   | Dev scripts: shell and coupled shell/solid topology optimization (KOF-237)                                                         |

"Add or change an example" means `gallery/` — see `AGENTS.md`.
