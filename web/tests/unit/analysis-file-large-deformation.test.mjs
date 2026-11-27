// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Large deformation (KOF-486) travels in the analysis file with its load
// increments, as the element order does: a result saved from a
// large-deformation solve reopens with the setting it was solved with. A file
// without it is written and read as before, and an entry of the wrong shape is
// refused rather than dropped.

import { beforeAll, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

// lib/analysisFile reaches the model store, which reads the screen size and
// the saved sidebar width when it is created; give it a desktop-sized window
// and an empty storage.
globalThis.localStorage ??= {
  getItem: () => null,
  setItem() {
    // Nothing is persisted in this test.
  },
  removeItem() {
    // Nothing is persisted in this test.
  },
};
globalThis.window ??= {
  matchMedia: () => ({
    matches: false,
    addEventListener() {
      // The screen size never changes in this test.
    },
    removeEventListener() {
      // The screen size never changes in this test.
    },
  }),
};
const { parseAnalysisFile, serializeAnalysis } =
  await import("../../src/lib/analysisFile.ts");

const EXAMPLE = new URL(
  "../../../examples/gallery/site/cantilever-beam.vtu",
  import.meta.url,
);

let text = "";
let analysis = null;

beforeAll(() => {
  text = readFileSync(EXAMPLE, "utf8");
  analysis = parseAnalysisFile(text);
});

// The file, saved with large deformation on, with its KoFEM metadata edited
// by `change`.
function withMeta(change) {
  const saved = serializeAnalysis({
    ...analysis,
    largeDeformation: true,
    loadIncrements: 12,
  });
  const match = saved.match(/(Name="KoFEM"[^>]*>)([\s\S]*?)(<\/DataArray>)/);
  const bytes = Buffer.from(match[2].trim(), "base64");
  const meta = JSON.parse(bytes.subarray(4).toString("utf8"));
  change(meta);
  const json = Buffer.from(JSON.stringify(meta), "utf8");
  const header = Buffer.alloc(4);
  header.writeUInt32LE(json.length, 0);
  return saved.replace(
    match[0],
    `${match[1]}\n${Buffer.concat([header, json]).toString("base64")}\n${match[3]}`,
  );
}

test("a file without large deformation loads with it off and saves unchanged", () => {
  expect(analysis.largeDeformation).toBe(false);
  expect(analysis.loadIncrements).toBe(10);
  expect(serializeAnalysis(analysis)).toBe(text);
});

test("large deformation and its load increments round-trip", () => {
  const saved = serializeAnalysis({
    ...analysis,
    largeDeformation: true,
    loadIncrements: 12,
  });
  const loaded = parseAnalysisFile(saved);
  expect(loaded.largeDeformation).toBe(true);
  expect(loaded.loadIncrements).toBe(12);
  expect(serializeAnalysis(loaded)).toBe(saved);
});

test("large deformation of the wrong shape is refused", () => {
  for (const wrong of [
    { increments: 0 },
    { increments: 2.5 },
    { increments: "4" },
    {},
    true,
  ])
    expect(() =>
      parseAnalysisFile(
        withMeta((m) => {
          m.largeDeformation = wrong;
        }),
      ),
    ).toThrow('"largeDeformation"');
});
