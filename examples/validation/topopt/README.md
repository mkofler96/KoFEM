# KoFEM topology-optimization benchmarks

Canonical minimum-compliance benchmarks for the SIMP + MMA topology optimizer
(KOF-230/231, ADR-0002). Each case is optimized by the **real WASM engine** —
the same `optimize_topology` loop the browser worker drives — and its converged
compliance, volume fraction and emergent layout are checked against a documented
tolerance band. This locks the result to known references so a future change
can't silently regress it (KOF-234); it is also the correctness reference that
stands in for the absent OC cross-check (ADR-0002).

This complements the linear-elastic validation suite in `../` (which checks a
single FE scalar against a closed form). A topology-optimization run has no
single closed-form answer, so each case here asserts a **trajectory and a
topology** — several properties at once — and the runner prints per-case metrics
with a pass/fail line per check.

## Run

```bash
node examples/validation/topopt/run.mjs            # run all cases, print results
node examples/validation/topopt/run.mjs --report   # also (re)write REPORT.md
```

It exits non-zero if any check fails. The whole suite takes ~25 s against the
committed engine (the refined mesh-independence solve dominates). See
`REPORT.md` for the latest numbers and the rendered layouts.

## Cases

| Case                         | Validates                                               | Reference                         |
| ---------------------------- | ------------------------------------------------------- | --------------------------------- |
| MBB beam (half-model)        | converged compliance + the textbook truss layout        | Sigmund 99-line / Andreassen 88   |
| 3D cantilever (tip load)     | converged compliance + z-mirror symmetry of the design  | short-cantilever (e.g. top3d)     |
| Cantilever mesh-independence | same design at two resolutions with a fixed r_min        | filter mesh-independence (KOF-229)|

### MBB beam (half-model)

The simply-supported beam under a central load, modelled as its left half with a
symmetry plane (`u_x = 0`), a roller at the bottom-right corner (`u_y = 0`), and
half the load pressing down at the top of the symmetry edge. One element through
the thickness with `u_z ≡ 0` makes it a planar (2D-in-3D) problem — the same
idealisation the native loop test uses, here at a resolution that resolves the
truss. At volfrac 0.5, p 3 the optimizer returns the well-known layout: a curved
upper compression chord, a straight lower tension tie, and a triangulated web.

Checks: converges within the budget, volume fraction within 1 % of 0.5,
converged compliance inside a ±15 % band, a large overall stiffening (final /
initial compliance < 0.3), the run ends at its stiffest design, and a real
bimodal topology emerged (not a stalled gray field).

### 3D cantilever (tip load)

A genuinely 3D 2:1:1 box, fully fixed over its root face, loaded down along the
bottom edge of the free tip. With all three translations free the optimizer
moves mass out of plane onto the two outer z-faces (an I-section's
flanges-and-web), each face carrying a tip-loaded cantilever truss. Because the
geometry, supports and load are all symmetric about the z-midplane, the design
**must** be too — we assert that mirror symmetry (to `< 1e-3`), a strong
correctness check a buggy solve would break, alongside the compliance band,
volume fraction and bimodal-topology checks.

### Cantilever mesh-independence

The same cantilever problem optimized on a 10×5×5 grid and on a 20×10×10 grid (an
exact factor-2 refinement) while the **physical** filter radius `r_min` is held
fixed. That is exactly what the density/sensitivity filter (KOF-229) exists to
buy: without it, refining the mesh lets ever-thinner members appear and the
topology keeps changing; with it, `r_min` sets a real length scale, so both grids
must converge to the same design. The fine density is averaged onto the coarse
grid and three things are checked: the converged compliances agree (within 5 %),
the density fields correlate tightly (> 0.9), and the thresholded solid regions
overlap (IoU > 0.85).

## Why synthetic meshes, not STEP fixtures

The benchmarks build **structured hex meshes in JS** (`lib/topopt.mjs`) rather
than importing STEP geometry. A regression lock needs a fixed design domain so
the compliance/volume trajectory is identical on every run, and Netgen's CAD
meshing is not bit-reproducible. A structured grid also gives a trivial
element↔(i,j,k) map, which the mesh-independence projection and the symmetry
check rely on. No `test_files/` fixture is needed.

## Tolerances and reproducibility

The engine is deterministic (the native loop test asserts bit-identical reruns),
so on a given binary the numbers are exact. The compliance bands are ±15 % to
tolerate numerical drift across engine rebuilds (compiler / library changes)
while still catching a real optimizer regression; the volume fraction, symmetry
and mesh-independence bounds are tight because they follow from the formulation,
not the numerics.

MMA legitimately oscillates mid-run while the layout reorganises, so the cases do
**not** demand a monotone trajectory; they require the run to *end* at its
stiffest design (the returned compliance is the minimum of the whole history).

## Relationship to the other TO checks

- **`engine/tests/topology_optimize_validation.cpp`** (KOF-230) is the native C++
  check of the loop's trajectory on a tiny MBB. It links MFEM and runs under node
  via Emscripten (`scripts/test-topology-optimize.sh`); like the other
  `engine/tests/`, CI does not run it yet (KOF-207). These `examples/` cases are
  the web-side counterpart: they run against the fetched engine with no build
  step, and lock the visual "textbook truss" layout the native test defers here.
- **`web/tests/topology-benchmark.spec.ts`** is a fast Playwright guard that runs
  a small MBB through the solver worker and asserts the same trajectory shape, so
  the Playwright suite catches a regression on every CI run without the full
  benchmark's runtime.
