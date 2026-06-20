// Registry of validation cases. Each default-exports a descriptor:
//   { name, quantity, unit, reference, referenceLabel, tolPct, run(solve) }
// run(solve) returns the finite-element value for `quantity`.

import axialBar from "./axial-bar.mjs";
import cantilever from "./cantilever-bending.mjs";
import plateWithHole from "./plate-with-hole.mjs";
import shaftTorsion from "./shaft-torsion.mjs";
import cooksMembrane from "./cooks-membrane.mjs";

export default [
  axialBar,
  cantilever,
  plateWithHole,
  shaftTorsion,
  cooksMembrane,
];
