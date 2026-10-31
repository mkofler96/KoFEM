# Assess a KoFEM release

Use this procedure from `release`, `prepare-release`, and `create-release`.
Assessment itself is read-only. Linear holds planning and evidence; GitHub
holds commits, PRs, checks, tags, and published releases. Read `AGENTS.md`
and relevant Linear agent context before working in an area.

## Establish the current range

Read live `main`, `develop`, and product tags. Ignore `engine-*` prereleases.
Record the last product tag reachable from `main`, its date, and the exact
`develop` SHA. When a checkout is available:

```sh
git fetch origin main develop --tags
last_release=$(git describe --tags --abbrev=0 --match 'v[0-9]*' origin/main)
git log --first-parent --format='%h %s' "$last_release"..origin/develop
git diff --stat "$last_release"..origin/develop -- engine/cpp examples/validation
```

Connected GitHub reads can supply the same evidence when local Git is
unavailable. Follow pagination; a truncated comparison is not a complete range.
Check for an existing release plan or PR and for a release already on `develop`
awaiting promotion. Do not silently plan a second version over that release.

For each merged PR, read its description, relevant diff, linked Linear issues,
and any draft release-note comments. Classify it as **Added**, **Changed**,
**Fixed**, **Breaking**, or **Internal**. Keep required but unmerged PRs separate
from the merged range. CI, tests, tooling, refactors, and contributor docs are
usually Internal; judge the actual behavior, not just the title.

## Version and numerical changes

Pre-1.0: a patch contains fixes only; anything new or breaking needs a minor
version. Explain a proposed version that differs from the user's suggestion.
Do not silently bump a different version during creation.

Breaking means a saved model, example link, or exported file no longer loads
or reads the same, or results for an unchanged model move beyond validation
tolerances. State what users must do, including re-solving or re-meshing.

Treat changes to solver paths, `shell_core.cpp`, the mesher, solver defaults,
and validation reference values or tolerances as numerical until inspected.
Record what changed, why, its measured effect when known, and validation
evidence. An experiment or native study does not prove the production fix
shipped. Every numerical change needs a **Changed** or **Breaking** note.

## Readiness

Inspect required CI checks on the exact `develop` SHA. A previous green run,
pending run, missing check, or unknown result does not establish readiness.
Review open Linear issues across the team, including issues without a Bug
label, and related open PRs. Read the evidence before calling an issue fixed.

- **GO:** user-facing work exists, required checks pass on the candidate,
  release prerequisites have evidence, and no unresolved correctness blocker
  affects the candidate.
- **WAIT:** only internal work exists.
- **NO-GO:** CI is red, pending, or unknown; a prerequisite is unverified; or an
  open issue reports wrong results introduced or still unfixed in this range.
  A release must not label a known-wrong result as a reference point.

Record failures, reported regressions, numerical defects, and missing manual
setup as concrete tasks. Distinguish a report needing reproduction from a
verified defect. Do not treat every backlog item as release scope or waive a
correctness blocker to finish the checklist.

When analytics changed, verify consent coverage and any required external
configuration separately from code completion. For GA4 workflow analytics,
check `solve_completed` as a key event, custom dimensions, and the funnel.
A merged PR alone does not prove GA4 admin setup. Do not send model data or
manufacture live analytics events while checking readiness.

For a read-only assessment, report five lines or fewer:

```text
Release check — since vX.Y.Z (N PRs, M days)
Recommend: vA.B.C — GO / WAIT / NO-GO, with reason
User-facing: the 1–3 most important changes, with PR links
Numerical: changes and evidence, or none
Breaking: changes and user action, or none
```
