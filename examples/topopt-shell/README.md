# Shell & coupled topology optimization (KOF-237)

Two Node showcases that drive the shipped WASM engine's Phase-B topology
optimizers — the shell and coupled shell/solid design domains — the same way
`examples/validation/topopt` drives the solid one. Each doubles as a verification
gate (non-zero exit on failure).

Both need the compiled engine in `web/src/wasm/pkg/` — run
`./scripts/fetch-wasm-engine.sh` (or build it after editing `engine/cpp`).

## `thin-plate.mjs`

A simply-supported square plate under uniform transverse pressure, optimized for
minimum compliance under a volume constraint. The design variables are the plate's
Kirchhoff/DKT **shell facets**; a sound run pulls material into a **rib layout**
(solid stiffeners where the bending moment is largest, voids elsewhere).

```
node examples/topopt-shell/thin-plate.mjs
```

## `coupled-bracket.mjs`

A solid block (CTETRA) with a thin shell wall (CTRIA3) hanging from its underside
on an offset mid-surface, joined by distributing **RBE3** couplings. A single
density field spans the **whole coupled domain** — solid tets and shell facets
together — while the RBE3 coupling stays a fixed constraint, eliminated by the
master-slave reduction every iteration. The script checks the run converges and
respects the volume constraint, i.e. the interface is intact from the first solve
to the last.

```
node examples/topopt-shell/coupled-bracket.mjs
```

The engine sensitivities behind both (and their finite-difference verification)
are covered natively by `scripts/test-topology-shell.sh`.
