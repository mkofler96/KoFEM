// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// The examples on /examples/, in the order the page lists them. Two kinds:
//
//   case      a validation case (./cases/): run.mjs solves it on every CI run
//             and writes its analysis file, figure and published row;
//   showcase  a model built by its own generator in examples/gallery/ (a CAD
//             import, a shell mesh, a topology optimization), which writes
//             its analysis file, figure and a record in
//             examples/gallery/showcase/<id>.json.
//
// Every example is opened by /app/?example=<id> from examples/gallery/site/,
// and has a page /examples/<id>/ with text from ./textbook/<id>.mjs.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import cases from "./cases/index.mjs";

const here = dirname(fileURLToPath(import.meta.url));
export const SITE_DIR = join(here, "../gallery/site");
export const SHOWCASE_DIR = join(here, "../gallery/showcase");

export const ORDER = [
  "axial-bar",
  "surface-pressure",
  "cantilever",
  "cantilever-p2",
  "cantilever-beam",
  "beam-torsion",
  "shaft-torsion",
  "plate-with-hole",
  "plate-with-hole-shell",
  "cooks-membrane",
  "mbb-beam-topopt",
];

const caseIds = new Set(cases.map((c) => c.id));
export const SHOWCASE_IDS = ORDER.filter((id) => !caseIds.has(id));

for (const c of cases)
  if (!ORDER.includes(c.id))
    throw new Error(`case "${c.id}" is missing from the example order`);

/** The record a showcase generator wrote. */
export function showcaseRecord(id) {
  const file = join(SHOWCASE_DIR, `${id}.json`);
  if (!existsSync(file))
    throw new Error(
      `${file} is missing: run the generator of "${id}" (examples/gallery/README.md)`,
    );
  const record = JSON.parse(readFileSync(file, "utf8"));
  if (record.id !== id)
    throw new Error(`${file} describes "${record.id}", not "${id}"`);
  return { ...record, kind: "showcase" };
}

/** Every example in page order, from the published case rows and the records. */
export function catalog(rows) {
  const rowById = new Map(rows.map((r) => [r.id, r]));
  return ORDER.map((id) => {
    if (!caseIds.has(id)) return showcaseRecord(id);
    const row = rowById.get(id);
    if (!row) throw new Error(`no published row for case "${id}"`);
    return { ...row, kind: "case", page: cases.find((c) => c.id === id).page };
  });
}

/**
 * Write a showcase's record and figure (generators in examples/gallery/). The
 * record carries the engine build and the date, like the case rows.
 */
export function writeShowcase(record, png) {
  if (!ORDER.includes(record.id) || caseIds.has(record.id))
    throw new Error(`"${record.id}" is not a showcase in the example order`);
  const engine = readFileSync(
    join(here, "../../web/src/wasm/pkg/.engine-id"),
    "utf8",
  ).trim();
  mkdirSync(SHOWCASE_DIR, { recursive: true });
  writeFileSync(
    join(SHOWCASE_DIR, `${record.id}.json`),
    JSON.stringify(
      { ...record, engine, generated: new Date().toISOString().slice(0, 10) },
      null,
      2,
    ) + "\n",
  );
  writeFileSync(join(SITE_DIR, `${record.id}.png`), png);
}
