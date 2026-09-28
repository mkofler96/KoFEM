<!--
SPDX-FileCopyrightText: 2026 Michael Kofler
SPDX-License-Identifier: AGPL-3.0-or-later
-->

# Examples

Every example model lives here, and only here.

| Folder            | What it holds                                                                                                                     |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `gallery/`        | The public gallery at [kofem.org/examples](https://kofem.org/examples/): generators, and `site/`, served verbatim at `/examples/` |
| `unvalidated/`    | Models taken off the gallery (or not yet on it) because their result is not trusted yet. Never served                             |
| `validation/`     | Regression benchmarks against closed-form or published references; run by `bun run test` in CI                                    |
| `shell-coupling/` | Dev script: the crane holder as shells coupled to solids; run by `bun run test`                                                   |
| `topopt-shell/`   | Dev scripts: shell and coupled shell/solid topology optimization (KOF-237)                                                        |

"Add or change an example" means `gallery/` — see `AGENTS.md`.
