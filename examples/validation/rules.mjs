// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// The rules every example on /examples/ meets (KOF-322: every example can be
// rebuilt from scratch in the KoFEM GUI alone):
//
//   recipe     it is a validation case with a recipe (lib/recipe.mjs), so the
//              build and the GUI test follow the same steps;
//   step       examples/gallery/site/<id>.step exists — the file a user imports;
//   model step <id>.model.step exists — the geometry the app re-meshes an
//              opened example from: the import after the recipe's splits
//              (lib/model-step.mjs; run.mjs checks it against the build);
//   geometry   its analysis file carries the imported geometry (stepSurface)
//              and the CAD face of every boundary triangle (surfaceFaceIds),
//              so the opened example shows its body, can be re-meshed and
//              changed — not just a mesh;
//   no hexes   its analysis file holds no hexahedra (Netgen meshes tetrahedra);
//   CAD faces  every support and load face entry is a whole CAD face
//              (cadFaceId), so it survives a re-mesh as in the app;
//   handCheck  its analysis file carries a hand check in the probe shape the
//              Results panel reads ({ quantity, formula, reference, unit,
//              probe: { kind, … }, assumes }).
//
//   bun examples/validation/rules.mjs
//
// Exits non-zero on any violation. PENDING lists the examples not yet rebuilt
// this way; it may only shrink: an example on it that already meets every rule
// is an error too, so it has to come off the list when it is converted.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ORDER, SITE_DIR } from "./catalog.mjs";
import cases from "./cases/index.mjs";
import { readAnalysisSetup } from "./lib/app-model.mjs";
import { modelStepPath, sameModelStep } from "./lib/model-step.mjs";

// KOF-322: examples still built the old way. This list must be empty when
// KOF-322 is done; then delete it and the PENDING handling below.
const PENDING = [
  "cooks-membrane",
  "mbb-beam-topopt",
];

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
  if (!c?.recipe)
    out.push(
      c
        ? "is a case without a recipe"
        : "is not a validation case with a recipe",
    );
  const step = join(SITE_DIR, `${id}.step`);
  if (!existsSync(step)) out.push(`has no ${id}.step`);
  else if (!readFileSync(step, "utf8").startsWith("ISO-10303-21"))
    out.push(`${id}.step is not a STEP file`);
  const model = modelStepPath(SITE_DIR, id);
  if (!existsSync(model)) out.push(`has no ${id}.model.step`);
  else if (!readFileSync(model, "utf8").startsWith("ISO-10303-21"))
    out.push(`${id}.model.step is not a STEP file`);
  else if (
    c?.recipe &&
    c.recipe.splits.length === 0 &&
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
  const entries = [
    ...setup.bcGroups.map((g) => ["support", g]),
    ...setup.loadGroups.map((g) => ["load", g]),
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
  if (!hc) out.push(`${id}.vtu has no handCheck`);
  else {
    const missing = ["quantity", "formula", "unit"].filter(
      (key) => typeof hc[key] !== "string",
    );
    if (!Number.isFinite(hc.reference)) missing.push("reference");
    if (typeof hc.probe?.kind !== "string") missing.push("probe.kind");
    if (!hc.assumes) missing.push("assumes");
    if (missing.length)
      out.push(
        `${id}.vtu: handCheck is not in the probe shape (lacks ${missing.join(", ")})`,
      );
  }
  return out;
}

const problems = [];
for (const id of PENDING)
  if (!ORDER.includes(id))
    problems.push(`PENDING names "${id}", which is not an example — remove it`);
for (const id of ORDER) {
  const broken = violations(id);
  if (PENDING.includes(id)) {
    if (!broken.length)
      problems.push(
        `${id} meets every rule — take it off PENDING in examples/validation/rules.mjs`,
      );
  } else for (const message of broken) problems.push(`${id}: ${message}`);
}

const done = ORDER.length - PENDING.length;
if (problems.length) {
  console.error(
    `Example rules (KOF-322) — ${problems.length} problem(s):\n` +
      problems.map((p) => `  • ${p}`).join("\n"),
  );
  process.exit(1);
}
console.log(
  `Example rules (KOF-322): ${done}/${ORDER.length} examples rebuilt from a STEP file in the GUI's steps; ${PENDING.length} pending (${PENDING.join(", ")}).`,
);
