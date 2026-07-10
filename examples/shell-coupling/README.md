# Coupled solid + shell showcase

Solves the **crane-hook assembly** with its thin holder modelled as **Kirchhoff
shells** coupled to the solid pin and hook — the model that fails to converge
when everything is meshed as solid tets (issue #358), because the thin holder is
ill-conditioned and the pin/hook contact is a near-hinge.

```bash
node examples/shell-coupling/crane-holder-shell.mjs
node examples/shell-coupling/crane-holder-shell.mjs --vtu /tmp/crane-shell.vtu   # + ParaView output
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
   otherwise meets at only a couple of coincidental nodes (`tieSolidBodies`).
4. **Couple** the shell holder to the solid with a **distributing (RBE3)**
   constraint — transmits force *and* moment across the mid-surface offset,
   tolerant of the non-conforming interface (`buildCoupledModel`).
5. **Solve** with `solve_coupled`: MFEM assembles the solid, the DKT shells and
   the RBE3 couplings are added, and the combined system is solved.

The reusable geometry steps live in `lib.mjs`; the engine solve is
`Module.solve_coupled` (see `engine/cpp/solve_coupled.cpp`).

## Underlying pieces (all unit-tested)

- `engine/cpp/shell_core.cpp` — DKT+CST Kirchhoff shell and the RBE3 coupling;
  validated against plate/membrane theory and clamped-cantilever moment transfer
  in `scripts/test-shell.sh`.
- `engine/cpp/solve_coupled.cpp` — Option A coupling: MFEM solid stiffness handed
  to the shell/coupling assembler.

## Caveats

This is a **showcase**, not a certified analysis. The shell↔solid interface uses
an automatic proximity coupling, and the result is checked for *convergence and
plausibility*, not against a reference solution. The mesh is deliberately coarse
for a quick run. Treat the displacement as "the coupled model solves," not a
validated stress result.
