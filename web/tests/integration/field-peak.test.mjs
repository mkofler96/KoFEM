// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Where the plotted field peaks and which idealised supports and loads sit on
// that node (KOF-495), as the Results panel asks the Rust module's fieldPeak:
// node ids mapped to indices, and each idealised support or load packed as one
// selection: a support that holds every translation, and a support or load on
// a point or on an edge of a solid. A symmetry or roller support on a face,
// a load spread over a face, and either on a shell's edge (its boundary)
// stress the part as it is, so they are left out. The numerics are covered in crates/kofem-fem/tests/field_peak.rs;
// this checks the packing.

import { beforeAll, describe, expect, test } from "bun:test";
import { loadFem } from "../support/wasm.mjs";
import { fieldPeakLocation } from "../../src/lib/resultStatistics.ts";

beforeAll(async () => {
  await loadFem();
});

const node = (id, x, y, z) => ({ id, x, y, z });
// Node ids that are not their array positions.
const nodes = [
  node(10, 0, 0, 0),
  node(11, 10, 0, 0),
  node(12, 20, 0, 0),
  node(13, 30, 0, 0),
];
const values = Float64Array.from([1, 2, 9, 3]);
// Which elements the nodes belong to decides what an edge selection is.
const solid = [{ id: 1, type: "CTETRA", nodeIds: [10, 11, 12, 13] }];
const shell = [{ id: 1, type: "CTRIA3", nodeIds: [11, 12, 13] }];
const face = (nodeIds, geometry = "face") => ({ nodeIds, geometry });
const support = (name, nodeIds, dofs = [0, 1, 2]) => ({
  name,
  dofs,
  faces: [face(nodeIds)],
});
const pointLoad = (name, nodeIds) => ({
  name,
  faces: [face(nodeIds, "point")],
});

describe("fieldPeakLocation", () => {
  test("reads the peak node's id, coordinates and value", () => {
    const peak = fieldPeakLocation(values, nodes, solid, [], [], []);
    expect(peak).toEqual({ nodeId: 12, at: [20, 0, 0], value: 9, on: [] });
  });

  test("names the supports and loads on the peak node", () => {
    const peak = fieldPeakLocation(
      values,
      nodes,
      solid,
      [support("Fixed", [10, 11]), support("Pinned", [12, 13])],
      [pointLoad("Pull", [12])],
      [],
    );
    expect(peak.on).toEqual([
      { kind: "support", name: "Pinned" },
      { kind: "load", name: "Pull" },
    ]);
  });

  test("a symmetry support and a face load on the peak node name nothing", () => {
    // Symmetry on x: Ux and the rotations Ry, Rz held, Uy and Uz free.
    const peak = fieldPeakLocation(
      values,
      nodes,
      solid,
      [support("Symmetry", [12, 13], [0, 4, 5])],
      [{ name: "Pressure", faces: [face([11, 12])] }],
      [],
    );
    expect(peak.on).toEqual([]);
  });

  test("a load on a point among several selections counts as a point load", () => {
    const peak = fieldPeakLocation(
      values,
      nodes,
      solid,
      [],
      [{ name: "Mixed", faces: [face([10, 11]), face([12], "point")] }],
      [],
    );
    expect(peak.on).toEqual([{ kind: "load", name: "Mixed" }]);
  });

  test("a support on a point or on an edge of a solid holds it alone, so it is named", () => {
    const line = {
      name: "Line",
      dofs: [2],
      faces: [face([12, 13], "edge")],
    };
    const pin = { name: "Pin", dofs: [2], faces: [face([12], "point")] };
    const peak = fieldPeakLocation(values, nodes, solid, [line, pin], [], []);
    expect(peak.on).toEqual([
      { kind: "support", name: "Line" },
      { kind: "support", name: "Pin" },
    ]);
  });

  test("an edge of a shell is its boundary: a symmetry support there names nothing", () => {
    const symmetry = {
      name: "Symmetry",
      dofs: [0, 2, 4, 5],
      faces: [face([12, 13], "edge")],
    };
    const peak = fieldPeakLocation(values, nodes, shell, [symmetry], [], []);
    expect(peak.on).toEqual([]);
  });

  test("names nothing when the peak is off every support and load", () => {
    const peak = fieldPeakLocation(
      values,
      nodes,
      solid,
      [support("Fixed", [10])],
      [pointLoad("Pull", [13])],
      [],
    );
    expect(peak.on).toEqual([]);
  });

  test("a support on a coupling's reference point holds its coupled surface", () => {
    // Node 14 is the reference point, coupled to nodes 12 and 13.
    const withPoint = [...nodes, node(14, 40, 0, 0)];
    const peak = fieldPeakLocation(
      Float64Array.from([1, 2, 9, 3, 0]),
      withPoint,
      solid,
      [support("Hub", [14])],
      [],
      [{ refNodeId: 14, faces: [face([12, 13])] }],
    );
    expect(peak.on).toEqual([{ kind: "support", name: "Hub" }]);
  });

  test("a load on a coupling's reference point is spread over its surface", () => {
    const withPoint = [...nodes, node(14, 40, 0, 0)];
    const peak = fieldPeakLocation(
      Float64Array.from([1, 2, 9, 3, 0]),
      withPoint,
      solid,
      [],
      [pointLoad("Torque", [14])],
      [{ refNodeId: 14, faces: [face([12, 13])] }],
    );
    expect(peak.on).toEqual([]);
  });

  test("refuses a support on a node the mesh does not have", () => {
    expect(() =>
      fieldPeakLocation(values, nodes, solid, [support("Fixed", [99])], [], []),
    ).toThrow(/99/);
  });
});
