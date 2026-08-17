# Learn-article figures

Scripts behind the worked example at `/learn/hinge-bracket-stiffness/`. They
exist so the article's numbers and figures stay checkable against the engine
rather than becoming prose that quietly goes stale.

| Script                       | What it does                                                                                  |
| ---------------------------- | --------------------------------------------------------------------------------------------- |
| `analyze-hinge.mjs`          | Runs the full pipeline on `scharnier.igs` across mesh sizes and element orders, printing k_w. |
| `plot_hinge_convergence.py`  | Draws the convergence chart with matplotlib.                                                    |
| `generate-hinge-figures.mjs` | Rebuilds both figures and inlines them into the article. Calls the plot script for you.        |

Run them from `web/` (the engine binary is resolved relative to
`web/src/wasm/pkg`, so it must be fetched or built first):

```bash
cd web
bun ../examples/learn-figures/analyze-hinge.mjs          # the whole sweep
bun ../examples/learn-figures/analyze-hinge.mjs 5 2      # one point: 5 mm, order 2
bun run learn:figures                                     # rebuild + re-inline both figures
```

The sweep takes several minutes — it is one complete mesh-and-solve per row, and
the article publishes thirteen of them.

## Requirements

`analyze-hinge.mjs` and the boundary-condition figure need only bun and the WASM
engine. The chart additionally needs **Python 3 with matplotlib**:

```bash
pip install matplotlib
```

This is the one place in the repository that wants a Python toolchain, and it is
needed only to regenerate a committed SVG — building, testing and running KoFEM
never touch it.

## The figures are inlined, not linked

Both SVGs are written into `web/public/learn/` **and** inlined into the
article's HTML between `<!-- figure:… -->` marker comments, which
`generate-hinge-figures.mjs` owns.

Inlining is not a stylistic choice. An SVG loaded through `<img>` is an isolated
document: it cannot see the page's `data-theme` attribute, so the site's
light/dark toggle never reaches it, and it cannot use the page's webfont either.
Referenced that way, the figures rendered dark-theme axis labels on the light
background. Inlined, both figures carry `kf-` prefixed classes and a palette
scoped to their own root element, and they follow the toggle like anything else.

Keep the marker comments in the article. The generator refuses to run without
them rather than guessing where the figures go.

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
plot cannot — its data is the output of thirteen solves — so those numbers live
in the `LINEAR` and `QUADRATIC` tables at the top of `plot_hinge_convergence.py`.
When the model or the solver changes, re-run `analyze-hinge.mjs`, update those
tables and the table in the article, then run `bun run learn:figures`.
