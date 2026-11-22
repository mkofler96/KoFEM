// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Builds the benchmark models once and writes each as the app's solve payload
// (nodes, elements, material, supports, loads), so every solver in the study
// solves exactly the same model: same mesh, same supports, same loads.
//
// The three scientific benchmarks are the validation cases (examples/
// validation/cases), meshed through their recipes at the levels of their
// convergence studies. The real-world model is the app's guided sample, the
// wall bracket (web/src/lib/sampleGuide.ts): bolt holes fixed, 2 kN down on
// the hub bore, steel, at several mesh sizes.
//
// Usage (from web/): bun ../benchmarks/solver-speed/export-models.mjs <out-dir> [model-id]

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import cases from "../../examples/validation/cases/index.mjs";
import studies from "../../examples/validation/convergence.mjs";
import {
  buildFromRecipe,
  freshEngine,
  withMesh,
} from "../../examples/validation/lib/pipeline.mjs";
import {
  APP_STEEL,
  DEFLECTION_RELATIVE,
} from "../../examples/validation/lib/recipe.mjs";
import { SAMPLE } from "../../web/src/lib/sampleGuide.ts";
import { MODELS } from "./models.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const out = process.argv[2];
if (!out) throw new Error("usage: export-models.mjs <out-dir>");
mkdirSync(out, { recursive: true });

// A point well inside a CAD face of the display tessellation: the centroid of
// the face's largest triangle. The recipe resolves it back to the face and
// throws unless exactly one face lies within the chordal tolerance.
function pointOnFace(tess, faceId) {
  let best = null;
  let bestArea = -1;
  tess.triangles.forEach(([a, b, c], t) => {
    if (tess.faceIds[t] !== faceId) return;
    const [p, q, r] = [a, b, c].map((i) => tess.points[i]);
    const u = q.map((v, k) => v - p[k]);
    const w = r.map((v, k) => v - p[k]);
    const n = [
      u[1] * w[2] - u[2] * w[1],
      u[2] * w[0] - u[0] * w[2],
      u[0] * w[1] - u[1] * w[0],
    ];
    const area = Math.hypot(...n) / 2;
    if (area > bestArea) {
      bestArea = area;
      best = [0, 1, 2].map((k) => (p[k] + q[k] + r[k]) / 3);
    }
  });
  if (!best) throw new Error(`wall bracket: no triangle on CAD face ${faceId}`);
  return best;
}

function wallBracketRecipe(maxElementSize, order) {
  const stepText = readFileSync(
    join(here, "../../web/public", SAMPLE.url),
    "utf8",
  );
  return {
    stepText,
    recipe: (tess) => ({
      step: () => stepText,
      splits: [],
      discretization: { kind: "solid" },
      mesh: { maxElementSize, order },
      material: APP_STEEL,
      supports: [
        {
          name: "Bolt holes",
          faces: SAMPLE.boltHoleFaces.map((f) => ({
            at: pointOnFace(tess, f),
          })),
          dofs: [0, 1, 2],
          value: 0,
        },
      ],
      loads: [
        {
          name: "Shaft load",
          kind: "force",
          faces: SAMPLE.hubBoreFaces.map((f) => ({ at: pointOnFace(tess, f) })),
          components: [0, SAMPLE.loadFy, 0],
        },
      ],
      readout: {
        quantity: "Hub displacement",
        probe: {
          kind: "displacement",
          component: 1,
          faces: SAMPLE.hubBoreFaces.map((f) => ({ at: pointOnFace(tess, f) })),
          unit: "mm",
        },
        formula: "none (no closed-form reference)",
        reference: -1,
      },
    }),
  };
}

async function wallBracketTessellation(stepText) {
  const engine = await freshEngine();
  const t = engine.tessellate_step(
    new TextEncoder().encode(stepText),
    JSON.stringify({
      deflection_relative: DEFLECTION_RELATIVE,
      angular_deflection: 0.5,
      format: "step",
    }),
  );
  const chunk = (a) =>
    Array.from({ length: a.length / 3 }, (_, i) => [
      a[3 * i],
      a[3 * i + 1],
      a[3 * i + 2],
    ]);
  return {
    points: chunk(Array.from(t.vertices)),
    triangles: chunk(Array.from(t.triangles)),
    faceIds: Array.from(t.triangleFaceIds),
  };
}

function write(model, order, size, build) {
  const payload = build.solvePayload;
  const file = join(out, `${model}_p${order}_h${size}.json`);
  writeFileSync(
    file,
    JSON.stringify({
      model,
      order,
      maxElementSize: size,
      nodes: payload.nodes.length,
      elements: payload.elements.length,
      payload,
    }),
  );
  console.log(
    `${model.padEnd(16)} P${order} h=${String(size).padEnd(5)} ` +
      `${payload.elements.length} tets → ${file}`,
  );
}

const only = process.argv[3];
for (const m of MODELS.filter((x) => !only || x.id === only)) {
  if (m.kind === "case") {
    const c = cases.find((x) => x.id === m.id);
    if (!c) throw new Error(`no validation case "${m.id}"`);
    const study = studies.find((s) => s.caseId === m.id);
    if (!study) throw new Error(`no convergence study for "${m.id}"`);
    for (const s of study.series)
      for (const h of s.levels) {
        const build = await buildFromRecipe(
          m.id,
          withMesh(c.recipe, { maxElementSize: h, order: s.order }),
        );
        write(m.id, s.order, h, build);
      }
  } else {
    const { stepText, recipe } = wallBracketRecipe(0, 1);
    const tess = await wallBracketTessellation(stepText);
    for (const [order, sizes] of Object.entries(m.levels))
      for (const h of sizes) {
        const r = recipe(tess);
        const build = await buildFromRecipe(
          m.id,
          withMesh(r, { maxElementSize: h, order: Number(order) }),
        );
        write(m.id, Number(order), h, build);
      }
  }
}
