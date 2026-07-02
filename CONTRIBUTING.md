# Contributing to KoFEM

Start with [CLAUDE.md](CLAUDE.md) — it describes the architecture, the build
commands, and the geometry/mesh terminology rules. This file covers the
conventions checked in review, starting with the one that matters most.

## No silent fallbacks

**This is the most common bug class in this codebase** (11 confirmed instances
in three weeks — see issue #322). The shape is always the same: when data is
missing, invalid, or mismatched, the code substitutes a plausible default and
keeps going, so the user gets a _wrong answer that looks right_ instead of an
error. In an FEA tool that is the worst possible failure mode.

Real examples that shipped and were later fixed:

```ts
// #183 — invalid Young's modulus input silently became steel:
const young = parseFloat(youngInput) || 210e9;

// #198 — invalid force input silently became a zero load, "solving" an
// unloaded model:
const force = parseFloat(loadForce) || 0;

// #174 / #310 — a missing or extra material was silently replaced by /
// collapsed to a default, instead of rejecting the model:
const material = materials[0] ?? DEFAULT_STEEL;
```

The rule, from CLAUDE.md: **ALWAYS prefer clear and information-rich error
messages over silent fall-throughs.** Concretely:

- Parse, then **validate and throw**: `Number.isFinite(v)` after `parseFloat`,
  length checks on result arrays, existence checks on referenced ids. The
  error message must say what was expected and what was found.
- `?? null`, `?? []`, `?? ""` as _absence markers_ that downstream code
  explicitly checks are fine. `?? 0`, `?? 1`, `?? "step"`, `?? DEFAULT_X` on
  data that feeds the solver or the displayed results are not.
- The same applies in C++ and Rust: no empty catch blocks, no stubs that
  return empty geometry, no hardcoded flags that disable validation
  (`mp.check_overlap = 0`), no accepted-but-ignored parameters.

### Enforcement

`web/` has a targeted ESLint rule, `kofem/no-silent-fallback`
(`web/eslint-rules/no-silent-fallback.js`), run by `bun run lint` and CI:

- Everywhere in `web/src`: `parseFloat(x) || default` (and `parseInt`,
  `Number`, also with `??` — which does **not** catch `NaN`) and empty
  `catch` blocks are errors.
- On solver-critical paths (`src/workers`, `src/store`, `src/lib`): any
  `??`/`||` whose right side fabricates a plausible value (a number, non-empty
  string, object/array literal, or a `default`/`fallback`-named identifier)
  is an error.

If a field is _genuinely_ optional — a display-only default, a documented
protocol default, error-path message text — allow-list it explicitly and say
why:

```ts
// eslint-disable-next-line kofem/no-silent-fallback -- elementOrder is optional in the solve message; the documented default is linear elements
const order = elementOrder ?? 1;
```

A disable comment without a `-- justification` is treated as a bug in review.

## Pull requests

- The PR template asks you to confirm, per changed code path, that missing or
  mismatched data produces an error rather than a default. Answer it honestly
  — reviewers check this first.
- Include `closes #<issue-number>` in the PR description so merging closes
  the linked issue.
- Before committing: `cargo fmt`, `cargo clippy`, and in `web/`:
  `bun run typecheck && bun run lint`.
