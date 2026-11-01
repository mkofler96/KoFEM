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
kinds of example:

- **Validation cases** (`examples/validation/cases/`): structured hex models
  solved on every CI run. `bun run validate:report` (in `web/`) writes their
  `.vtu` and `.png` here, the pages (`web/examples/`) and
  `web/public/examples/results.json`.
- **Showcases**, each built by a generator in this folder through the app's own
  pipeline. A generator writes `site/<id>.vtu` (plus `.step` where the model
  can be re-meshed), `site/<id>.png` and `showcase/<id>.json`, the numbers on
  its page. Run `bun run validate:report` afterwards to re-render the pages.

`site/` is served at `/examples/`, next to the pages: Vite serves it in dev and
copies it into `dist/examples/` on build (`web/vite.config.ts`). Never hand-edit
a `.vtu`, `.png`, record or page; change the case, generator or page text
(`examples/validation/textbook/<id>.mjs`) and regenerate. CI fails when a page
no longer matches its sources or a case's `.vtu` no longer matches its model.

| Generator                       | Example                          | Run (in `web/`)                              |
| ------------------------------- | -------------------------------- | -------------------------------------------- |
| `generate-cantilever.mjs`       | cantilever beam from a STEP file | `bun run examples:generate-cantilever`       |
| `generate-plate-hole-shell.mjs` | plate with a hole, shells        | `bun run examples:generate-plate-hole-shell` |
| `generate-mbb-topopt.mjs`       | MBB beam, topology optimization  | `bun run examples:generate-mbb-topopt`       |

A page's figure is drawn by `examples/validation/lib/render.mjs` from the solved
model, coloured as the app colours it, so the page needs no script or WebGL.

## Examples are built the way a user builds them

Every showcase should be one a user can make in the app: a generator
creates it through the same engine calls the UI makes — import, the split tool,
whole-CAD-face picks — never from geometry or node sets the app cannot produce.
Face entries then carry their `cadFaceId`, so an opened example keeps its
supports and loads through a re-mesh.

The MBB beam and the cantilever beam follow this. The validation cases and the
shell plate with a hole do not: they are structured meshes with node-set
boundary conditions, which the app's Netgen pipeline cannot reproduce. Their
loads are still built exactly as the app builds them
(`examples/validation/lib/app-model.mjs`), so solving an opened example gives
the number on its page.

## The cantilever beam (with a hand check)

`generate-cantilever.mjs` builds δ = P·L³ / (3·E·I) as a user would: import a
1000 × 100 × 100 mm block, mesh it at 25 mm with quadratic tetrahedra (linear
ones lock in bending), clamp the face x = 0, load the face x = 1000 with
Fy = −10 kN. It opens ready to run, so its `.vtu` is saved **unsolved**, on
the static study, with a `handCheck` block (`web/src/lib/handCheck.ts`) the
Results panel compares the tip deflection with. It ships `cantilever-beam.step`,
so it can be re-meshed.

The empty app's "Try a sample simulation" is not one of these examples: it opens
the wall bracket's CAD file (`web/public/samples/`) with nothing set up, and a
guide walks the user through meshing, supports, load and run.

## The MBB beam (topology optimization)

`generate-mbb-topopt.mjs` builds the classical MBB minimum-compliance benchmark
with KoFEM's own pipeline only, by the steps a user takes in the app:

1. **Geometry → Import STEP**: a plain 300 × 50 × 10 mm block (`step-prism.mjs`),
   six faces.
2. **Split faces or bodies with a plane… → Faces**, cutting plane `x = …`: the
   bottom face at x = 5, then its long piece at x = 295 (the pin and roller
   pads); the top face at x = 145, then its right piece at x = 155 (the 10 mm
   load pad). The generator sends the worker's exact `split_geometry` requests.
3. **Mesh** at a 5 mm max element size (the app's mesher options → ~8k tets).
4. **Constraints**: the left pad Ux Uy Uz, the right pad Uy; **Load**: Fy = −1000 N
   on the mid-span pad.
5. **Optimize**: volume fraction 0.5, p = 3, r_min = 10 mm; fails if it does not
   converge or no topology emerges.

`web/tests/mbb-by-hand.spec.ts` walks these steps through the UI with real
clicks and checks the result is the model the gallery ships, face for face.

It ships `mbb-beam-topopt.step` — the split block, as the engine wrote it — next
to the `.vtu`, so the example opens in the Optimize step ready to run **and** can
be re-meshed: the supports and the load are whole CAD faces and follow them onto
the new mesh. The run converges 192.6 → 47.5 N·mm in 88 iterations.

The half-model regression benchmark on a structured hex grid lives in
`examples/validation/topopt/cases/mbb-beam.mjs`.
