# Coupled solid + shell showcase

Solves the **crane-hook assembly** with its thin holder modelled as **Kirchhoff
shells** coupled to the solid pin and hook — the model that fails to converge
when everything is meshed as solid tets (issue #358), because the thin holder is
ill-conditioned and the pin/hook contact is a near-hinge.

From `web/` (the scripts import the app's TypeScript):

```bash
bun ../examples/shell-coupling/crane-holder-shell.mjs
bun ../examples/shell-coupling/crane-holder-shell.mjs --vtu /tmp/crane-shell.vtu   # + ParaView output
```

Exits non-zero if the coupled solve does not converge, so it doubles as a
verification / regression check.

## What it demonstrates

The pipeline is fully automatic from the STEP file:

1. **Mesh** the assembly (Netgen OCC) → tets + per-tet body id + CAD face ids.
2. **Detect thin walls** — pairs of opposite planar CAD faces — and **collapse**
   each to a shell mid-surface facet carrying that wall's own thickness
   (`extractThinWallShells`). The holder's walls run 0.6–5.4 mm.
3. **Keep the bulk bodies solid** (pin, hook); **weld** the pin↔hook contact that
   otherwise meets at only a couple of coincidental nodes. Netgen meshes the two
   bodies independently, so the raw mesh joins them at exactly two nodes — a
   hinge, not a joint. The tie is *declared* by the caller (`buildCoupledModel`'s
   `ties`, naming the hook eye face and the pin body); it is no longer detected
   from geometry.
4. **Couple** the shell holder to the solid with a **distributing (RBE3)**
   constraint — transmits force *and* moment across the mid-surface offset,
   tolerant of the non-conforming interface (`buildCoupledModel`).
5. **Solve** with the app's coupled solve (`web/src/lib/solve/coupledRust.ts`):
   the Rust module assembles the solid, the DKT shells and the RBE3 couplings
   and solves the combined system.

The reusable geometry steps live in `lib.mjs`; meshing runs in the C++ engine.

## Underlying pieces (all unit-tested)

- `crates/kofem-fem/src/shell` — the DKT+CST Kirchhoff shell; validated
  against plate/membrane theory by `crates/kofem-fem/tests/shell.rs`.
- `crates/kofem-fem/src/coupling.rs` and `coupled_static.rs` — the RBE2/RBE3
  couplings and the coupled shell/solid solve (`crates/kofem-fem/tests/mixed.rs`,
  `coupling.rs`).

## Caveats

This is a **showcase**, not a certified analysis. The shell↔solid interface uses
an automatic proximity coupling, and the result is checked for *convergence and
plausibility*, not against a reference solution. The mesh is deliberately coarse
for a quick run. Treat the displacement as "the coupled model solves," not a
validated stress result.
