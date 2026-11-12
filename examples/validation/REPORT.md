# KoFEM validation results

Each case is built as a user builds it in the app — a STEP file meshed by
Netgen, supports and loads on whole CAD faces, solved by the app's own code
and the real WASM engine — and compared against its closed-form or published
reference. The same numbers are published at <https://kofem.org/examples/>,
with one page per example (derivation, model, mesh convergence, discussion,
how to reproduce). Regenerate them with:

```bash
cd web && bun run validate:report
```

| Case | Quantity | FE result | Reference | Error | Tol | Status |
| --- | --- | ---: | ---: | ---: | ---: | :---: |
| Axial bar in tension | tip extension δ | 0.47380 mm | δ = P·L / (E·A) | -0.50% | 2% | ✅ |
| Bar under end pressure | tip displacement u | -4.7380e-3 mm | u = −p·L / E | -0.50% | 2% | ✅ |
| Cantilever beam under tip load | tip deflection δ | -1.9040 mm | −P·L³ / (3·E·I) | -0.04% | 1% | ✅ |
| Square beam under torsion | angle of twist θ | 8.8561e-4 rad | θ = T·L / (G·K) | +0.74% | 5% | ✅ |
| Plate with a hole | stress-concentration factor Kt | 3.1268 | Howland's Kt for 2a/W = 0.2 | -0.42% | 3% | ✅ |
| Plate with a hole (shells) | stress-concentration factor Kt | 3.1766 | Howland's Kt for 2a/W = 0.2 | +1.17% | 8% | ✅ |
| Hollow shaft under torsion | angle of twist θ | 1.4774e-3 rad | θ = T·L / (G·J) | +1.97% | 5% | ✅ |
| Cook's membrane | loaded-edge deflection | 23.936 mm | converged plane-stress value | -0.10% | 1% | ✅ |
