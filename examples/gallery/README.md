<!--
SPDX-FileCopyrightText: 2026 Michael Kofler
SPDX-License-Identifier: AGPL-3.0-or-later
-->

# Examples — kofem.org/examples/

The public example pages: [kofem.org/examples/](https://kofem.org/examples/)
and one page per example, `/examples/<id>/`. Each example is a model the app
opens at `/app/?example=<id>`, with a static, crawlable page in the same
place: the problem, the reference solution, KoFEM's result and a figure of the
solved model. There is one list, in `examples/validation/catalog.mjs`, and two
kinds of example, both built from a **recipe**: one STEP file and the GUI's
steps (`examples/validation/lib/recipe.mjs`):

- **Validation cases** (`examples/validation/cases/`), built and checked on
  every CI run. `bun run validate:report` (in `web/`) writes their `.vtu`,
  `.step`, `.model.step` and `.png` here, the pages (`web/examples/`) and
  `web/public/examples/results.json`.
- **Showcases**, models without a closed-form answer, each built from its
  recipe in `recipes/` by a generator in this folder. A generator writes
  `site/<id>.vtu`, `.step`, `.model.step`, `site/<id>.png` and
  `showcase/<id>.json`, the numbers on its page.

To regenerate everything, run the generators first, then the report, which
renders every page from the case runs and the showcase records:

```bash
cd web
bun run examples:generate-mbb-topopt
bun run validate:report
```

An example built from a STEP file ships two: `<id>.step`, the file a user
imports (the page links it), and `<id>.model.step`, the geometry after the
splits that the `.vtu`'s CAD faces refer to. The app restores the second when it
opens the example, so a re-mesh keeps every support and load on its face
(`examples/validation/lib/model-step.mjs`).

`site/` is served at `/examples/`, next to the pages: Vite serves it in dev and
copies it into `dist/examples/` on build (`web/vite.config.ts`). Never hand-edit
a `.vtu`, `.png`, record or page; change the case, recipe, generator or page
text (`examples/validation/textbook/<id>.mjs`) and regenerate. CI fails when a
page no longer matches its sources or a case's `.vtu` no longer matches its
model.

| Generator                 | Example                         | Run (in `web/`)                        |
| ------------------------- | ------------------------------- | -------------------------------------- |
| `generate-mbb-topopt.mjs` | MBB beam, topology optimization | `bun run examples:generate-mbb-topopt` |

A page's figure is drawn by `examples/validation/lib/render.mjs` from the solved
model, coloured as the app colours it, so the page needs no script or WebGL.
Its diagrams and charts are published as SVG and PNG files in `site/<id>/`
(`web/figure-assets.mjs`; see `examples/validation/README.md`).

## Examples are built the way a user builds them

Every example is built through the app's steps from its STEP file: import,
split, mesh, material, supports and loads on whole CAD faces, run. The build
(`examples/validation/lib/pipeline.mjs`) makes the same engine calls the UI
makes and solves with the app's own code, so solving an opened example gives
the number on its page, and every face entry carries its `cadFaceId`, so a
re-mesh keeps every support and load. There are no exceptions:

- `examples/validation/rules.mjs` fails if an example has no recipe, no STEP
  file, no geometry in its `.vtu`, a hexahedron, a support or load that is not
  a whole CAD face, or no hand check (or, for an optimization, no Optimize
  settings);
- `web/tests/examples-by-hand.spec.ts` rebuilds every example from its recipe
  with real clicks and must get the published number;
- `web/tests/example-remesh.spec.ts` opens every example and re-meshes it with
  its supports and loads on the same CAD faces.

## The cantilever beam (with a hand check)

The cantilever beam (`cantilever-beam`) is a 1000 × 100 × 100 mm block meshed
at 25 mm with quadratic tetrahedra, the face x = 0 clamped, the face x = 1000
loaded with Fy = −10 kN (`examples/validation/cases/cantilever-beam.mjs`).
Like every example, its `.vtu` is saved **unsolved**, on the static study, with
a `handCheck` block (`web/src/lib/handCheck.ts`) the Results panel compares the
tip deflection with. Its page carries the P1-vs-P2 convergence study: linear
tetrahedra lock in bending, which is why the example uses quadratic ones. The
app's tests open it as the standard solved-in-seconds model.

The empty app's "Try a sample simulation" is not one of these examples: it opens
the wall bracket's CAD file (`web/public/samples/`) with nothing set up, and a
guide walks the user through meshing, supports, load and run.

## The MBB beam (topology optimization)

`generate-mbb-topopt.mjs` builds the classical MBB minimum-compliance benchmark
from its recipe, `recipes/mbb-beam-topopt.mjs`, through
`examples/validation/lib/pipeline.mjs`: the steps a user takes in the app.

1. **Geometry → Import STEP**: a plain 300 × 50 × 10 mm block (`step-prism.mjs`),
   six faces.
2. **Split faces or bodies with a plane… → Faces**, cutting plane `x = …`: the
   bottom face at x = 5, then its long piece at x = 295 (the pin and roller
   pads); the top face at x = 145, then its right piece at x = 155 (the 10 mm
   load pad).
3. **Mesh** at a 5 mm max element size (the app's mesher options → ~8k tets).
4. **Constraints**: the left pad Ux Uy Uz, the right pad Uy; **Load**: Fy = −1000 N
   on the mid-span pad.
5. **Optimize**: volume fraction 0.5, p = 3, r_min = 10 mm, at most 100
   iterations; fails if it does not converge or no topology emerges.

The page's number is the final compliance, which the Results panel's run
summary shows after the run. An optimum has no closed form, so there is no
reference to compare with; `web/tests/examples-by-hand.spec.ts` walks the
recipe with real clicks and must get the published value.
`web/tests/mbb-by-hand.spec.ts` checks that the supports and the load survive a
re-mesh.

It ships `mbb-beam-topopt.step`, the plain block the page links, and
`mbb-beam-topopt.model.step`, the block after the four splits, whose CAD faces
the `.vtu`'s supports and load name. The example opens in the Optimize step,
ready to run. The run converges 192.6 → 47.5 N·mm in 88 iterations.

Showcase recipes are listed in `recipes/index.mjs`, where the rule check
(`examples/validation/rules.mjs`), the page and the GUI test find them.

The optimizer's own regression benchmark, a half-model on a structured hex grid
and not an example, lives in `examples/validation/topopt/cases/mbb-beam.mjs`.
