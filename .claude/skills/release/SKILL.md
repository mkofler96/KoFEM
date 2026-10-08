---
name: release
description: Assess whether KoFEM is due for a release and, when the maintainer says go, open the release PR that bumps the version and writes the changelog. Use when asked whether to release, what has changed since the last release, or to cut, prepare or draft a release.
---

# Releasing KoFEM

kofem.org deploys `main` continuously. A release does not ship code. It labels a
tested commit, so users and bug reports have a version to point at and changes to
numerical results get written down.

Releases have no schedule. Run this skill only when the maintainer asks for it.
Never run it from a routine, and never put it in the weekly update.

| Piece | Where |
| -- | -- |
| Version | `web/package.json` `version` and `Cargo.toml` `[workspace.package] version`. The two must match |
| Release notes | `CHANGELOG.md`, one `## [X.Y.Z] - YYYY-MM-DD` section per release |
| Consistency check | `scripts/release-version.sh`, which CI runs on every PR |
| Tag and GitHub Release | CI's `release` job via `scripts/publish-release.sh`, on the commit that added the version's changelog heading |

## The rules

1. **You never tag, and never create or edit a GitHub Release.** The only human
   approval is the maintainer merging the release PR. CI then tags that exact
   commit, after every gate has passed on it.
2. **Assess is read-only.** It recommends. It does not branch, push, open a PR or
   file issues.
3. **Numerical changes are never silent.** Any change to the solver, the mesher,
   element formulations, defaults, or validation reference values or tolerances
   gets a line under **Changed** or **Breaking**. Say what moved, by how much if
   it is known, and why.
4. **Feature PRs do not edit `CHANGELOG.md`.** Only release PRs do. That keeps
   parallel branches from conflicting on the same lines.

## Versioning

Pre-1.0 [semver](https://semver.org/):

- **Patch** (`0.1.0` → `0.1.1`): only fixes.
- **Minor** (`0.1.0` → `0.2.0`): anything new, and anything breaking.
- **Breaking** means a saved model, an `?example=<id>` link or an exported file no
  longer loads or reads the same, or results change for an unchanged model beyond
  the validation tolerances. Breaking changes are always listed explicitly, with
  what the user has to do about them.

## Mode 1: assess (read-only)

```bash
git fetch origin main --tags
LAST=$(git describe --tags --abbrev=0 --match 'v[0-9]*' origin/main)
git log --first-parent --format='%h %s' "$LAST"..origin/main
git diff --stat "$LAST"..origin/main -- engine/cpp examples/validation
```

`main` is squash-merged, so each first-parent commit is one PR, and `(#nnn)` in
the subject gives the PR number. For each PR, read its title and description, and
look for the `Fixes KOF-nn` issue. If there is a comment drafting a release note
for it, read that too. Sort each PR into **Added**, **Changed**, **Fixed**,
**Breaking** or **Internal**. Judge from the description and the diff, not from
the title alone. Internal covers CI, tests, tooling, refactors and docs.

Treat any diff under `engine/cpp/solve_*`, `shell_core.cpp`, `mesh_netgen.cpp`, or
in `examples/validation` reference values or tolerances, as a numerical change
until you have read it and shown otherwise.

**Recommendation:**

- **Release now** when there is user-facing work since the last tag. Propose the
  version, following the rules above. Say so explicitly when a Breaking or
  numerical change is in the range, because those benefit most from a tag.
- **Wait** when everything since the last tag is Internal.
- **Blocked** when CI is red on `origin/main`'s head, or when an open Linear issue
  reports a wrong result that this range introduced or did not fix. A release
  must not label a known-wrong result as a reference point.

Report it as five lines or fewer:

```
Release check — since vX.Y.Z (N PRs, M days)
Recommend: release vA.B.C now | wait | blocked — <one-line reason>
User-facing: <the 1–3 most important changes, with PR numbers>
Numerical: <what changed, or "none">
Breaking: <what, or "none">
```

If nothing user-facing happened, say so in one line and stop.

## Mode 2: prepare (only after the maintainer says release)

1. Branch from `origin/main`, or use the branch your session was told to use.
2. Set the new version in `web/package.json` and in `Cargo.toml`
   `[workspace.package]`. Run `cargo check` so `Cargo.lock` picks it up.
3. Add the section to the top of `CHANGELOG.md`, below the intro, dated today:
   - Write for users, not contributors. Leave out file paths, function names and
     SHAs.
   - Use **Added**, **Changed**, **Fixed** and **Breaking** headings, and only
     the ones that have entries. Add **Known limitations** when something new
     ships with one.
   - Leave Internal PRs out entirely.
4. Check it, and read the notes it prints the way a user would:
   ```bash
   bash scripts/release-version.sh && bash scripts/release-version.sh --notes
   ```
5. Open a PR titled `Release vA.B.C`. The body has two parts:
   - The changelog section.
   - The readiness report below, filled in.

   Do **not** put `Fixes KOF-nn` in it, because a release resolves no issue.
6. Stop and report the PR link. If the PR merges on a later day, move the date in
   the changelog heading before it merges.

### Readiness report

```markdown
## Readiness

- **Range:** vX.Y.Z..<sha>, N PRs
- **CI on main head:** green / red (<run link>)
- **Numerical changes:** <each one, with the validation evidence from its PR, or "none">
- **Breaking changes:** <what users must do, or "none">
- **Open correctness issues:** <KOF-nn links, or "none known">
- **Recommendation:** GO / NO-GO, with the reason
```

## After merge

CI's `release` job publishes `vA.B.C` once rust, clang-tidy, frontend (tests and
the production smoke test) and publish-engine pass on the merge commit. If the
job fails, report its error. Do not tag by hand to work around it.

The app's status bar and the image tag both show `vA.B.C-<short sha>`. Every
image ever pushed is tagged that way in `ghcr.io/mkofler96/kofem-web`, so rolling
back means deploying an earlier one of those tags.
