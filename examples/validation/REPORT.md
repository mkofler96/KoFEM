# KoFEM validation results

Each case is built as a user builds it in the app — a STEP file meshed by
Netgen, supports and loads on whole CAD faces, solved by the app's own code
and its Rust solver module — and compared against its closed-form or published
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
| Plate with a hole (shells) | stress-concentration factor Kt | 3.1142 | Howland's Kt for 2a/W = 0.2 | -0.82% | 8% | ✅ |
| Hollow shaft under torsion | angle of twist θ | 1.4774e-3 rad | θ = T·L / (G·J) | +1.97% | 5% | ✅ |
| Cook's membrane | loaded-edge deflection | 23.936 mm | converged plane-stress value | -0.10% | 1% | ✅ |
| Cook's membrane, nearly incompressible | top-corner deflection | 8.0474 mm | converged plane-strain value | -0.34% | 1% | ✅ |
| Cook's membrane, nearly incompressible, P1 (expected failure) | top-corner deflection | 4.5789 mm | converged plane-strain value | -43.30% | -43.30 ± 2% | ⚠️ as recorded |
| Tie patch test | largest von Mises stress | 100.00 MPa | σ (uniform) | +0.00% | 0.01% | ✅ |
| Tied thick-walled cylinder | bore radial displacement u(a) | 0.045620 mm | u(a), Lamé rings tied at r = c | -0.65% | 1% | ✅ |
| Tied cantilever beam | tip deflection δ | -1.9045 mm | −P/(3·E·I)·((L+g)³ − (L/2+g)³ + (L/2)³) | -0.46% | 1% | ✅ |
| NAFEMS LE1: elliptic membrane | tangential stress σyy at D | 94.226 MPa | NAFEMS LE1 target | +1.65% | 3% | ✅ |
| NAFEMS LE2: cylindrical shell patch | tangential stress at E, outer surface | 60.902 MPa | NAFEMS LE2 target, 6·m / t² | +1.50% | 3% | ✅ |
| NAFEMS LE3: hemisphere with point loads | radial displacement at A | 186.72 mm | NAFEMS LE3 target | +0.93% | 2% | ✅ |
| NAFEMS LE4: hyperbolic shell | meridional stress at K, mid-surface | -50.295 MPa | NAFEMS LE4 target | +0.59% | 3% | ✅ |
| NAFEMS LE5: Z-section cantilever | axial stress at A, mid-surface | -109.40 MPa | NAFEMS LE5 target | +1.30% | 3% | ✅ |
| NAFEMS LE6: skew plate | max principal stress at E, lower surface | 0.80820 MPa | NAFEMS LE6 target | +0.77% | 2% | ✅ |
| NAFEMS LE7: cylinder with hemispherical cap | axial stress at D, outer surface | 26.029 MPa | NAFEMS LE7 target | +0.50% | 3% | ✅ |
| NAFEMS LE8: axisymmetric shell under pressure | hoop stress at D, outer surface | 85.757 MPa | NAFEMS LE8 target | -9.25% | 10% | ✅ |
| NAFEMS LE10: thick plate under pressure | direct stress σyy at D | -5.3684 MPa | NAFEMS LE10 target | -0.22% | 2% | ✅ |
| NAFEMS LE11: solid cylinder/taper/sphere, temperature loading | direct stress σzz at A | -103.77 MPa | NAFEMS LE11 target | -1.17% | 3% | ✅ |
