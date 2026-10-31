# Source

Adapted from the `pr` skill in [mattpocock/skills](https://github.com/mattpocock/skills/tree/main/skills/engineering/pr)
at commit `a496f5513d4a4cf889bc48e189e579f4b0bdf6aa` (MIT, see `LICENSE`).

Unlike `plain-writing`, this copy is **modified** for KoFEM:

- The upstream template (Summary visual, Evidence, Merge Danger) is merged
  with `.github/pull_request_template.md` (`Fixes KOF-nn`, Key Changes,
  Checklist).
- Evidence must be reproduced: a red run on the base and a green run on the
  branch, using the repo's own test suites.
- Screenshots go on the Linear issue's evidence comment, since Linear holds
  evidence and decisions (see `AGENTS.md`).
- `GLOSSARY.md` references are replaced with the KoFEM domain terms in
  `AGENTS.md`.

The Summary section's menu of visuals comes from Dex Horthy's `show-me` skill
([humanlayer/skills](https://github.com/humanlayer/skills/blob/main/plugins/show-me/skills/show-me/SKILL.md)),
as credited upstream. The entry at `.agents/skills/pr` links to this
directory for Codex discovery.
