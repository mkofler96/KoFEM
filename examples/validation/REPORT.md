# KoFEM validation results

Each case is built as a user builds it in the app — a STEP file meshed by
Netgen, supports and loads on whole CAD faces, solved by the app's own code
and the real WASM engine — and compared against its closed-form or published
reference. (Cases not yet rebuilt this way, KOF-322, are still structured
hexahedral models solved by the MFEM engine.) The same numbers are published
at <https://kofem.org/examples/>, with one page per example (derivation,
model, mesh convergence, discussion, how to reproduce). Regenerate them with:

```bash
cd web && bun run validate:report
```

| Case | Quantity | FE result | Reference | Error | Tol | Status |
| --- | --- | ---: | ---: | ---: | ---: | :---: |
| Axial bar in tension | tip extension δ | 0.47380 mm | δ = P·L / (E·A) | -0.50% | 2% | ✅ |
| Bar under end pressure | tip displacement u | -4.7358e-3 mm | u = −p·L / E | -0.55% | 2% | ✅ |
| Cantilever beam, linear hexahedra | tip deflection δ | -1.8378 mm | δ = P·L³ / (3·E·I) | -3.51% | 6% | ✅ |
| Cantilever beam, quadratic hexahedra | tip deflection δ | -1.9398 mm | δ = P·L³ / (3·E·I) | +1.84% | 4% | ✅ |
| Square beam under torsion | angle of twist θ | 8.5783e-4 rad | θ = T·L / (G·K) | -2.42% | 5% | ✅ |
| Plate with a hole | stress-concentration factor Kt | 2.7750 | Kt = 3 (infinite plate) | -7.50% | 15% | ✅ |
| Hollow shaft under torsion | angle of twist θ | 1.4683e-3 rad | θ = T·L / (G·J) | +1.34% | 5% | ✅ |
| Cook's membrane | top-corner deflection | 24.042 | converged ≈ 23.9 | +0.59% | 6% | ✅ |
