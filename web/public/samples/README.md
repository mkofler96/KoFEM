# Sample geometry

`wall-bracket.step` is the part the empty app offers under "Try a sample
simulation" (KOF-261). It opens as CAD geometry only. The guide
(`web/src/lib/sampleGuide.ts`) then takes the user through mesh, supports, load
and run, and highlights the faces to pick: the three Ø16 mm bolt holes (CAD
faces 34–36) and the Ø20 mm hub bore (face 37).

The guide refers to those faces by number. `web/tests/test_sample_guide.mjs`
meshes this file and checks that the numbers still point at the holes and the
bore, so replace the file only together with the face numbers.

It is a copy of `test_files/Wall Bracket.stp` (Autodesk Inventor 2016 export),
the part the tutorial figures and `test_wall_bracket.mjs` use.
