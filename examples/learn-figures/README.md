# Learn-article figures

Scripts behind the worked example at `/learn/hinge-bracket-stiffness/`. They
exist so the article's numbers and figures stay checkable against the engine
rather than becoming prose that quietly goes stale.

| Script                       | What it does                                                                                  |
| ---------------------------- | --------------------------------------------------------------------------------------------- |
| `analyze-hinge.mjs`          | Runs the full pipeline on `scharnier.igs` across mesh sizes and element orders, printing k_w. |
| `generate-hinge-figures.mjs` | Writes both SVG figures into `web/public/learn/`.                                              |

Run them from `web/` (the engine binary is resolved relative to
`web/src/wasm/pkg`, so it must be fetched or built first):

```bash
cd web
bun ../examples/learn-figures/analyze-hinge.mjs          # the whole sweep
bun ../examples/learn-figures/analyze-hinge.mjs 5 2      # one point: 5 mm, order 2
bun run learn:figures                                     # regenerate both SVGs
```

The sweep takes several minutes — it is one complete mesh-and-solve per row, and
the article publishes thirteen of them.

## The model

Geometry is `web/public/examples/scharnier.igs`, a surface-only IGES export that
KoFEM sews into a solid at import. Boundary conditions are tied to **OCC face
indices**, not node numbers, so they survive re-meshing at a new element size:

- face `6` — the mounting plate's seating face at y = −20 mm, fully fixed
- faces `22` and `25` — the two half-cylinders of the eye bore, carrying the
  1000 N load in +z

Those indices come from the CAD topology. If the geometry file is ever
re-exported they can change, and `analyze-hinge.mjs` fails loudly with the node
and triangle counts it found rather than silently solving the wrong problem.

## Updating the article

`generate-hinge-figures.mjs` draws the boundary-condition figure straight from a
freshly generated mesh, so it tracks the geometry automatically. The convergence
plot cannot — its data is the output of thirteen solves — so those numbers are
pasted into the `CONVERGENCE` table at the top of that script. When the model or
the solver changes, re-run `analyze-hinge.mjs`, update that table and the table
in the article, then regenerate.
