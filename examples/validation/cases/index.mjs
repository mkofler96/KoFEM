// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Registry of validation cases. Each default-exports a descriptor:
//   { id, name, quantity, unit, reference, referenceLabel, tolPct, readout,
//     page, model(), measure(model, result) }
// model() is the example as the app opens it (../lib/app-model.mjs), at
// /app/?example=<id>; measure() reads the finite-element value of `quantity`
// off its solve; `readout` names the Result-summary line the app shows for it
// (field and Min/Max). `page` holds the model description on /examples/ and
// the example's page /examples/<id>/ (see ../lib/page.mjs); `page.grid` is the
// structured mesh division the page draws. The textbook text for each page
// lives in ../textbook/.

import axialBar from "./axial-bar.mjs";
import cantilever from "./cantilever-bending.mjs";
import cantileverP2 from "./cantilever-bending-p2.mjs";
import beamTorsion from "./beam-torsion.mjs";
import plateWithHole from "./plate-with-hole.mjs";
import shaftTorsion from "./shaft-torsion.mjs";
import cooksMembrane from "./cooks-membrane.mjs";
import surfacePressure from "./surface-pressure.mjs";

export default [
  axialBar,
  surfacePressure,
  cantilever,
  cantileverP2,
  beamTorsion,
  plateWithHole,
  shaftTorsion,
  cooksMembrane,
];
