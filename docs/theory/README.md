# KoFEM Theory Guide

The Theory Guide explains the mathematics and numerical choices behind the
production C++/WASM solver. It is planned as short, linked articles rather than
one long manual.

- [`content-map.md`](content-map.md) owns the reading order, stable URL plan,
  implementation inventory, notation and unit audit, and running benchmark.
- [`article-template.md`](article-template.md) is the required starting point
  for an article.

Public articles live under `/theory/`, with source modules in `web/theory/`.
The published articles are `foundations/what-is-fem` (formerly
`foundations/model-and-units`, which redirects), the separate
`foundations/consistent-units` comparison, `notation`, and four focused operator
articles: gradients/divergence, tensor products, integration by parts, and
reference-element mappings, the solid-mechanics articles `linear-elasticity`
and `equilibrium-and-weak-form`, the numerical-methods articles
`elements-and-quadrature`, `assembly`, `loads-and-constraints` and `linear-solve`,
and the results articles `displacement-and-stress` and
`interpretation-and-convergence`. The `reading-a-study` introduction connects
these topics to `verification/axial-bar` and `verification/strategy`. The shell
extension adds `shells/formulation` and `shells/solid-coupling`, with native plate
and planar transition evidence. The optimization chapter adds `optimization/simp`,
`optimization/constraints-and-convergence` and `optimization/interpreting-designs`,
with a checked two-bar calculation and recorded WASM benchmark evidence. General FEM introductions can use standalone
physical models; KoFEM examples and
implementation sections are included when relevant. Remaining topics stay marked
as planned until reviewed.
Run `cd web && bun run theory:generate` after editing, and commit generated
HTML, figures, viewer data and sitemap. `bun run test:theory` checks output, content-map alignment
and the worked elasticity, linear-solve, stress and SIMP calculations, then executes the four
axial-bar WASM solves and the recorded topology-optimization benchmarks.

Articles use the existing examples' native MathML renderer (`tex` / `texBlock`)
and self-hosted math font. Its supported TeX subset is documented in
`examples/validation/lib/tex.mjs`; unsupported commands throw at generation.
Accompany equations with prose and local symbol anchors; link shared symbol
definitions in `/theory/notation/#<symbol-anchor>`. Its HTML IDs are permanent:
preserve them when reorganising entries. Operator entries link to the worked
examples in `/theory/operators/`; keep both directions of these links. Wrap
display math in a labelled, focusable `.equation` region so long expressions scroll by keyboard.
Sections use explicit permanent IDs, code uses `pre`/`code`, and figures have
alt text and captions. Never copy measured results from the generated examples.

Pages are read on the website and next to the app. Keep command lines,
review dates, commit hashes and Linear issue references out of article text;
they belong in this README, the PR and the Linear evidence comment. Source
links may stay, pinned to the reviewed revision.

## Figures and result viewers

Figures are textbook-style drawings, one module per article group in
`web/theory/figures/` (shared drawing helpers in `svg.mjs`, a small
deterministic triangulator in `mesh2d.mjs`). Register a figure there with its
title, alt text and size, and place it in an article with
`figure(id, caption)`. The generator publishes it through
`web/figure-assets.mjs`, as for the example pages: `public/theory/figures/<id>.svg`
with subsets of the site fonts (IBM Plex Sans, KoFEM Math) embedded, for the
browser, and `<id>.png` at twice its size, the crawlable fallback, both in one
`<picture>`. The sitemap lists each figure's PNG as an image of its article;
the generator fails on a figure no page uses and, with `--check`, on any file
that differs from what the sources render. Figures are drawn for a light
background; `theory.css` inverts them for the dark theme. Compute plotted
curves and meshes from their formulas rather than drawing them by hand, and
say in the caption when a plot is schematic.

Labels use the site fonts only, so the SVG and PNG look the same: class `sym`
sets a symbol in math italic (`text(p, "u = u_D", "sym")`, where `_D` is an
upright subscript); Greek letters in other labels go to the math font
automatically; powers of ten use `powerOfTen`. Characters a font lacks
(for example ⁻⁶ or ∝) fail the build with the label to change.

`resultViewer(id, { caption })` from `web/theory/viewers/index.mjs` embeds a
solved public example in 3D: the generator extracts the boundary surface and
the field of the example's own figure from `examples/gallery/site/<id>.vtu` into
`web/public/theory/viewers/<id>.json`. `web/public/theory/viewer.js` draws it
with three.js, served from `node_modules` at `/vendor/three/` (see
`vite.config.ts`), and leaves the example's static figure in place without
JavaScript or WebGL. Regenerate the Theory pages after re-running the examples.

Write links to a planned topic with its permanent URL. The generator points them
at the topic's planned overview entry until the article is published, and fails
on links to unknown `/theory/` pages. Numerical-methods articles pin their
source links in `web/theory/numerical-methods/sources.mjs`; update its revision
and line numbers together when the implementation changes. Results and
solid-mechanics articles use their own snapshots in
`web/theory/results/sources.mjs` and `web/theory/solid-mechanics/sources.mjs`.

These files version with the code; Linear remains the source of truth for
issue planning and architecture decision records (ADRs).

## Updating behavior, pages and evidence

Use the same PR for an implementation change and the descriptions of its final
behavior. Review this mapping before deciding which articles to update:

| Changed behavior                                              | Review these articles and evidence                                                                                       |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Formulation, strain/material law, geometry or unit convention | What is FEM?, notation, relevant operators, linear elasticity, equilibrium/weak form, and the bar’s reference assumptions |
| Element family/order, quadrature or assembly                  | Reference mapping, elements/quadrature, assembly, affected mesh/order studies and DOF counts                             |
| Loads, constraints or their defaults                          | Loads/constraints, reading-a-study, bar setup, source references and numerical bands                                     |
| Solver method, tolerance, continuation or failure behavior    | Linear solve, benchmark solver settings, live numerical checks and reviewed engine identity                              |
| Result arrays, sampling, field names, averaging or display    | Displacement/stress, interpretation/convergence, bar measurement, app readout and example reproduction                   |
| A measured number or numerical default                        | Investigate the difference, rerun the affected case/studies, explain the trend and review all dependent pages            |

A source edit does not itself verify a numerical claim. Run the affected case
through the production engine and preserve the command, engine ID and exact
source revision in the evidence. Do not widen a band just to make a changed
number pass. Tolerances belong to the measured quantity and reference model;
the bar’s 2% extension band accommodates a fully clamped 3D end absent from the
1D formula. Its 0.5% stress band applies to every unsmoothed centre sample in
the fixed 400–600 mm region. The Q2 hex row is diagnostic because the existing
constraint extension leaves face-centre DOFs free; it is not evidence for order
convergence with the same clamp.

From the repository root, after fetching/building the matching engine:

```sh
bash scripts/fetch-wasm-engine.sh
bun examples/validation/run.mjs --case axial-bar
bun examples/validation/axial-bar-study.mjs
```

The study checks the engine source ID, all result lengths and finiteness, the
reference bands, and the committed numerical snapshot. It reuses the public
case builder, app-model adapter, mesh statistics and real WASM loader. To update
its snapshot, first commit the reviewed code/measurement changes so the recorded
revision contains the code that ran. Then run:

```sh
bun examples/validation/axial-bar-study.mjs --report
cd web
bun run theory:generate
bun run test:theory
bun run typecheck && bun run lint && bun run format:check
bun x playwright test tests/theory-page.spec.ts
```

`--report` records that checkout’s HEAD, matching engine, timestamp, inputs,
settings, full-precision results and command in
`web/public/theory/axial-bar.json`. The Theory article renders that record;
never type measured numbers into article prose. A later documentation-only
commit may contain the generated snapshot. Compare published displacement
against `web/public/examples/results.json` as well; the public case and the
20 × 4 × 4 order-1 row must agree. The existing validation runner enforces the
example record and saved analysis against a fresh solve.

For changes to example inputs, textbook text or measured behavior, edit the
case/generator sources and run `cd web && bun run validate:report`; review and
commit the affected HTML, records and saved analyses. Never hand-edit generated
pages or VTU results. Existing other benchmark studies may be linked without
rerunning them, but name them as existing evidence and retain their own engine
record.

The browser Theory suite checks every published page’s local main-content
links and fragments, metadata, unique IDs, equations and reading order. It also
checks mobile widths, native MathML, keyboard navigation, theme and canonical
redirects. Extend its page lists when publishing an article. Keep symbol/operator
anchors consistent, introduce necessary concepts in the explanation, omit
prerequisite labels and visible heading permalinks, and preserve published IDs.
Check pinned source links against the recorded revision, including line numbers.

In the PR and the issue’s single evidence comment, distinguish executed tests,
source review and reused evidence. Include the failing/passing reading-path
check, site build, selected numerical output, screenshots at desktop/mobile
widths, exact tested revision and any unresolved limitation. The public guide
explains the numerical limitation; Linear keeps its follow-up plan.

## Shell and coupling evidence

Shell articles pin implementation links to the source revision in
`web/public/theory/shells.json`. The native production-core checks feed that
record directly; its compiler and printed precision are explicit. Run:

```sh
node web/theory/shells/capture-evidence.mjs
```

This checks the existing square-plate cases and the planar wall-on-block study
at refinements 1 and 2 against the committed record. It uses `CXX` (default
`g++`). For an intentional evidence update with reviewed, committed solver
sources, use `--report`, regenerate the Theory pages and review the record.
Keep native execution separate from CAD extraction and WASM wrapper evidence:

```sh
cd web
bun tests/test_shell_footprint.mjs --wasm
```

Review both shell articles and the shared shell notation when changing section
kinematics, thickness, materials, loads, extraction, or coupling. Re-run the
affected comparisons, retaining their sampling regions and reference limits.
Same-mesh planar transition agreement does not verify arbitrary junction-stress
accuracy or general distributing coupling. The full shell-core suite and the
app footprint check remain part of existing CI; the native record comparison
above is an additional contributor check.

## Topology optimization evidence

Optimization articles pin source links to the revision in
`web/public/theory/optimization.json`. The record comes from the existing MBB
and cantilever mesh-independence benchmarks in `examples/validation/topopt/`,
run through the real WASM `optimize_topology` entry. From `web/`:

```sh
bun theory/optimization/simp-example.mjs
bun theory/optimization/capture-evidence.mjs
```

The first checks the two-bar worked calculation and its finite-difference
sensitivities. The second re-runs both benchmarks, asserts their own checks and
compares every recorded number with the fresh run; it fails if the engine
identity changed. For an intentional update with committed engine and benchmark
sources, use `--report`, regenerate the Theory pages and review the record.

Review all three optimization articles when changing the SIMP interpolation,
objectives, sensitivities, filter, MMA settings, stopping rules, stress
constraint, supported domains, app defaults, density display or export. The
articles describe shipped behaviour; ADR-0002 in Linear remains the
architecture record. Keep open work (for example KOF-238 and KOF-251) out of
shipped-behaviour statements until it merges.
