// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Face sizes (KOF-394) and the sizes the mesh was made with travel in the
// analysis file. A file without them is written and read as before, and an
// entry of the wrong shape is refused rather than dropped.

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
const FACE_SIZES = [{ faceIds: [3, 5], size: "12.5" }];
const MESH_SIZES = {
  max: 25,
  min: 2.5,
  regions: {},
  faces: { 3: 12.5, 5: 12.5 },
};

let text = "";
let analysis = null;

beforeAll(() => {
  text = readFileSync(EXAMPLE, "utf8");
  analysis = parseAnalysisFile(text);
});

// The file with its KoFEM metadata edited by `change`.
function withMeta(change) {
  const saved = serializeAnalysis({
    ...analysis,
    faceSizes: FACE_SIZES,
    meshSizes: MESH_SIZES,
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

test("a file without face sizes loads with none and saves unchanged", () => {
  expect(analysis.faceSizes).toEqual([]);
  expect(analysis.meshSizes).toBeNull();
  expect(serializeAnalysis(analysis)).toBe(text);
});

test("face sizes and the mesh's sizes round-trip", () => {
  const saved = serializeAnalysis({
    ...analysis,
    faceSizes: FACE_SIZES,
    meshSizes: MESH_SIZES,
  });
  const loaded = parseAnalysisFile(saved);
  expect(loaded.faceSizes).toEqual(FACE_SIZES);
  expect(loaded.meshSizes).toEqual({
    max: 25,
    min: 2.5,
    regions: {},
    faces: { 3: 12.5, 5: 12.5 },
  });
  expect(serializeAnalysis(loaded)).toBe(saved);
});

test("a face size of the wrong shape is refused", () => {
  expect(() =>
    parseAnalysisFile(
      withMeta((m) => {
        m.faceSizes = [{ faceIds: [3], size: 12 }];
      }),
    ),
  ).toThrow('"faceSizes"');
  expect(() =>
    parseAnalysisFile(
      withMeta((m) => {
        m.faceSizes = [{ faceIds: [], size: "1" }];
      }),
    ),
  ).toThrow('"faceSizes"');
});

test("mesh sizes of the wrong shape are refused", () => {
  expect(() =>
    parseAnalysisFile(
      withMeta((m) => {
        m.meshSizes = { max: 25, min: 2.5, regions: {} };
      }),
    ),
  ).toThrow('"meshSizes"');
});
