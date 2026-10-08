<!--
SPDX-FileCopyrightText: 2026 Michael Kofler
SPDX-License-Identifier: AGPL-3.0-or-later
-->

# Gallery — kofem.org/examples/

Everything on the public [examples gallery](https://kofem.org/examples/).

- `site/` is served verbatim at `/examples/`: the gallery page (`index.html`),
  its manifest `examples.json`, and the `<id>.vtu` (plus optional `<id>.step`)
  that "Open in KoFEM web" loads through `/app/?example=<id>`. Vite serves it in
  dev and copies it into `dist/examples/` on build (`web/vite.config.ts`).
- The generators here write `site/`. Never hand-edit a `.vtu` or
  `examples.json`; change the generator and re-run it:

| Generator                       | Examples                        | Run (in `web/`)                              |
| ------------------------------- | ------------------------------- | -------------------------------------------- |
| `generate.mjs` + `examples.mjs` | the hex-mesh benchmarks         | `bun run examples:generate`                  |
| `generate-plate-hole-shell.mjs` | plate with a hole, shells       | `bun run examples:generate-plate-hole-shell` |
| `generate-mbb-topopt.mjs`       | MBB beam, topology optimization | `bun run examples:generate-mbb-topopt`       |

## Examples are built the way a user builds them

Every gallery model should be one a user can make in the app: a generator
creates it through the same engine calls the UI makes — import, the split tool,
whole-CAD-face picks — never from geometry or node sets the app cannot produce.
Face entries then carry their `cadFaceId`, so an opened example keeps its
supports and loads through a re-mesh.

The MBB beam follows this. The five hex-mesh benchmarks (`examples.mjs`) and the
shell plate with a hole do not yet: they are structured meshes with node-set
boundary conditions, which the app's Netgen pipeline cannot reproduce.

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
