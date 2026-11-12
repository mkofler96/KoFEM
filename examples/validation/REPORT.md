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
| Bar under end pressure | tip displacement u | -4.7380e-3 mm | u = −p·L / E | -0.50% | 2% | ✅ |
| Cantilever beam, linear tetrahedra | tip deflection δ | -1.8313 mm | −P·L³ / (3·E·I) | -3.86% | 5% | ✅ |
| Cantilever beam, quadratic tetrahedra | tip deflection δ | -1.8985 mm | −P·L³ / (3·E·I) | -0.33% | 1% | ✅ |
| Cantilever beam under tip load | tip deflection δ | -1.9040 mm | −P·L³ / (3·E·I) | -0.04% | 1% | ✅ |
| Square beam under torsion | angle of twist θ | 8.8561e-4 rad | θ = T·L / (G·K) | +0.74% | 5% | ✅ |
| Plate with a hole | stress-concentration factor Kt | 2.7750 | Kt = 3 (infinite plate) | -7.50% | 15% | ✅ |
| Hollow shaft under torsion | angle of twist θ | 1.4774e-3 rad | θ = T·L / (G·J) | +1.97% | 5% | ✅ |
| Cook's membrane | top-corner deflection | 24.042 | converged ≈ 23.9 | +0.59% | 6% | ✅ |
