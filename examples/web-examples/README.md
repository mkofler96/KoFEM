<!--
SPDX-FileCopyrightText: 2026 Michael Kofler
SPDX-License-Identifier: AGPL-3.0-or-later
-->

# Web gallery examples

Generators for the analyses shipped in `web/public/examples/`. Each writes a
`.vtu` plus its entry in `examples.json`; `generate.mjs` runs them all.

## The crane hook load case

`generate-crane-shell.mjs` builds the coupled shell + solid analysis from
`test_files/full-crane-hook.step`. The STEP holds three bodies:

| body | part | how it is modelled | material |
| ---- | ---- | ------------------ | -------- |
| 1 | holder — the tapered channel carrying the four lightening holes | thin walls (0.5 mm) collapsed to a shell mid-surface; the base block stays solid | steel |
| 2 | hook — the curl at the lower end | solid tets | aluminium |
| 3 | cylinder — the pin through the hook's bore | solid tets, tied to the bore by RBE3 across the fit clearance | steel |

Boundary conditions, matching the reference drawing:

- **Clamped**: CAD face 7, the holder's top cap (y = 260, 50 × 170 mm) — all
  six DOF.
- **Loaded**: 1000 N in −Y on **each** end disc of the cylinder — CAD faces 66
  (x = +75) and 67 (x = −125), 472 mm² each. **2 kN in total.** `LOAD_FACES` in
  the generator holds the PER-FACE vector, and so does the `.vtu` load group's
  `totalForce` field, because `rebuildSurfaceLoads` applies a group's components
  once per face entry.

![Crane hook load case](crane-load-case.png)

_(Load-case drawing supplied with the external reference run — clamp hatched at
the holder's top, 1000 N at each cylinder end, materials called out per body.)_

### Per-body materials

`mat.solid` handed to `solve_coupled` is an ARRAY, selected per tet by
`mesh.attributes` (1-based), so the aluminium hook and the steel holder solve
together. The shell side stays a single material: a solve idealises exactly one
body as shells (#376), and here that body is the steel holder.

This is why it had to be added. `solve_coupled` used to read one solid material,
and `solve_linear_elastic` — which has taken a material array since #353 — does
not converge on models containing these 0.5 mm walls, running the full
5000-iteration Gauss-Seidel PCG cap on both the assembly and the holder alone,
the latter stalling at a relative residual of 8e-3. Per-body materials and
"solves at all" used to be mutually exclusive for this model.

### Open: 2× stiffer than the external reference

An OptiStruct run of the same load case reports max |u| = 0.5482 mm. This model
gives **0.2690 mm** with the materials above. (All-steel it gives 0.1938 mm; the
strain-energy split is holder 45.2 %, hook 15.9 %, cylinder 38.9 %.)

Ruled out as the cause:

- **The shell idealisation.** Solved all-solid, with every body meshed as tets
  and no shells anywhere, the assembly gives 0.1907 mm against the coupled
  model's 0.1938 mm — 1.6 %, and within 3 % body by body.
- **The holder/hook connection.** In that all-solid model the interface is
  conformal shared nodes with no tie of any kind, and the answer does not move.
- **Mesh resolution.** 0.1938 mm at 6 mm elements, 0.1905 mm at 3 mm.
- **Load direction.** −Y gives 0.191 mm, −Z 3.976 mm, −X 6.916 mm; only −Y is
  anywhere near the reference, and the reference's contour bands run
  perpendicular to the arm and bunch toward the narrow end, which is what
  axial tension of a tapering section looks like.
- **A single body's modulus.** Reaching 0.5482 mm by softening the hook alone
  needs E ≈ 16 GPa; by softening the holder alone, walls of ≈ 0.11 mm against
  the 0.5 mm the CAD gives. Making *everything* aluminium reaches 0.5788 mm,
  which is the only configuration that lands near the reference.

Leading hypothesis, from reading the reference contour plot: it shows roughly
0.25–0.30 mm at the holder's lower end, where this model computes 0.088 mm, so
the disagreement looks concentrated in the holder rather than spread over the
three bodies. Backing an effective axial area out of the holder's share of the
compliance gives ≈ 59 mm² here against ≈ 27 mm² there. The holder is a closed
box — two tapering side walls, a back wall and a top cap, all 0.5 mm — so a
mid-surface model built from the face carrying the holes alone would land at
about that ratio. Confirming this needs the reference's shell set and thickness.
