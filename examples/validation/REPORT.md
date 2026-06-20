# KoFEM validation results

Each case is solved by the real MFEM WASM engine and compared against its
closed-form or published reference. Regenerate with:

```bash
node examples/validation/run.mjs --report
```

| Case                         | Quantity                       |   FE result |               Reference |  Error | Tol | Status |
| ---------------------------- | ------------------------------ | ----------: | ----------------------: | -----: | --: | :----: |
| Axial bar (uniaxial tension) | tip extension δ                | 4.7721e-4 m |         δ = P·L / (E·A) |  0.21% |  2% |   ✅   |
| Cantilever beam (end load)   | tip deflection δ               |   -0.0018 m |      δ = P·L³ / (3·E·I) |  3.51% |  6% |   ✅   |
| Plate with a hole (Kirsch)   | stress-concentration factor Kt |      3.3341 | Kt = 3 (infinite plate) | 11.14% | 15% |   ✅   |
| Hollow shaft under torsion   | angle of twist θ               |  0.0015 rad |         θ = T·L / (G·J) |  1.32% |  5% |   ✅   |
| Cook's membrane              | top-corner deflection          |     24.1134 |        converged ≈ 23.9 |  0.89% |  6% |   ✅   |
