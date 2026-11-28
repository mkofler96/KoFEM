// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// A material's yield strength (KOF-496) travels in the analysis file. A file
// whose materials have none loads with none set, and a yield strength that is
// not a positive number is refused rather than dropped.

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

// The file with the first material's yield strength set to `value`, written
// into the KoFEM metadata directly so the parser alone decides.
function withYield(value) {
  const saved = serializeAnalysis(analysis);
  const match = saved.match(/(Name="KoFEM"[^>]*>)([\s\S]*?)(<\/DataArray>)/);
  const bytes = Buffer.from(match[2].trim(), "base64");
  const meta = JSON.parse(bytes.subarray(4).toString("utf8"));
  meta.materials[0].yieldStrength = value;
  const json = Buffer.from(JSON.stringify(meta), "utf8");
  const header = Buffer.alloc(4);
  header.writeUInt32LE(json.length, 0);
  return saved.replace(
    match[0],
    `${match[1]}\n${Buffer.concat([header, json]).toString("base64")}\n${match[3]}`,
  );
}

test("a file without a yield strength loads with none set", () => {
  expect(analysis.materials.every((m) => m.yieldStrength === undefined)).toBe(
    true,
  );
  expect(serializeAnalysis(analysis)).toBe(text);
});

test("a yield strength round-trips", () => {
  const materials = analysis.materials.map((m) => ({
    ...m,
    yieldStrength: 355,
  }));
  const saved = serializeAnalysis({ ...analysis, materials });
  const loaded = parseAnalysisFile(saved);
  expect(loaded.materials.map((m) => m.yieldStrength)).toEqual(
    materials.map(() => 355),
  );
  expect(parseAnalysisFile(withYield(250)).materials[0].yieldStrength).toBe(
    250,
  );
});

test("a yield strength that is not a positive number is refused", () => {
  for (const wrong of [0, -10, "250", null])
    expect(() => parseAnalysisFile(withYield(wrong))).toThrow(/yield strength/);
});
