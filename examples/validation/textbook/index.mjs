// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Textbook text for the case pages, /validation/<case id>/, keyed by case id.
// Each entry: description (meta), figure, intro, theory, model (extra notes on
// the finite element model), discussion and references. The functions receive
// the page context built in ../lib/page.mjs: the case's published row, its
// inputs, its convergence study and formatting helpers. Every number in the
// text is computed from those, never typed.

import axialBar from "./axial-bar.mjs";
import cantilever from "./cantilever.mjs";
import cantileverP2 from "./cantilever-p2.mjs";
import beamTorsion from "./beam-torsion.mjs";
import plateWithHole from "./plate-with-hole.mjs";
import shaftTorsion from "./shaft-torsion.mjs";
import cooksMembrane from "./cooks-membrane.mjs";
import surfaceTraction from "./surface-traction.mjs";
import surfacePressure from "./surface-pressure.mjs";

export default new Map([
  ["axial-bar", axialBar],
  ["cantilever", cantilever],
  ["cantilever-p2", cantileverP2],
  ["beam-torsion", beamTorsion],
  ["plate-with-hole", plateWithHole],
  ["shaft-torsion", shaftTorsion],
  ["cooks-membrane", cooksMembrane],
  ["surface-traction", surfaceTraction],
  ["surface-pressure", surfacePressure],
]);
