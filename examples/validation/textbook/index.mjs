// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Page text for every example, /examples/<id>/, keyed by id. Each entry:
// description (meta), opens (optional: what Open in KoFEM opens, if not the
// model ready to run), figure (the sketch), intro, theory (optional, with an
// optional theoryTitle), model (notes on the finite element model), results
// (optional; replaces the default results table), discussion and references.
// The functions receive the page context built in ../lib/page.mjs: the
// example's published row or record, its inputs, its convergence study and
// formatting helpers. Every number in the text is computed from those, never
// typed.

import axialBar from "./axial-bar.mjs";
import beamTorsion from "./beam-torsion.mjs";
import plateWithHole from "./plate-with-hole.mjs";
import shaftTorsion from "./shaft-torsion.mjs";
import cooksMembrane from "./cooks-membrane.mjs";
import cantileverBeam from "./cantilever-beam.mjs";
import plateWithHoleShell from "./plate-with-hole-shell.mjs";
import mbbBeamTopopt from "./mbb-beam-topopt.mjs";
import surfacePressure from "./surface-pressure.mjs";
import tiePatchTest from "./tie-patch-test.mjs";
import tieLameCylinder from "./tie-lame-cylinder.mjs";
import tieCantilever from "./tie-cantilever.mjs";

export default new Map([
  ["axial-bar", axialBar],
  ["beam-torsion", beamTorsion],
  ["plate-with-hole", plateWithHole],
  ["shaft-torsion", shaftTorsion],
  ["cooks-membrane", cooksMembrane],
  ["cantilever-beam", cantileverBeam],
  ["plate-with-hole-shell", plateWithHoleShell],
  ["mbb-beam-topopt", mbbBeamTopopt],
  ["surface-pressure", surfacePressure],
  ["tie-patch-test", tiePatchTest],
  ["tie-lame-cylinder", tieLameCylinder],
  ["tie-cantilever", tieCantilever],
]);
