# KoFEM validation suite

Each case here is built the way a user builds it in the app: one
STEP file imported, optionally split, meshed by Netgen with tetrahedra (a body
marked Shell is then collapsed to its mid-surface, as the app does), a
material, supports and loads on whole CAD faces, the static solve, and the
number the Results panel's hand check reads. The steps are the case's
**recipe** (`lib/recipe.mjs`); `lib/pipeline.mjs` runs them through the real
WASM engine and the app's own TypeScript (the load builders, the default AMG
solver, the nodal stress averaging), so nothing is re-implemented and solving
the opened example in the app gives the number on its page. This doubles as a
CI regression gate and as the source of the numbers on the public example
pages, [kofem.org/examples/](https://kofem.org/examples/).

Every example is built this way, with no exceptions: `rules.mjs` fails on an
example without a recipe, and `web/tests/examples-by-hand.spec.ts` rebuilds
each one with real clicks in the GUI.

## Run

From `web/`, with Bun (run.mjs imports the app's TypeScript); the pre-hook
fetches the engine and builds the Rust module (`bun run wasm:prepare`):

```bash
bun run validate                  # run all cases, print a table
bun run validate --case <id>      # run one case, e.g. axial-bar
bun run validate:report           # also regenerate the pages, figures, .vtu/.step files + REPORT.md
bun run validate:pages            # only re-render pages and diagram/chart files (no solve)
bun ../examples/validation/rules.mjs   # the rules every example meets
```

The MBB showcase's record is written by its own generator, so to regenerate
everything run it before the report:

```bash
bun run examples:generate-mbb-topopt && bun run validate:report
```

It exits non-zero if any case leaves its tolerance band, or if the public
pages, analysis files or STEP files no longer match the run or their sources
(below). Netgen is deterministic within one engine build, so a case's `.vtu`
must match byte for byte. CI runs it, the rule check and the single-DOF
test below via `bun run test:validation` in `web/`.

## Adding a case

A case is `{ id, name, quantity, unit, tolPct, readout?, figure?, page, recipe }`
(see `cases/index.mjs`); the reference and its label come from
`recipe.readout`, and a case without a recipe is an error. Add the case file,
its page text in `textbook/<id>.mjs`, optionally a convergence study in
`convergence.mjs` (`recipeStudy`: levels are max element sizes, and one level
must be the case's own mesh), its id in `catalog.mjs`, and run
`bun run validate:report`.

## Cases

| Case                       | Validates                        | Reference                     |
| -------------------------- | -------------------------------- | ----------------------------- |
| Axial bar                  | tip extension δ = P·L/(E·A)      | mechanics of materials        |
| Bar under pressure         | u = −p·L/E, pressure sign        | mechanics of materials        |
| Cantilever beam            | tip deflection δ = P·L³/(3·E·I)  | Euler–Bernoulli               |
| Square beam torsion        | angle of twist θ = T·L/(G·K)     | Saint-Venant torsion (square) |
| Hollow shaft torsion       | angle of twist θ = T·L/(G·J)     | Saint-Venant torsion          |
| Plate with a hole          | Kt = 3.14 in a strip, 2a/W = 0.2 | Howland (1930), Peterson's    |
| Plate with a hole (shells) | Kt ≈ 3 on a shell mid-surface    | Kirsch / Timoshenko & Goodier |
| Cook's membrane            | loaded-edge deflection ≈ 23.96   | Cook (1974), Belytschko 2014  |

See `REPORT.md` for the latest FE-vs-reference numbers.

## The public pages, `/examples/` and `/examples/<id>/`

`run.mjs --report` writes the pages from one engine run — nothing on them is
typed by hand. The list of examples, and their order, is `catalog.mjs`: these
cases plus the showcases built by the generators in `examples/gallery/` (see
its README), which write their own records.

| Output                             | What it is                                                                  |
| ---------------------------------- | --------------------------------------------------------------------------- |
| `web/examples/index.html`          | the index at `/examples/`: every example with its figure, the results table |
| `web/examples/<id>/index.html`     | one page per example: problem, derivation, model, results, discussion       |
| `examples/gallery/site/<id>.vtu`   | each case as the app opens it: unsolved, on the static study                |
| `examples/gallery/site/<id>.step`  | each case's STEP file, the one a user imports                               |
| `examples/validation/surfaces/`    | each case's solved surface, for the Theory Guide's 3D viewer                |
| `examples/gallery/site/<id>.png`   | each case's figure (`lib/render.mjs`), drawn from the same solve            |
| `examples/gallery/site/<id>/`      | the page's diagrams and charts as image files (below); nothing else         |
| `web/public/examples/results.json` | every number on the case pages, plus the engine id; linked as the raw data  |
| `web/public/sitemap.xml`           | the block between the `examples` markers lists the index and every page     |
| `REPORT.md`                        | the results table in Markdown                                               |

Next to each `<id>.step`, `<id>.model.step` holds the geometry after the
recipe's splits: the one the `.vtu`'s CAD faces refer to, which the app
re-meshes an opened case from (`lib/model-step.mjs`).

`results.json` names the builds behind its numbers (`lib/provenance.mjs`):
`engine`, the C++ engine, and `fem`, the Rust module that solves the cases
(a hash of the compiled module, which has no version id of its own).

Vite copies every `web/examples/**/index.html` into the build (`STATIC_PAGES`)
and `examples/gallery/site/` next to them. The text comes from the sources:
each case's `page` block (model, inputs, supports, load, measured quantity,
source, optional note), `textbook/<id>.mjs` (the page: introduction,
derivation, model notes, discussion, references and the sketch from
`lib/figures.mjs`), `convergence.mjs` (the mesh-refinement studies, which reuse
the case recipes) and `lib/page.mjs` (layout). Equations are written in a small
TeX subset that `lib/tex.mjs` turns into MathML, so the pages stay static and
crawlable. Every number in the text is computed from the case inputs or the
run. Change the sources and regenerate — never edit the outputs by hand:

```bash
cd web && bun run validate:report    # ~1 min: the convergence studies dominate
cd web && bun run validate:pages     # seconds: page text or a figure changed, no new solve
```

### Diagrams and charts as image files

The sketches (`lib/figures.mjs`) and charts (`lib/page.mjs`, `textbook/*.mjs`)
are written as SVG markup with `role="img"` and an `aria-label`, styled by the
figure CSS in `web/docs-layout.mjs`. `web/figure-assets.mjs` turns each one into
files in `examples/gallery/site/<id>/`, served at `/examples/<id>/`:

- `<id>-<name>.svg` and `<id>-<name>-dark.svg`: the figure CSS with that
  theme's colours resolved, and subsets of the page fonts (IBM Plex, KoFEM
  Math) embedded, so each renders as the inline figure did;
- `<id>-<name>.png`: the light SVG rasterised by resvg at twice its size with
  the same font subsets, a crawlable fallback.

The page shows them with one `<picture>` per theme (SVG `<source>`, PNG
`<img>` with the aria-label as `alt`); the theme switch hides the other one, which
is then never fetched. The sitemap lists each page's result figure and figure
PNGs as images, and the JSON-LD names them. `<name>` is the SVG's `data-name`
(`svg(…, { name })` in `lib/figures.mjs`), else `diagram` or `chart`, numbered
when a page has several. Any new figure on any example page gets the same
treatment: write SVG with an aria-label and regenerate. The PNG and SVG bytes
are deterministic, so the plain run checks them like the pages, and reports
files no figure produces any more.

Every plain run compares itself with the committed `results.json` — each case's
value to 1e-4 relative, its reference, band, mesh and inputs, and the read-out
the app's Result summary shows — checks that each case's `.vtu` holds the case's
model, and re-renders every page from the committed data and records, which
must match the committed HTML. It fails with the list of differences when any
disagrees. So an engine change that moves a published number, or a text or
layout change, fails CI until the pages are regenerated. The convergence
studies and the result figures are only refreshed by `--report`.
`web/tests/examples-page.spec.ts` checks that the pages are served, complete and
indexable, that the old `/validation/` addresses redirect to them, and that
opening each example in the app and solving it shows the read-out its page
publishes.

Cook's membrane is measured at the middle of the loaded edge, (48, 52), where
the published 23.96 belongs; the top corner converges to about 25.2. The case
used to compare the corner with 23.9, which is why its study crossed the
reference. Quadratic tetrahedra now level off 0.1 % below it.

## Topology-optimization benchmarks

The linear-elastic cases above check a single FE scalar against a closed form. A
topology-optimization run has no such closed form, so the SIMP + MMA optimizer
(KOF-230/231) has its own benchmark suite under [`topopt/`](topopt/) — the MBB
beam, a 3D cantilever, and a mesh-independence check — each locking a converged
compliance/volume trajectory and the emergent layout to a tolerance band:

```bash
node examples/validation/topopt/run.mjs
```

## What shapes the tolerances

The engine targets interactive, in-browser solves, which sets two limits the
cases are designed around:

- **Quadratic where linear tetrahedra fail.** The bars and the shell plate use
  linear elements, the fast interactive default. Bending, torsion and stress
  peaks use quadratic (P2) tetrahedra: linear ones lock in bending (the
  cantilever's study: −15% at 25 mm, still −3.9% at 12.5 mm) and read stress
  peaks noisily, while P2 lands within a percent on meshes that solve in
  seconds. The convergence studies show both orders.
- **Displacement validates tighter than stress.** Displacements are the primary
  CG unknowns and land within a few percent (often < 1%). Element-wise stress is
  noisier, so the stress cases (the plate with a hole, solid and shell) carry
  wider bands.

Cases that need symmetry / roller boundary conditions (NAFEMS LE1/LE10, the
MacNeal–Harder thin curved/twisted beams, a Lamé pressure cylinder) are the
natural next additions now that the engine supports single-DOF constraints — see
below.

## `dof-constraint.test.mjs` — single-DOF regression

Guards the fix that lets a node be constrained in one direction only (e.g. a
symmetry-plane roller) instead of being silently full-pinned. A unit cube held
by a single-DOF 3-2-1 restraint is pulled in x; a node fixed in **Ux only** must
still contract in y and z under Poisson's effect.

```bash
node examples/validation/dof-constraint.test.mjs
```

This requires the `fixed_dofs` support in `engine/cpp/engine.cpp`, so it only
passes against a **freshly built** WASM. On the committed binary (before
`scripts/build-wasm.sh`) it fails on purpose — that failure is the reminder to
rebuild. CI rebuilds the WASM, so it gates the fix there.

## `prescribed-displacement.test.mjs` — non-zero Dirichlet regression

Guards the fix for issue #216: a face given a **non-zero** prescribed
displacement (e.g. Ux = δ) must actually deform to that value instead of being
silently pinned to zero. A box is stretched in x by a prescribed displacement on
one face — with **no applied load** — and the loaded face must reach ux ≈ δ while
the free transverse directions show Poisson contraction.

```bash
node examples/validation/prescribed-displacement.test.mjs
```

Like the single-DOF test, this needs the `prescribed_dofs` support compiled into
`engine/cpp/engine.cpp`, so it only passes against a **freshly built** WASM and
fails on purpose on the committed binary until `scripts/build-wasm.sh` runs.

## `shell-prescribed-displacement.test.mjs` — non-zero Dirichlet on shells

The shell counterpart of the test above, guarding KOF-210. The solid path got
inhomogeneous Dirichlet conditions from MFEM; the shell formulation's boundary
conditions were homogeneous-only, so a prescribed displacement on a shell model
either refused to run or — on the auto-shell and coupled paths — silently pinned
the value to zero and returned an all-zero field that looks converged. Thin
walls become shells automatically at mesh time, so this was easy to hit without
choosing a shell idealisation.

A flat strip is stretched in its own plane by a prescribed edge displacement,
with **no applied load**. The driven edge must reach ux ≈ δ, midspan must land
on the linear field δ/2, and the driven edge must still contract under Poisson's
effect — proving it was driven, not clamped.

```bash
node examples/validation/shell-prescribed-displacement.test.mjs
```

The element math behind it is also covered natively, without a WASM build, by
`bash scripts/test-shell.sh` (the `shell-prescribed-*` and `coupled-prescribed-*`
checks in `engine/tests/shell_validation.cpp`).
