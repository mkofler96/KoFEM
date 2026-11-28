// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// What a support or load group card says it applies (KOF-494): which of the
// group's selections have a CAD face area, and the card's text from the
// totals the Rust module computes (crates/kofem-fem/tests/boundary_summary.rs
// covers those numbers; tests/integration/group-summary.test.mjs the call).

import { describe, expect, test } from "bun:test";
import {
  cadFaceSelection,
  loadSummaryText,
  supportSummaryText,
} from "../../src/lib/groupSummary";
import { boundaryMessages } from "../../src/i18n/messages/boundary";
import type { BcFaceEntry } from "../../src/store/modelStore";

const en = boundaryMessages.en;
const face = (
  id: number,
  cadFaceId: number | undefined,
  geometry: BcFaceEntry["geometry"] = "face",
): BcFaceEntry => ({
  id,
  label: `Face ${id}`,
  nodeIds: [id],
  geometry,
  ...(cadFaceId === undefined ? {} : { cadFaceId }),
});

describe("cadFaceSelection", () => {
  test("no selection is empty", () => {
    expect(cadFaceSelection([])).toEqual({ state: "empty" });
  });

  test("whole CAD faces are measured by their ids", () => {
    expect(cadFaceSelection([face(1, 4), face(2, 2)])).toEqual({
      state: "faces",
      ids: [4, 2],
    });
  });

  test("a face picked twice keeps both ids, for Rust to count once", () => {
    expect(cadFaceSelection([face(1, 4), face(2, 4)])).toEqual({
      state: "faces",
      ids: [4, 4],
    });
  });

  test("a region or a point has no CAD face area, so neither has the group", () => {
    expect(cadFaceSelection([face(1, 4), face(2, undefined)])).toEqual({
      state: "unmeasured",
    });
    expect(cadFaceSelection([face(1, 4, "point")])).toEqual({
      state: "unmeasured",
    });
  });
});

describe("loadSummaryText", () => {
  test("a force says its total over the area and the mean traction", () => {
    expect(
      loadSummaryText(
        {
          kind: "force",
          area: { state: "measured", area: 10_000, repeated: [] },
          value: { total: 1e6, meanTraction: 100 },
        },
        [],
        en,
        "en-US",
      ),
    ).toEqual({
      summary: "1,000,000 N over 10,000 mm² → 100 MPa",
      warning: null,
    });
  });

  test("the issue's example: 100 N over 149 mm²", () => {
    expect(
      loadSummaryText(
        {
          kind: "force",
          area: { state: "measured", area: 149.2, repeated: [] },
          value: { total: 100, meanTraction: 100 / 149.2 },
        },
        [],
        en,
        "en-US",
      ).summary,
    ).toBe("100 N over 149 mm² → 0.67 MPa");
  });

  test("a pressure says the total force it pushes with", () => {
    expect(
      loadSummaryText(
        {
          kind: "pressure",
          area: { state: "measured", area: 149, repeated: [] },
          value: { pressure: 10, total: 1490 },
        },
        [],
        en,
        "en-US",
      ).summary,
    ).toBe("10 MPa × 149 mm² → 1,490 N");
  });

  test("a moment says its total over the area, and no traction", () => {
    expect(
      loadSummaryText(
        {
          kind: "moment",
          area: { state: "measured", area: 5027, repeated: [] },
          value: { total: 1000 },
        },
        [],
        en,
        "en-US",
      ).summary,
    ).toBe("1,000 N·mm over 5,027 mm²");
  });

  test("a force on points keeps its total and says the area is not measured", () => {
    expect(
      loadSummaryText(
        {
          kind: "force",
          area: { state: "unmeasured" },
          value: { total: 500, meanTraction: null },
        },
        [],
        en,
        "en-US",
      ).summary,
    ).toBe("500 N · area not measured: not whole CAD faces");
  });

  test("a pressure without a CAD face area has no total, and says why", () => {
    expect(
      loadSummaryText(
        {
          kind: "pressure",
          area: { state: "unmeasured" },
          value: { pressure: 3, total: null },
        },
        [],
        en,
        "en-US",
      ).summary,
    ).toBe("3 MPa · area not measured: not whole CAD faces");
  });

  test("no faces is said, never 0 N", () => {
    const text = loadSummaryText(
      { kind: "force", area: { state: "empty" }, value: null },
      [],
      en,
      "en-US",
    );
    expect(text.summary).toBe("No faces selected");
    expect(text.summary).not.toContain("0 N");
  });

  test("no value is said, never 0 N", () => {
    const text = loadSummaryText(
      {
        kind: "force",
        area: { state: "measured", area: 10_000, repeated: [] },
        value: null,
      },
      [],
      en,
      "en-US",
    );
    expect(text.summary).toBe("No value set · 10,000 mm²");
  });

  test("a face picked twice is flagged by the rows that repeat it", () => {
    const faces = [face(1, 2), face(2, 4), face(3, 2)];
    expect(
      loadSummaryText(
        {
          kind: "force",
          area: { state: "measured", area: 20_000, repeated: [2] },
          value: { total: 1e6, meanTraction: 50 },
        },
        faces,
        en,
        "en-US",
      ).warning,
    ).toBe("Face 1 and Face 3 are the same face, counted once");
  });
});

describe("supportSummaryText", () => {
  test("a fixed support says its area and the DOFs it holds", () => {
    expect(
      supportSummaryText(
        { state: "measured", area: 10_000, repeated: [] },
        [0, 1, 2],
        0,
        [],
        en,
        "en-US",
      ),
    ).toEqual({ summary: "10,000 mm² · holds Ux, Uy, Uz", warning: null });
  });

  test("a prescribed displacement says the value it sets", () => {
    expect(
      supportSummaryText(
        { state: "measured", area: 40.2, repeated: [] },
        [1],
        0.5,
        [],
        en,
        "en-US",
      ).summary,
    ).toBe("40.2 mm² · sets Uy = 0.5");
  });

  test("a support on a point says its area is not measured", () => {
    expect(
      supportSummaryText({ state: "unmeasured" }, [0, 1, 2], 0, [], en, "en-US")
        .summary,
    ).toBe("area not measured: not whole CAD faces · holds Ux, Uy, Uz");
  });

  test("a support without faces says so", () => {
    expect(
      supportSummaryText({ state: "empty" }, [0], 0, [], en, "en-US").summary,
    ).toBe("No faces selected · holds Ux");
  });
});
