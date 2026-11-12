// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Every example can be rebuilt from scratch in the GUI alone (KOF-322). For each
// example on /examples/ that has a recipe, this walks the recipe's steps with
// real clicks (fixtures/recipe.ts) — import the STEP file, split, mesh, material,
// supports, loads, solve — and checks that:
//
//   - the geometry has the faces and bodies the splits should give;
//   - every support and load sits on whole CAD faces, the ones the recipe names;
//   - the mesh has no hexahedra, and is the very mesh the node-side build makes;
//   - the read-out, computed from the solved model by the recipe's probe, is the
//     number the example publishes.
//
// A model built by clicks carries no hand check (that comes only with an
// example file), so the read-out is computed here from the solved state. If the
// Results panel shows one, it must agree. A topology optimization (a recipe with
// an optimize step) runs the optimizer instead of the static solve and is read
// out where the Results panel shows it: the run summary's final compliance.
//
// The driver self-tests at the end are not examples: they prove each load kind
// and a split against closed-form results.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { test, expect } from "./coverage";
import type { Page } from "@playwright/test";
import {
  asRecipe,
  buildByHand,
  compareWithNodeMesh,
  groupFaces,
  probeValue,
  readFinalCompliance,
  recipeFaceIds,
  snapshot,
  type BuildReport,
  type Recipe,
} from "./fixtures/recipe";
import { DRIVER_RECIPES, SHOWCASE_RECIPES } from "./fixtures/local-recipes";
import {
  ORDER,
  SHOWCASE_IDS,
  showcaseRecipe,
  showcaseRecord,
} from "../../examples/validation/catalog.mjs";
import cases from "../../examples/validation/cases/index.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const RESULTS = join(here, "../public/examples/results.json");

// The published FE value: a case's row in results.json, or a showcase's record.
function publishedFe(id: string): number {
  let fe: unknown;
  if ((SHOWCASE_IDS as string[]).includes(id))
    fe = (showcaseRecord(id) as { fe?: unknown }).fe;
  else {
    const rows = (
      JSON.parse(readFileSync(RESULTS, "utf8")) as {
        cases: { id: string; fe?: unknown }[];
      }
    ).cases;
    const row = rows.find((r) => r.id === id);
    if (!row) throw new Error(`${RESULTS} has no row for case "${id}"`);
    fe = row.fe;
  }
  if (typeof fe !== "number" || !Number.isFinite(fe))
    throw new Error(
      `the published FE value of "${id}" is ${JSON.stringify(fe)}`,
    );
  return fe;
}

// An example's recipe: exported by its case module or, for a showcase, by
// examples/gallery/recipes/, else carried locally for a showcase whose generator
// has none yet; null when there is none.
function recipeFor(id: string): Recipe | null {
  const mod = (cases as { id: string; recipe?: unknown }[]).find(
    (c) => c.id === id,
  );
  if (mod?.recipe !== undefined) return asRecipe(id, mod.recipe);
  const showcase: unknown = showcaseRecipe(id);
  if (showcase !== undefined) return asRecipe(id, showcase);
  if (id in SHOWCASE_RECIPES) return asRecipe(id, SHOWCASE_RECIPES[id]);
  return null;
}

// Geometry, mesh and boundary conditions as the recipe should have made them.
async function checkBuild(
  page: Page,
  recipe: Recipe,
  report: BuildReport,
): Promise<void> {
  // Each split adds what it should: a cut face becomes two, a cut body two.
  const { counts } = report;
  expect(counts[0].faces).toBeGreaterThan(0);
  expect(counts[0].edits).toBe(0);
  recipe.splits.forEach((split, i) => {
    const [prev, next] = [counts[i], counts[i + 1]];
    expect(next.edits, `split ${i + 1} is an edit`).toBe(i + 1);
    if (split.mode === "faces")
      expect(
        next,
        `split ${i + 1} cuts ${split.faces?.length} face(s)`,
      ).toEqual({
        faces: prev.faces + (split.faces?.length as number),
        bodies: prev.bodies,
        edits: i + 1,
      });
    else
      expect(next.bodies, `split ${i + 1} cuts a body`).toBe(prev.bodies + 1);
  });

  const snap = await snapshot(page);
  // Tetrahedra (and shell triangles), never hexahedra.
  const types = new Set(snap.elements.map((e) => e.type));
  expect(types.has("CHEXA")).toBe(false);
  if (recipe.discretization.kind === "solid")
    expect([...types]).toEqual(["CTETRA"]);
  else expect(types.has("CTRIA3")).toBe(true);
  expect(snap.elementOrder).toBe(recipe.mesh.order);

  // Every support and load: on whole CAD faces — the ones the recipe names.
  expect(snap.bcGroups).toHaveLength(recipe.supports.length);
  recipe.supports.forEach((support, i) => {
    const group = snap.bcGroups[i];
    expect(group.dofs, `support "${support.name}" DOFs`).toEqual(support.dofs);
    expect(group.value).toBe(support.value);
    const faces = groupFaces(snap, group.faces);
    expect(faces.map((f) => f.cadFaceId)).toEqual(
      recipeFaceIds(snap, support.faces),
    );
    for (const face of faces) expect(face.onMesh).toBe(true);
  });
  expect(snap.loadGroups).toHaveLength(recipe.loads.length);
  recipe.loads.forEach((load, i) => {
    const group = snap.loadGroups[i];
    expect(group.kind, `load "${load.name}" kind`).toBe(load.kind);
    if (load.kind === "pressure") expect(group.totalForce).toBe(load.value);
    else if (load.kind === "force")
      expect(group.components).toEqual(load.components);
    else {
      const vec = [0, 0, 0];
      vec[load.axis as number] = load.value as number;
      expect(group.components).toEqual(vec);
    }
    const faces = groupFaces(snap, group.faces);
    expect(faces.map((f) => f.cadFaceId)).toEqual(
      recipeFaceIds(snap, load.faces),
    );
    for (const face of faces) expect(face.onMesh).toBe(true);
  });
}

// Build, check, read out. Returns the read-out.
async function rebuild(
  page: Page,
  label: string,
  recipe: Recipe,
): Promise<number> {
  const start = Date.now();
  const report = await buildByHand(page, recipe);
  await checkBuild(page, recipe, report);
  const value =
    recipe.optimize === undefined
      ? probeValue(await snapshot(page), recipe.readout.probe)
      : await readFinalCompliance(page);

  // Should the Results panel show a hand check, it reads the same number.
  const handCheck = page.getByTestId("hand-check-fe");
  if ((await handCheck.count()) > 0) {
    const shown = Number(await handCheck.getAttribute("data-value"));
    expect(Math.abs(shown - value)).toBeLessThanOrEqual(1e-9 * Math.abs(value));
  }

  // The node-side build meshes the same STEP bytes with the same options; Netgen
  // is deterministic for a given engine, so the meshes must be identical.
  if (recipe.discretization.kind === "solid") {
    const mesh = await compareWithNodeMesh(page, recipe.mesh);
    console.log(
      `[examples-by-hand] ${label} mesh vs node-side: ${JSON.stringify(mesh)}`,
    );
    expect
      .soft(mesh.identical, "GUI mesh equals the node-side Netgen mesh")
      .toBe(true);
  }
  const stages = Object.entries(report.seconds)
    .map(([stage, s]) => `${stage} ${s.toFixed(1)} s`)
    .join(", ");
  console.log(
    `[examples-by-hand] ${label}: ${recipe.readout.quantity} = ${value} ${recipe.readout.probe.unit} ` +
      `in ${((Date.now() - start) / 1000).toFixed(1)} s (${stages})`,
  );
  return value;
}

// ── The examples, in page order ───────────────────────────────────────────────

const missing: string[] = [];
for (const id of ORDER as string[]) {
  const recipe = recipeFor(id);
  if (!recipe) {
    missing.push(id);
    test.fixme(`${id}: no recipe yet (KOF-322)`, () => {});
    continue;
  }
  test(`${id} rebuilt by hand gives the published number`, async ({ page }) => {
    test.setTimeout(600_000);
    const published = publishedFe(id);
    const value = await rebuild(page, id, recipe);
    console.log(`[examples-by-hand] ${id}: published ${published}`);
    expect(
      Math.abs(value - published),
      `${id}: by hand ${value}, published ${published}`,
    ).toBeLessThanOrEqual(1e-3 * Math.abs(published));
  });
}
if (missing.length > 0)
  console.log(
    `[examples-by-hand] no recipe yet (KOF-322): ${missing.join(", ")}`,
  );

// ── Driver self-tests: each load kind, and a split ───────────────────────────

test.describe("recipe driver", () => {
  for (const [name, { recipe, tolPct }] of Object.entries(DRIVER_RECIPES)) {
    test(`${name}: built by hand, matches its closed form`, async ({
      page,
    }) => {
      test.setTimeout(300_000);
      const value = await rebuild(page, name, recipe);
      const { reference } = recipe.readout;
      expect(
        Math.abs((value - reference) / reference) * 100,
        `${name}: ${value} vs ${reference}`,
      ).toBeLessThanOrEqual(tolPct);
    });
  }
});
