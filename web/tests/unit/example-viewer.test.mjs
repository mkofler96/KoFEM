// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// The interactive view's payload on an example page
// (examples/validation/lib/viewer.mjs): the solved boundary surface, only the
// vertices its triangles use, with every result field the reader can switch
// between and the view the page's static figure is drawn from.

import { describe, expect, test } from "bun:test";
import {
  viewerPayload,
  viewerUrl,
} from "../../../examples/validation/lib/viewer.mjs";

// Two triangles over four of five nodes; node 2 is interior to the mesh.
const surface = {
  positions: [0, 0, 0, 1, 0, 0, 0.5, 0.5, 0.5, 1, 1, 0, 0, 1, 0],
  displacements: [0, 0, 0, 0.1, 0, 0, 9, 9, 9, 0.1, 0.2, 0, 0, 0.2, 0],
  triangles: [0, 1, 3, 0, 3, 4],
};
const fields = {
  displacement: [0, 0.1, 15.6, Math.hypot(0.1, 0.2), 0.2],
  vonMises: [10, 20, 999, 30, 1 / 3],
};
const figure = { field: "vonMises", deform: 50, view: [0, 0, -1] };

describe("viewerPayload", () => {
  const payload = JSON.parse(viewerPayload("plate", surface, fields, figure));

  test("keeps the surface vertices only, numbered by first use", () => {
    expect(payload.positions).toEqual([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0]);
    expect(payload.displacements).toEqual([
      0, 0, 0, 0.1, 0, 0, 0.1, 0.2, 0, 0, 0.2, 0,
    ]);
    expect(payload.triangles).toEqual([0, 1, 2, 0, 2, 3]);
  });

  test("carries every field per surface vertex, the figure's first", () => {
    expect(payload.fields.map((f) => f.key)).toEqual([
      "vonMises",
      "displacement",
    ]);
    expect(payload.fields[0]).toMatchObject({
      name: "Von Mises stress",
      unit: "MPa",
      values: [10, 20, 30, 0.33333],
    });
    expect(payload.fields[1]).toMatchObject({
      name: "Displacement magnitude |U|",
      unit: "mm",
      values: [0, 0.1, 0.22361, 0.2],
    });
  });

  test("starts from the static figure's view and enlargement", () => {
    expect(payload.id).toBe("plate");
    expect(payload.deformScale).toBe(50);
    expect(payload.view).toEqual({ direction: [0, 0, -1] });
  });

  test("frames the figure's focus square when it has one", () => {
    const focused = JSON.parse(
      viewerPayload("plate", surface, fields, {
        ...figure,
        deform: 0,
        focus: { center: [1, 2, 3], half: 4, aspect: 0.6 },
      }),
    );
    expect(focused.deformScale).toBe(0);
    expect(focused.view).toEqual({
      direction: [0, 0, -1],
      target: [1, 2, 3],
      half: 4,
    });
  });

  test("an undeformed density design has no displacements to carry", () => {
    const design = JSON.parse(
      viewerPayload(
        "mbb",
        { positions: surface.positions, triangles: surface.triangles },
        { density: [1, 0.9, 0, 0.7, 0.5] },
        { field: "density", deform: 0, view: [-0.3, -0.25, -1] },
      ),
    );
    expect(design.displacements).toBeUndefined();
    expect(design.fields).toEqual([
      {
        key: "density",
        name: "Element density",
        unit: "",
        values: [1, 0.9, 0.7, 0.5],
      },
    ]);
  });

  test("refuses a figure field it was not given", () => {
    expect(() =>
      viewerPayload("plate", surface, fields, { ...figure, field: "density" }),
    ).toThrow(/plate: the figure shows density/);
  });

  test("refuses a field with a value missing for a node", () => {
    expect(() =>
      viewerPayload("plate", surface, { ...fields, vonMises: [1, 2] }, figure),
    ).toThrow(/plate: vonMises has 2 values for 5 nodes/);
  });

  test("refuses a field it has no name for", () => {
    expect(() =>
      viewerPayload("plate", surface, { ...fields, strain: [] }, figure),
    ).toThrow(/plate: no name for field "strain"/);
  });

  test("is served next to the page's figure", () => {
    expect(viewerUrl("plate")).toBe("/examples/plate.result.json");
  });
});
