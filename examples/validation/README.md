# KoFEM validation suite

Each case here is solved by the **real MFEM WASM engine** — the same binary the
browser app runs — and compared against a closed-form or published reference.
No solver is re-implemented; the meshes, boundary conditions and loads are built
in plain JS, fed to `solve_linear_elastic`, and the result is checked against
theory. This doubles as a CI regression gate and as the source of the numbers
shown in the landing-page tutorial.

## Run

```bash
node examples/validation/run.mjs            # run all cases, print a table
node examples/validation/run.mjs --report   # also (re)write REPORT.md
```

It exits non-zero if any case leaves its tolerance band. CI runs it (and the
single-DOF test below) via `bun run test` in `web/`.

## Cases

| Case                 | Validates                       | Reference                     |
| -------------------- | ------------------------------- | ----------------------------- |
| Axial bar            | tip extension δ = P·L/(E·A)     | mechanics of materials        |
| Cantilever beam      | tip deflection δ = P·L³/(3·E·I) | Euler–Bernoulli               |
| Cantilever beam (P2) | δ on a coarse mesh, order 2     | Euler–Bernoulli               |
| Square beam torsion  | angle of twist θ = T·L/(G·K)    | Saint-Venant torsion (square) |
| Plate with a hole    | stress-concentration Kt ≈ 3     | Kirsch / Timoshenko & Goodier |
| Hollow shaft torsion | angle of twist θ = T·L/(G·J)    | Saint-Venant torsion          |
| Cook's membrane      | top-corner deflection ≈ 23.9    | Cook (1974)                   |

See `REPORT.md` for the latest FE-vs-reference numbers.

## What shapes the tolerances

The engine targets interactive, in-browser solves, which sets two limits the
cases are designed around:

- **Mostly order 1.** Most cases use linear elements and refine the mesh, which
  matches the fast interactive default. The **Cantilever beam (P2)** case opts
  into order-2 elements, which the engine solves with a tighter 1e-6 CG
  tolerance — on its deliberately coarse mesh, P1 shear-locks to ~30% error
  while P2 lands under 2%, exercising the quadratic DOF path (edge-midpoint
  Dirichlet extension) that the order-1 cases never reach.
- **Displacement validates tighter than stress.** Displacements are the primary
  CG unknowns and land within a few percent (often < 1%). Element-wise stress is
  noisier, so the one stress case (plate with a hole) carries a wider band.

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
