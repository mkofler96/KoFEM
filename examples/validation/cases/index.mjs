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
//
// KOF-322: legacy hex path, removed when all cases are recipes. A case without
// a recipe instead carries { reference, referenceLabel, model(), measure() }
// and page.mesh / page.grid: model() is the structured hex model the app opens
// (../lib/app-model.mjs), measure() reads the value off its solve.

import axialBar from "./axial-bar.mjs";
import cantilever from "./cantilever-bending.mjs";
import cantileverP2 from "./cantilever-bending-p2.mjs";
import cantileverBeam from "./cantilever-beam.mjs";
import beamTorsion from "./beam-torsion.mjs";
import plateWithHole from "./plate-with-hole.mjs";
import plateWithHoleShell from "./plate-with-hole-shell.mjs";
import shaftTorsion from "./shaft-torsion.mjs";
import cooksMembrane from "./cooks-membrane.mjs";
import surfacePressure from "./surface-pressure.mjs";
import { validateRecipe } from "../lib/recipe.mjs";

const RECIPE_CASE_KEYS = new Set([
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

// A recipe case, checked and completed with what its recipe implies; a legacy
// case as it is.
function register(c) {
  if (!c.recipe) return c; // KOF-322: legacy hex path, removed when all cases are recipes
  const at = `case "${c.id}"`;
  for (const key of Object.keys(c))
    if (!RECIPE_CASE_KEYS.has(key))
      throw new Error(
        `${at}: "${key}" does not belong in a recipe case (the recipe defines the model, reference and read-out)`,
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
      `${at}: page.grid / page.mesh describe a hand-made mesh; a recipe case's mesh line comes from its Netgen mesh`,
    );
  return { ...c, reference: ro.reference, referenceLabel: ro.formula };
}

export default [
  axialBar,
  surfacePressure,
  cantilever,
  cantileverP2,
  cantileverBeam,
  beamTorsion,
  plateWithHole,
  plateWithHoleShell,
  shaftTorsion,
  cooksMembrane,
].map(register);
