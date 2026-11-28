// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// What a support or load group card says it applies (KOF-494): which of the
// group's selections have a CAD face area, and the card's line from the
// figures the Rust module computes (crates/kofem-fem/tests/boundary_summary.rs
// covers those numbers; tests/integration/group-summary.test.mjs the call).
// The card's header already shows the components and DOFs, so the line adds
// only what is new: the area, the traction or total force, and |F| or |M|
// for a vector of more than one component.

import { describe, expect, test } from "bun:test";
import {
  cadFaceSelection,
  loadSummaryText,
  supportSummaryText,
  type GroupArea,
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
const measured = (area: number, repeated: number[] = []): GroupArea => ({
  state: "measured",
  area,
  repeated,
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
  test("a single-axis force adds its area and mean traction", () => {
    expect(
      loadSummaryText(
        {
          kind: "force",
          axes: 1,
          area: measured(10_000),
          value: { total: 1e6, meanTraction: 100 },
        },
        [],
        en,
        "en-US",
      ),
    ).toEqual({
      summary: "10,000 mm² → 100 MPa",
      hint: undefined,
      warning: null,
    });
  });

  test("the issue's example: 100 N over 149 mm²", () => {
    expect(
      loadSummaryText(
        {
          kind: "force",
          axes: 1,
          area: measured(149.2),
          value: { total: 100, meanTraction: 100 / 149.2 },
        },
        [],
        en,
        "en-US",
      ).summary,
    ).toBe("149 mm² → 0.67 MPa");
  });

  test("a force of several components also says its magnitude", () => {
    expect(
      loadSummaryText(
        {
          kind: "force",
          axes: 3,
          area: measured(2),
          value: { total: 13, meanTraction: 6.5 },
        },
        [],
        en,
        "en-US",
      ).summary,
    ).toBe("|F| = 13 N · 2 mm² → 6.5 MPa");
  });

  test("a pressure says the total force it pushes with", () => {
    expect(
      loadSummaryText(
        {
          kind: "pressure",
          area: measured(149),
          value: { pressure: 10, total: 1490 },
        },
        [],
        en,
        "en-US",
      ).summary,
    ).toBe("149 mm² → 1,490 N");
  });

  test("a moment on one face adds its area", () => {
    expect(
      loadSummaryText(
        {
          kind: "moment",
          axes: 1,
          area: measured(5027),
          value: { each: 1000, applied: 1, total: 1000 },
        },
        [],
        en,
        "en-US",
      ).summary,
    ).toBe("5,027 mm²");
  });

  test("an area not measured is a dash, with the reason as a hint", () => {
    const text = loadSummaryText(
      {
        kind: "force",
        axes: 1,
        area: { state: "unmeasured" },
        value: { total: 500, meanTraction: null },
      },
      [],
      en,
      "en-US",
    );
    expect(text.summary).toBe("—");
    expect(text.hint).toBe(
      "Area not measured: the selection is not whole CAD faces",
    );
  });

  test("whole faces without CAD geometry say the geometry is missing", () => {
    const text = loadSummaryText(
      {
        kind: "pressure",
        area: { state: "noGeometry" },
        value: { pressure: 3, total: null },
      },
      [],
      en,
      "en-US",
    );
    expect(text.summary).toBe("—");
    expect(text.hint).toBe(
      "Area not measured: the CAD geometry is not loaded. Import the STEP file to measure it",
    );
  });

  test("no faces is said, never 0 N", () => {
    expect(
      loadSummaryText(
        { kind: "force", axes: 1, area: { state: "empty" }, value: null },
        [],
        en,
        "en-US",
      ).summary,
    ).toBe("No faces selected");
  });

  test("no value is said, never 0 N", () => {
    expect(
      loadSummaryText(
        { kind: "force", axes: 0, area: measured(10_000), value: null },
        [],
        en,
        "en-US",
      ).summary,
    ).toBe("No value set · 10,000 mm²");
  });

  test("a face picked twice is flagged by the rows that repeat it", () => {
    const faces = [face(1, 2), face(2, 4), face(3, 2)];
    expect(
      loadSummaryText(
        {
          kind: "force",
          axes: 1,
          area: measured(20_000, [2]),
          value: { total: 1e6, meanTraction: 50 },
        },
        faces,
        en,
        "en-US",
      ).warning,
    ).toBe("Face 1 and Face 3 are the same face, counted once");
  });
});

describe("a moment on several selections", () => {
  // The solve applies a moment group's full vector to each face selection
  // (momentToNodalForces), unlike a force, which is one total for the group.
  test("says it is applied to each, and the total the solve gets", () => {
    expect(
      loadSummaryText(
        {
          kind: "moment",
          axes: 1,
          area: measured(20_000),
          value: { each: 1000, applied: 2, total: 2000 },
        },
        [],
        en,
        "en-US",
      ).summary,
    ).toBe("applied to each of 2 selections → 2,000 N·mm · 20,000 mm²");
  });

  test("a face picked twice takes the moment twice, and says so", () => {
    const faces = [face(1, 2), face(2, 2)];
    expect(
      loadSummaryText(
        {
          kind: "moment",
          axes: 1,
          area: measured(10_000, [2]),
          value: { each: 1000, applied: 2, total: 2000 },
        },
        faces,
        en,
        "en-US",
      ).warning,
    ).toBe(
      "Face 1 and Face 2 are the same face: its area counts once, but the moment is applied to each",
    );
  });
});

describe("supportSummaryText", () => {
  test("a support adds its area to the DOFs its header shows", () => {
    expect(supportSummaryText(measured(10_000), [], en, "en-US")).toEqual({
      summary: "10,000 mm²",
      hint: undefined,
      warning: null,
    });
  });

  test("a support on a point shows a dash and why", () => {
    const text = supportSummaryText({ state: "unmeasured" }, [], en, "en-US");
    expect(text.summary).toBe("—");
    expect(text.hint).toBe(
      "Area not measured: the selection is not whole CAD faces",
    );
  });

  test("a support without faces says so", () => {
    expect(
      supportSummaryText({ state: "empty" }, [], en, "en-US").summary,
    ).toBe("No faces selected");
  });
});
