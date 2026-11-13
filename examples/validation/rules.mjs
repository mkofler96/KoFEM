// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// The rules every example on /examples/ meets (KOF-322: every example can be
// rebuilt from scratch in the KoFEM GUI alone):
//
//   recipe     it is a validation case with a recipe (lib/recipe.mjs), or a
//              showcase with one (examples/gallery/recipes/), so the build and
//              the GUI test follow the same steps;
//   step       examples/gallery/site/<id>.step exists and is the recipe's STEP
//              — the file a user imports;
//   model step <id>.model.step exists — the geometry the app re-meshes an
//              opened example from: the import after the recipe's splits
//              (lib/model-step.mjs; run.mjs checks it against the build);
//   geometry   its analysis file carries the imported geometry (stepSurface)
//              and the CAD face of every boundary triangle (surfaceFaceIds),
//              so the opened example shows its body, can be re-meshed and
//              changed — not just a mesh;
//   no hexes   its analysis file holds no hexahedra (Netgen meshes tetrahedra);
//   CAD faces  every support, load and tie face entry is a whole CAD face
//              (cadFaceId), so it survives a re-mesh as in the app;
//   handCheck  its analysis file carries a hand check in the probe shape the
//              Results panel reads ({ quantity, formula, reference, unit,
//              probe: { kind, … }, assumes }), whose assumptions name the
//              material's E and ν (assumes.young, assumes.poisson), so editing
//              either withholds the check. A topology optimisation (a
//              recipe with `optimize`) has no closed form: its read-out is the
//              final compliance the Results panel shows after the run, so its
//              analysis file instead opens on the Optimize step with the
//              recipe's settings, and its record publishes that value (fe).
//
//   bun examples/validation/rules.mjs
//
// Exits non-zero on any violation, naming the example and the rule.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  ORDER,
  SHOWCASE_IDS,
  SITE_DIR,
  showcaseRecipe,
  showcaseRecord,
} from "./catalog.mjs";
import cases from "./cases/index.mjs";
import { readAnalysisSetup } from "./lib/app-model.mjs";
import { modelStepPath, sameModelStep } from "./lib/model-step.mjs";

const VTK_HEXAHEDRON = 12;
const VTK_QUADRATIC_HEXAHEDRON = 25;

/**
 * The CAD faces of the geometry an analysis file carries, or null (with the
 * problem pushed onto `out`) when the file has no usable geometry: then the app
 * cannot show the body, re-mesh it or change it.
 */
function geometryFaceIds(id, setup, out) {
  const surface = setup.stepSurface;
  if (!surface) {
    out.push(`${id}.vtu carries no geometry (stepSurface)`);
    return null;
  }
  const { points, triangles, faceIds } = surface;
  if (
    !Array.isArray(points) ||
    !Array.isArray(triangles) ||
    !Array.isArray(faceIds) ||
    points.length === 0 ||
    triangles.length === 0 ||
    faceIds.length !== triangles.length
  ) {
    out.push(
      `${id}.vtu: stepSurface needs points, triangles and one face id per triangle`,
    );
    return null;
  }
  const faces = new Set(faceIds);
  const meshTris = setup.surfaceTriangles;
  const meshFaces = setup.surfaceFaceIds;
  if (
    !Array.isArray(meshTris) ||
    !Array.isArray(meshFaces) ||
    meshFaces.length !== meshTris.length ||
    meshFaces.length === 0
  )
    out.push(
      `${id}.vtu: the mesh's boundary triangles need their CAD faces (surfaceTriangles, surfaceFaceIds)`,
    );
  else {
    const stray = [...new Set(meshFaces)].filter((f) => !faces.has(f));
    if (stray.length)
      out.push(
        `${id}.vtu: mesh boundary faces [${stray.join(", ")}] are not faces of its geometry`,
      );
  }
  return faces;
}

/** The rules `id` breaks, as messages (empty: it meets them all). */
function violations(id) {
  const out = [];
  const c = cases.find((x) => x.id === id);
  const recipe = c ? c.recipe : showcaseRecipe(id);
  if (!recipe)
    out.push(
      c
        ? "is a case without a recipe"
        : "is a showcase without a recipe (examples/gallery/recipes/)",
    );
  const step = join(SITE_DIR, `${id}.step`);
  if (!existsSync(step)) out.push(`has no ${id}.step`);
  else {
    const text = readFileSync(step, "utf8");
    if (!text.startsWith("ISO-10303-21"))
      out.push(`${id}.step is not a STEP file`);
    else if (recipe && text !== recipe.step())
      out.push(`${id}.step is not the STEP file its recipe imports`);
  }
  const model = modelStepPath(SITE_DIR, id);
  if (!existsSync(model)) out.push(`has no ${id}.model.step`);
  else if (!readFileSync(model, "utf8").startsWith("ISO-10303-21"))
    out.push(`${id}.model.step is not a STEP file`);
  else if (
    recipe &&
    recipe.splits.length === 0 &&
    existsSync(step) &&
    !sameModelStep(model, readFileSync(step))
  )
    out.push(
      `${id}.model.step is not ${id}.step, though the recipe has no splits`,
    );
  const vtuFile = join(SITE_DIR, `${id}.vtu`);
  if (!existsSync(vtuFile)) {
    out.push(`has no ${id}.vtu`);
    return out;
  }
  const vtu = readFileSync(vtuFile, "utf8");
  const setup = readAnalysisSetup(vtu);
  const types = /<DataArray[^>]*Name="types"[^>]*>([^<]*)<\/DataArray>/.exec(
    vtu,
  );
  if (!types) out.push(`${id}.vtu has no cell types`);
  else if (
    types[1]
      .trim()
      .split(/\s+/)
      .some(
        (t) =>
          Number(t) === VTK_HEXAHEDRON ||
          Number(t) === VTK_QUADRATIC_HEXAHEDRON,
      )
  )
    out.push(`${id}.vtu has hexahedral cells`);
  if (setup.elementTypes.some((t) => t === "CHEXA"))
    out.push(`${id}.vtu lists CHEXA elements`);
  const geometryFaces = geometryFaceIds(id, setup, out);
  // A tie's two surfaces are face picks like a support's.
  const ties = (setup.tieGroups ?? []).flatMap((g) => [
    ["tie", { name: `${g.name} A`, faces: g.facesA }],
    ["tie", { name: `${g.name} B`, faces: g.facesB }],
  ]);
  const entries = [
    ...setup.bcGroups.map((g) => ["support", g]),
    ...setup.loadGroups.map((g) => ["load", g]),
    ...ties,
  ];
  for (const [kind, group] of entries)
    for (const face of group.faces)
      if (!Number.isInteger(face.cadFaceId))
        out.push(
          `${kind} "${group.name}", ${face.label}: not a whole CAD face (no cadFaceId)`,
        );
      else if (geometryFaces && !geometryFaces.has(face.cadFaceId))
        out.push(
          `${kind} "${group.name}", ${face.label}: CAD face ${face.cadFaceId} is not in the example's geometry`,
        );
  const hc = setup.handCheck;
  if (recipe?.optimize) out.push(...optimizationViolations(id, recipe, setup));
  else if (!hc) out.push(`${id}.vtu has no handCheck`);
  else {
    const missing = ["quantity", "formula", "unit"].filter(
      (key) => typeof hc[key] !== "string",
    );
    if (!Number.isFinite(hc.reference)) missing.push("reference");
    if (typeof hc.probe?.kind !== "string") missing.push("probe.kind");
    if (!hc.assumes) missing.push("assumes");
    else
      for (const key of ["young", "poisson"])
        if (!Number.isFinite(hc.assumes[key])) missing.push(`assumes.${key}`);
    if (missing.length)
      out.push(
        `${id}.vtu: handCheck is not in the probe shape (lacks ${missing.join(", ")})`,
      );
  }
  return out;
}

// A topology optimisation's read-out is the Results panel's final compliance
// after the run: the analysis file opens on the Optimize step with the
// recipe's settings, as a user types them, and the published record carries
// the run's final compliance.
function optimizationViolations(id, recipe, setup) {
  const out = [];
  const o = recipe.optimize;
  if (setup.handCheck !== undefined)
    out.push(`${id}.vtu: an optimisation carries no handCheck`);
  if (setup.mode !== "optimize")
    out.push(`${id}.vtu opens in "${setup.mode}", not on the Optimize step`);
  const expected = {
    method: "simp",
    objective: o.objective,
    volumeFraction: String(o.volumeFraction),
    penalty: String(o.penalty),
    filterRadius: String(o.filterRadius),
    moveLimit: String(o.moveLimit),
    maxIterations: String(o.maxIterations),
    tolerance: String(o.tolerance),
  };
  for (const [key, value] of Object.entries(expected))
    if (setup.topOpt?.[key] !== value)
      out.push(
        `${id}.vtu: topOpt.${key} is ${JSON.stringify(setup.topOpt?.[key])}, the recipe says ${JSON.stringify(value)}`,
      );
  if (!SHOWCASE_IDS.includes(id))
    out.push("an optimisation is published as a showcase record");
  else {
    const record = showcaseRecord(id);
    const last = record.history?.at(-1)?.objective;
    if (!Number.isFinite(record.fe))
      out.push(`showcase/${id}.json publishes no final compliance (fe)`);
    else if (record.fe !== last)
      out.push(
        `showcase/${id}.json: fe ${record.fe} is not the last iteration's compliance ${last}`,
      );
  }
  return out;
}

const problems = [];
for (const id of ORDER)
  for (const message of violations(id)) problems.push(`${id}: ${message}`);

if (problems.length) {
  console.error(
    `Example rules (KOF-322) — ${problems.length} problem(s):\n` +
      problems.map((p) => `  • ${p}`).join("\n"),
  );
  process.exit(1);
}
console.log(
  `Example rules: all ${ORDER.length} examples are rebuilt from a STEP file in the GUI's steps.`,
);
