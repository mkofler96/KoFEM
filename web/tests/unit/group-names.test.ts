// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// A support or load the user renames (KOF-339) keeps the name they typed,
// trimmed. A blank name is refused outright: the model tree, the panel title
// and the saved analysis file would show nothing to tell the group by.

import { describe, expect, test } from "bun:test";
import { validGroupName } from "../../src/store/boundaryGroups";

describe("validGroupName", () => {
  test("keeps a descriptive name", () => {
    expect(validGroupName("Fixed end")).toBe("Fixed end");
  });

  test("trims surrounding whitespace", () => {
    expect(validGroupName("  Axial load \t")).toBe("Axial load");
  });

  test("refuses an empty name", () => {
    expect(() => validGroupName("")).toThrow("A name can't be blank");
  });

  test("refuses a whitespace-only name", () => {
    expect(() => validGroupName("   \n")).toThrow("A name can't be blank");
  });
});
