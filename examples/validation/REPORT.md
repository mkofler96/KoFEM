# KoFEM validation results

Each case is solved by the real MFEM WASM engine and compared against its
closed-form or published reference. The same numbers are published at
<https://kofem.org/validation/>, with one page per case (derivation, model,
mesh convergence, discussion, how to reproduce). Regenerate them with:

```bash
node examples/validation/run.mjs --report
```

| Case | Quantity | FE result | Reference | Error | Tol | Status |
| --- | --- | ---: | ---: | ---: | ---: | :---: |
| Axial bar (uniaxial tension) | tip extension δ | 4.7730e-4 m | δ = P·L / (E·A) | +0.23% | 2% | ✅ |
| Cantilever beam (end load) | tip deflection δ | -1.8379e-3 m | δ = P·L³ / (3·E·I) | -3.51% | 6% | ✅ |
| Cantilever beam (P2, coarse mesh) | tip deflection δ | -1.9406e-3 m | δ = P·L³ / (3·E·I) | +1.88% | 4% | ✅ |
| Square beam under torsion | angle of twist θ | 8.5783e-4 rad | θ = T·L / (G·K) | -2.42% | 5% | ✅ |
| Plate with a hole (Kirsch) | stress-concentration factor Kt | 2.8709 | Kt = 3 (infinite plate) | -4.30% | 15% | ✅ |
| Hollow shaft under torsion | angle of twist θ | 1.4683e-3 rad | θ = T·L / (G·J) | +1.34% | 5% | ✅ |
| Cook's membrane | top-corner deflection | 24.113 | converged ≈ 23.9 | +0.89% | 6% | ✅ |
| Surface traction (axial bar) | tip extension δ | 4.7358e-4 m | δ = P·L / (E·A) | -0.55% | 2% | ✅ |
| Surface pressure (axial bar) | tip displacement u | -4.7358e-6 m | u = -p·L / E | -0.55% | 2% | ✅ |
