// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Stress tensors in a saved analysis file (KOF-447): a solved model keeps its
// stress components through save and open, one tensor per element for a solid
// model and one per surface for a model with shells, so an opened example can
// show them and its hand check can read them.

import { beforeAll, describe, expect, test } from "bun:test";
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

// The example opens unsolved; give it a result of the right size.
function solved() {
  const copy = structuredClone(analysis);
  copy.result = {
    displacements: new Float64Array(3 * copy.nodes.length),
    vonMises: new Float64Array(copy.elements.length),
  };
  return copy;
}

// One tensor per element corner: four per tetrahedron.
const corners = (state) =>
  state.elements.reduce((n, el) => n + el.nodeIds.length, 0);

const tensors = (n, offset) =>
  Float64Array.from({ length: 6 * n }, (_, i) => offset + i / 8);

describe("stress tensors in an analysis file", () => {
  test("a solid model's tensors come back on every surface", () => {
    const copy = solved();
    const solid = tensors(corners(copy), 1);
    copy.result.stress = { top: solid, middle: solid, bottom: solid };
    const opened = parseAnalysisFile(serializeAnalysis(copy));
    for (const surface of ["top", "middle", "bottom"])
      expect([...opened.result.stress[surface]]).toEqual([...solid]);
  });

  test("each surface of a model with shells comes back on its own", () => {
    const copy = solved();
    const n = corners(copy);
    copy.result.stress = {
      top: tensors(n, 1),
      middle: tensors(n, 2),
      bottom: tensors(n, 3),
    };
    const opened = parseAnalysisFile(serializeAnalysis(copy));
    expect([...opened.result.stress.top]).toEqual([...tensors(n, 1)]);
    expect([...opened.result.stress.middle]).toEqual([...tensors(n, 2)]);
    expect([...opened.result.stress.bottom]).toEqual([...tensors(n, 3)]);
  });

  test("a file without tensors opens without stress components", () => {
    const copy = solved();
    delete copy.result.stress;
    expect(parseAnalysisFile(serializeAnalysis(copy)).result.stress).toBe(
      undefined,
    );
  });

  test("tensors that do not fit the mesh are refused on save", () => {
    const copy = solved();
    const short = tensors(1, 0);
    copy.result.stress = { top: short, middle: short, bottom: short };
    expect(() => serializeAnalysis(copy)).toThrow(/stress/i);
  });
});

// A temperature change (KOF-449) travels in the setup JSON.
describe("a temperature change in an analysis file", () => {
  test("comes back through save and open", () => {
    const copy = structuredClone(analysis);
    copy.temperature = { formula: "sqrt(x^2 + y^2) / 1000 + z / 1000" };
    expect(parseAnalysisFile(serializeAnalysis(copy)).temperature).toEqual(
      copy.temperature,
    );
  });

  test("a file without one opens with none", () => {
    expect(analysis.temperature).toBeNull();
  });

  test("a malformed one is refused", () => {
    const copy = structuredClone(analysis);
    copy.temperature = { formula: "  " };
    expect(() => parseAnalysisFile(serializeAnalysis(copy))).toThrow(
      /"temperature" must be null/,
    );
  });
});
