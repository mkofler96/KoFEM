# Wall bracket: error against solve time

Reference: the finest quadratic mesh (P2 h=3, 265488 DOF), largest displacement 0.0369868 mm. The refinement is not uniform, so no rate is fitted. Times are medians of the timed rounds. An error against a reference that is only a little finer is an underestimate: read the quadratic meshes closest to the reference as "below about 1 %", not as their figure.

| Mesh     |    DOF | Largest displacement (mm) |     Error | C++/MFEM, Gauss–Seidel (v0.6) | Rust, AMG (v0.7) |
| -------- | -----: | ------------------------: | --------: | ----------------------------: | ---------------: |
| P1 h=40  |   7149 |                 0.0257631 |    30.3 % |                        0.32 s |           0.14 s |
| P1 h=20  |  24498 |                 0.0291488 |    21.2 % |                        1.87 s |           0.77 s |
| P1 h=3   |  39789 |                 0.0313875 |    15.1 % |                        3.92 s |           1.29 s |
| P1 h=2.5 |  56478 |                 0.0330782 |    10.6 % |                        6.55 s |           2.02 s |
| P1 h=2   |  97890 |                 0.0343279 |     7.2 % |                       18.20 s |           4.04 s |
| P2 h=40  |  45402 |                 0.0352901 |     4.6 % |                        8.73 s |           2.52 s |
| P2 h=20  | 167517 |                 0.0368397 |     0.4 % |                      101.82 s |          11.36 s |
| P2 h=3   | 265488 |                 0.0369868 | reference |                             — |          16.53 s |
