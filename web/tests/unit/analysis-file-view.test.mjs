// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// The viewport representation saved in an analysis file. The Volume view drew
// every element edge under an opaque surface, which looked the same as the
// Surface view, and was retired (KOF-429). A file saved in it opens in the
// Surface view; a representation the app never had is still refused.

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

let analysis = null;

beforeAll(() => {
  analysis = parseAnalysisFile(
    readFileSync(
      new URL(
        "../../../examples/gallery/site/cantilever-beam.vtu",
        import.meta.url,
      ),
      "utf8",
    ),
  );
});

function savedIn(viewRepr) {
  return serializeAnalysis({ ...analysis, viewRepr });
}

test("a file saved in the retired Volume view opens in the Surface view", () => {
  expect(parseAnalysisFile(savedIn("volume")).viewRepr).toBe("surface");
});

test("the other views open as saved", () => {
  for (const repr of ["geometry", "surface", "wireframe"])
    expect(parseAnalysisFile(savedIn(repr)).viewRepr).toBe(repr);
});

test("a view the app never had is refused", () => {
  expect(() => parseAnalysisFile(savedIn("xray"))).toThrow(
    'unknown viewRepr "xray"',
  );
});
