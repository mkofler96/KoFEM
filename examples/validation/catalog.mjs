// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// The examples on /examples/, in the order the page lists them. Two kinds:
//
//   case      a validation case (./cases/): run.mjs solves it on every CI run
//             and writes its analysis file, figure and published row;
//   showcase  a model without a closed-form answer (the topology
//             optimization), built from its recipe in
//             examples/gallery/recipes/ by its generator in examples/gallery/,
//             which writes its analysis file, figure and a record in
//             examples/gallery/showcase/<id>.json.
//
// Both are built from one STEP file in the GUI's steps (lib/recipe.mjs).
// Every example is opened by /app/?example=<id> from examples/gallery/site/,
// and has a page /examples/<id>/ with text from ./textbook/<id>.mjs.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import cases from "./cases/index.mjs";
import { engineId, femModuleId } from "./lib/provenance.mjs";
import showcaseRecipes from "../gallery/recipes/index.mjs";

const here = dirname(fileURLToPath(import.meta.url));
export const SITE_DIR = join(here, "../gallery/site");
export const SHOWCASE_DIR = join(here, "../gallery/showcase");

// The validation cases in groups, so the contents and /examples/ list them
// under a heading each. `namePrefix` is what every name in the group starts
// with; the contents leave it out under the group's heading, which says it.
export const GROUPS = [
  {
    id: "analytical",
    name: "Analytical solutions",
    ids: [
      "axial-bar",
      "surface-pressure",
      "cantilever-beam",
      "beam-torsion",
      "shaft-torsion",
      "plate-with-hole",
      "plate-with-hole-shell",
    ],
  },
  {
    id: "cook",
    name: "Cook's membrane",
    ids: ["cooks-membrane", "cooks-membrane-incompressible"],
  },
  {
    id: "ties",
    name: "Tied meshes",
    ids: ["tie-patch-test", "tie-lame-cylinder", "tie-cantilever"],
  },
  {
    id: "nafems",
    name: "NAFEMS benchmarks",
    namePrefix: "NAFEMS ",
    ids: [
      "nafems-le1",
      "nafems-le2",
      "nafems-le3",
      "nafems-le4",
      "nafems-le5",
      "nafems-le6",
      "nafems-le7",
      "nafems-le8",
      "nafems-le10",
      "nafems-le11",
    ],
  },
];

export const ORDER = [...GROUPS.flatMap((g) => g.ids), "mbb-beam-topopt"];

const caseIds = new Set(cases.map((c) => c.id));
export const SHOWCASE_IDS = ORDER.filter((id) => !caseIds.has(id));

const groupOf = new Map(GROUPS.flatMap((g) => g.ids.map((id) => [id, g])));
if (groupOf.size !== GROUPS.reduce((n, g) => n + g.ids.length, 0))
  throw new Error("an example is listed in more than one group");
for (const c of cases) {
  const group = groupOf.get(c.id);
  if (!group) throw new Error(`case "${c.id}" is in no group`);
  if (group.namePrefix && !c.name.startsWith(group.namePrefix))
    throw new Error(
      `case "${c.id}" is in group "${group.id}", so its name must start with "${group.namePrefix}"`,
    );
}
for (const id of groupOf.keys())
  if (!caseIds.has(id))
    throw new Error(
      `group "${groupOf.get(id).id}" lists "${id}", which is not a validation case`,
    );
for (const id of Object.keys(showcaseRecipes))
  if (!SHOWCASE_IDS.includes(id))
    throw new Error(
      `examples/gallery/recipes names "${id}", which is not a showcase in the example order`,
    );

/** A showcase's recipe (examples/gallery/recipes/), or undefined. */
export function showcaseRecipe(id) {
  return Object.hasOwn(showcaseRecipes, id) ? showcaseRecipes[id] : undefined;
}

/** The record a showcase generator wrote, with its recipe if it has one. */
export function showcaseRecord(id) {
  const file = join(SHOWCASE_DIR, `${id}.json`);
  if (!existsSync(file))
    throw new Error(
      `${file} is missing: run the generator of "${id}" (examples/gallery/README.md)`,
    );
  const record = JSON.parse(readFileSync(file, "utf8"));
  if (record.id !== id)
    throw new Error(`${file} describes "${record.id}", not "${id}"`);
  const recipe = showcaseRecipe(id);
  return { ...record, kind: "showcase", ...(recipe ? { recipe } : {}) };
}

/** Every example in page order, from the published case rows and the records. */
export function catalog(rows) {
  const rowById = new Map(rows.map((r) => [r.id, r]));
  return ORDER.map((id) => {
    if (!caseIds.has(id)) return showcaseRecord(id);
    const row = rowById.get(id);
    if (!row) throw new Error(`no published row for case "${id}"`);
    const c = cases.find((x) => x.id === id);
    const g = groupOf.get(id);
    return {
      ...row,
      kind: "case",
      page: c.page,
      recipe: c.recipe,
      group: { id: g.id, name: g.name, namePrefix: g.namePrefix ?? "" },
    };
  });
}

/**
 * Write a showcase's record and figure (generators in examples/gallery/). The
 * record carries the builds behind it (lib/provenance.mjs) and the date, like
 * the case rows: always the C++ engine, and the Rust module when the
 * generator solved through it (`solver: "rust"`, e.g. lib/pipeline.mjs
 * buildFromRecipe) rather than through the engine (`solver: "engine"`).
 */
export function writeShowcase(record, png, { solver = "engine" } = {}) {
  if (!ORDER.includes(record.id) || caseIds.has(record.id))
    throw new Error(`"${record.id}" is not a showcase in the example order`);
  if (solver !== "engine" && solver !== "rust")
    throw new Error(
      `writeShowcase "${record.id}": solver must be "engine" or "rust", got ${JSON.stringify(solver)}`,
    );
  mkdirSync(SHOWCASE_DIR, { recursive: true });
  writeFileSync(
    join(SHOWCASE_DIR, `${record.id}.json`),
    JSON.stringify(
      {
        ...record,
        engine: engineId(),
        ...(solver === "rust" ? { fem: femModuleId() } : {}),
        generated: new Date().toISOString().slice(0, 10),
      },
      null,
      2,
    ) + "\n",
  );
  writeFileSync(join(SITE_DIR, `${record.id}.png`), png);
}
