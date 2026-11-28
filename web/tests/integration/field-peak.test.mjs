// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Where the plotted field peaks and which idealised supports and loads sit on
// that node (KOF-495), as the Results panel asks the Rust module's fieldPeak:
// node ids mapped to indices, the groups handed over as they are, and the
// indices it returns mapped back to group names. Which groups count as
// idealised is covered in crates/kofem-fem/tests/field_peak.rs; this checks
// the packing.

import { beforeAll, describe, expect, test } from "bun:test";
import { loadFem } from "../support/wasm.mjs";
import { fieldPeakLocation } from "../../src/lib/resultStatistics.ts";

beforeAll(async () => {
  await loadFem();
});

const node = (id, x, y, z) => ({ id, x, y, z });
// Node ids that are not their array positions; 14 is a coupling's reference
// point.
const nodes = [
  node(10, 0, 0, 0),
  node(11, 10, 0, 0),
  node(12, 20, 0, 0),
  node(13, 30, 0, 0),
  node(14, 40, 0, 0),
];
const values = Float64Array.from([1, 2, 9, 3, 0]);
const solid = [{ id: 1, type: "CTETRA", nodeIds: [10, 11, 12, 13] }];
const shell = [{ id: 2, type: "CTRIA3", nodeIds: [11, 12, 13] }];
const face = (nodeIds, geometry) => ({ nodeIds, geometry });
const support = (name, faces, dofs = [0, 1, 2]) => ({ name, dofs, faces });

describe("fieldPeakLocation", () => {
  test("reads the peak node's id, coordinates and value", () => {
    const peak = fieldPeakLocation(values, nodes, solid, [], [], []);
    expect(peak).toEqual({ nodeId: 12, at: [20, 0, 0], value: 9, on: [] });
  });

  test("names the groups Rust finds idealised, supports before loads", () => {
    const peak = fieldPeakLocation(
      values,
      nodes,
      solid,
      [
        support("Symmetry", [face([12], "face")], [0]),
        support("Clamp", [face([11, 12], "face")]),
      ],
      [{ name: "Pull", faces: [face([12], "point")] }],
      [],
    );
    expect(peak.on).toEqual([
      { kind: "support", name: "Clamp" },
      { kind: "load", name: "Pull" },
    ]);
  });

  test("hands over the shell facets, so an edge of a shell is not a line", () => {
    const line = support("Line", [face([12, 13], "edge")], [2]);
    expect(fieldPeakLocation(values, nodes, solid, [line], [], []).on).toEqual([
      { kind: "support", name: "Line" },
    ]);
    expect(fieldPeakLocation(values, nodes, shell, [line], [], []).on).toEqual(
      [],
    );
  });

  test("hands over a pick saved without its kind as unrecorded", () => {
    const old = support("Old", [face([12], undefined)], [2]);
    expect(fieldPeakLocation(values, nodes, solid, [old], [], []).on).toEqual(
      [],
    );
  });

  test("hands over the couplings by node index", () => {
    const peak = fieldPeakLocation(
      values,
      nodes,
      solid,
      [support("Hub", [face([14], "point")])],
      [],
      [{ name: "Coupling1", refNodeId: 14, faces: [face([12, 13], "face")] }],
    );
    expect(peak.on).toEqual([{ kind: "support", name: "Hub" }]);
  });

  test("refuses a support on a node the mesh does not have", () => {
    expect(() =>
      fieldPeakLocation(
        values,
        nodes,
        solid,
        [support("Fixed", [face([99], "face")])],
        [],
        [],
      ),
    ).toThrow(/Fixed.*99/);
  });

  test("refuses a shell facet on a node the mesh does not have", () => {
    const stray = [{ id: 7, type: "CTRIA3", nodeIds: [10, 11, 98] }];
    expect(() => fieldPeakLocation(values, nodes, stray, [], [], [])).toThrow(
      /7.*98/,
    );
  });
});
