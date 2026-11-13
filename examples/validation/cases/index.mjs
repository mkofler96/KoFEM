// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Registry of validation cases. Each default-exports a descriptor:
//
//   { id, name, quantity, unit, tolPct, readout?, figure?, page, recipe }
//
//   recipe    how a user builds the example in the GUI from one STEP file
//             (../lib/recipe.mjs); run.mjs builds and solves it through
//             ../lib/pipeline.mjs. Its read-out gives the reference and the
//             reference label (readout.reference, readout.formula).
//   quantity  what the page calls the measured value, e.g. "tip extension δ";
//   unit      its unit — must equal recipe.readout.probe.unit;
//   tolPct    the tolerance band in percent of the reference;
//   readout   optional extra check: the Result-summary line the app shows for
//             the solved model ({ field: "Ux" | "Uy" | "Uz" | "|U|",
//             stat: "Min" | "Max" }), printed on the page;
//   figure    optional { field: "displacement" | "vonMises", unit, view,
//             deform, focus } for the page's result figure (lib/render.mjs);
//   page      the text on /examples/ and /examples/<id>/ (../lib/page.mjs):
//             { summary, model, inputs: [[symbol, value, unit]], supports,
//             loads, measured, source, note? }. The mesh line is written from
//             the solved mesh (Netgen max element size, element count).
//
// The page's longer text lives in ../textbook/<id>.mjs.

import axialBar from "./axial-bar.mjs";
import cantileverBeam from "./cantilever-beam.mjs";
import beamTorsion from "./beam-torsion.mjs";
import plateWithHole from "./plate-with-hole.mjs";
import plateWithHoleShell from "./plate-with-hole-shell.mjs";
import shaftTorsion from "./shaft-torsion.mjs";
import cooksMembrane from "./cooks-membrane.mjs";
import surfacePressure from "./surface-pressure.mjs";
import tiePatchTest from "./tie-patch-test.mjs";
import tieLameCylinder from "./tie-lame-cylinder.mjs";
import tieCantilever from "./tie-cantilever.mjs";
import { validateRecipe } from "../lib/recipe.mjs";

const CASE_KEYS = new Set([
  "id",
  "name",
  "quantity",
  "unit",
  "tolPct",
  "readout",
  "figure",
  "page",
  "recipe",
]);

// A case, checked and completed with what its recipe implies. Every example
// is built from its STEP file in the GUI's steps, so a case without a recipe
// is an error.
function register(c) {
  const at = `case "${c.id}"`;
  if (c.recipe === undefined)
    throw new Error(
      `${at} has no recipe: every example is built from its STEP file in the GUI's steps (../lib/recipe.mjs)`,
    );
  for (const key of Object.keys(c))
    if (!CASE_KEYS.has(key))
      throw new Error(
        `${at}: "${key}" does not belong in a case (the recipe defines the model, reference and read-out)`,
      );
  for (const key of ["id", "name", "quantity"])
    if (typeof c[key] !== "string" || !c[key])
      throw new Error(`${at}: ${key} must be a non-empty string`);
  if (!(c.tolPct > 0)) throw new Error(`${at}: tolPct must be positive`);
  validateRecipe(c.id, c.recipe);
  const ro = c.recipe.readout;
  if (c.unit !== ro.probe.unit)
    throw new Error(
      `${at}: unit "${c.unit}" differs from the recipe probe's unit "${ro.probe.unit}"`,
    );
  if (c.page.grid !== undefined || c.page.mesh !== undefined)
    throw new Error(
      `${at}: page.grid / page.mesh are not page fields; the mesh line comes from the case's Netgen mesh`,
    );
  return { ...c, reference: ro.reference, referenceLabel: ro.formula };
}

export default [
  axialBar,
  surfacePressure,
  cantileverBeam,
  beamTorsion,
  plateWithHole,
  plateWithHoleShell,
  shaftTorsion,
  cooksMembrane,
  tiePatchTest,
  tieLameCylinder,
  tieCantilever,
].map(register);
