// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Support and load names in a saved analysis file (KOF-339). A name the user
// gave a group comes back when the file is opened. A file whose support or
// load has a blank or missing name is refused with a clear error, as the
// Name field refuses a blank name: the model tree would show nothing to tell
// the group by.

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

// The example, saved again with its first support or load changed by `edit`.
function resaved(groups, edit) {
  const copy = structuredClone(analysis);
  edit(copy[groups][0]);
  return serializeAnalysis(copy);
}

describe("support and load names in an analysis file", () => {
  test("a renamed support and load keep their names through save and open", () => {
    const copy = structuredClone(analysis);
    copy.bcGroups[0].name = "Fixed end";
    copy.loadGroups[0].name = "Tip load";
    const opened = parseAnalysisFile(serializeAnalysis(copy));
    expect(opened.bcGroups[0].name).toBe("Fixed end");
    expect(opened.loadGroups[0].name).toBe("Tip load");
  });

  for (const [groups, what] of [
    ["bcGroups", "support"],
    ["loadGroups", "load"],
  ]) {
    test(`a ${what} with a blank name is refused`, () => {
      const file = resaved(groups, (group) => {
        group.name = "   ";
      });
      expect(() => parseAnalysisFile(file)).toThrow(
        `Invalid analysis file: ${what} ${analysis[groups][0].id} has a blank name`,
      );
    });

    test(`a ${what} with no name is refused`, () => {
      const file = resaved(groups, (group) => {
        delete group.name;
      });
      expect(() => parseAnalysisFile(file)).toThrow(
        `Invalid analysis file: ${what} ${analysis[groups][0].id} has no name`,
      );
    });
  }
});
