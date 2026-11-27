// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Contacts as model data (KOF-485): a contact connection is carried to a new
// mesh by its CAD faces like a tie, survives a saved analysis file, reaches
// the solve as `contacts`, and its result is a field over the mesh nodes —
// the pressure (or touching status) on the contact's slave nodes, zero
// everywhere else, where nothing presses.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

// lib/analysisFile reaches the model store, which reads the screen size and
// the saved sidebar width when it is created.
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

const { carryGroupsToMesh } = await import("../../src/lib/remeshGroups.ts");
const { parseAnalysisFile, serializeAnalysis } =
  await import("../../src/lib/analysisFile.ts");
const { solvePayload } = await import("../../src/lib/solve/payload.ts");
const { nodalResultValues } = await import("../../src/lib/resultField.ts");

const face = (id, cadFaceId, nodeIds = [0, 1, 2]) => ({
  id,
  label: `Face ${id}`,
  nodeIds,
  geometry: "face",
  ...(cadFaceId !== undefined ? { cadFaceId } : {}),
});

const contact_ = (id) => contact(id, [face(1, 4)], [face(2, 5)]);
const contact = (id, facesA, facesB) => ({
  id,
  name: `Contact${id}`,
  facesA,
  facesB,
});

describe("a contact on a new mesh", () => {
  const carried = carryGroupsToMesh(
    {
      bcGroups: [],
      loadGroups: [],
      tieGroups: [],
      couplingGroups: [],
      contactGroups: [
        contact(1, [face(1, 1)], [face(2, 2)]),
        contact(2, [face(3, 1)], [face(4)]),
      ],
    },
    [
      [10, 11, 12],
      [20, 21, 22],
    ],
    [1, 2],
    new Set([10, 11, 12, 20, 21, 22]),
  );

  test("both sides on CAD faces: carried to the new mesh's nodes", () => {
    expect(carried.contactGroups).toHaveLength(1);
    expect(carried.contactGroups[0].name).toBe("Contact1");
    expect(carried.contactGroups[0].facesA[0].nodeIds).toEqual([10, 11, 12]);
    expect(carried.contactGroups[0].facesB[0].nodeIds).toEqual([20, 21, 22]);
  });

  test("a side that cannot be carried drops the contact, by name", () => {
    expect(carried.dropped.join(" | ")).toContain("Contact2");
  });
});

describe("a contact in a saved analysis file", () => {
  // The cantilever example, saved again with a contact between two of its
  // faces.
  const example = parseAnalysisFile(
    readFileSync(
      new URL(
        "../../../examples/gallery/site/cantilever-beam.vtu",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  const ids = example.nodes.slice(0, 4).map((node) => node.id);
  const contactGroups = [
    contact(3, [face(1, 4, ids.slice(0, 3))], [face(2, 5, ids.slice(1, 4))]),
  ];

  test("its name, sides and the next id come back", () => {
    const opened = parseAnalysisFile(
      serializeAnalysis({ ...example, contactGroups, nextContactGroupId: 4 }),
    );
    expect(opened.contactGroups).toEqual(contactGroups);
    expect(opened.nextContactGroupId).toBe(4);
  });

  test("a file written before contact existed opens with none", () => {
    expect(example.contactGroups).toEqual([]);
    expect(example.nextContactGroupId).toBe(1);
  });
});

describe("a contact result in a saved analysis file", () => {
  const example = parseAnalysisFile(
    readFileSync(
      new URL(
        "../../../examples/gallery/site/cantilever-beam.vtu",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  const ids = example.nodes.slice(0, 2).map((node) => node.id);
  // The example is saved unsolved; a solve gives it a displacement field.
  const plain = { displacements: new Float64Array(3 * example.nodes.length) };
  const solved = {
    nodeIds: ids,
    pressure: Float64Array.from([12.5, 0]),
    gap: Float64Array.from([0, 0.25]),
    closed: Uint8Array.from([1, 0]),
    area: Float64Array.from([0.5, 0.5]),
    force: 6.25,
    iterations: 3,
  };
  const saved = (result) =>
    serializeAnalysis({
      ...example,
      contactGroups: [contact_(3)],
      nextContactGroupId: 4,
      resultType: "Contact pressure",
      result,
    });

  test("the pressure, gap, touching nodes and force come back", () => {
    const opened = parseAnalysisFile(saved({ ...plain, contact: solved }));
    expect(opened.resultType).toBe("Contact pressure");
    expect(opened.result?.contact).toEqual(solved);
  });

  test("a solve without contact saves none", () => {
    const opened = parseAnalysisFile(saved(plain));
    expect(opened.result?.contact).toBeUndefined();
  });

  test("a contact result naming a node the mesh lacks is refused", () => {
    const text = saved({
      ...plain,
      contact: { ...solved, nodeIds: [ids[0], -77] },
    });
    expect(() => parseAnalysisFile(text)).toThrow(/node -77/);
  });
});

describe("a contact in the solve request", () => {
  test("the model's contacts are its `contacts`", () => {
    const contactGroups = [contact(1, [face(1, 1)], [face(2, 2)])];
    const payload = solvePayload({
      nodes: [],
      elements: [],
      materials: [],
      properties: [],
      constraints: [],
      loads: [],
      surfaceLoads: [],
      temperature: null,
      elementOrder: 1,
      solverMethod: "amg",
      tieGroups: [],
      couplingGroups: [],
      contactGroups,
      surfaceTriangles: null,
      surfaceFaceIds: null,
    });
    expect(payload.contacts).toEqual(contactGroups);
  });
});

describe("a contact result as a field over the mesh", () => {
  const nodes = [
    { id: 7, x: 0, y: 0, z: 0 },
    { id: 8, x: 1, y: 0, z: 0 },
    { id: 9, x: 2, y: 0, z: 0 },
  ];
  const result = {
    displacements: new Float64Array(9),
    contact: {
      nodeIds: [9, 7],
      pressure: Float64Array.from([12.5, 0]),
      gap: Float64Array.from([0, 0.25]),
      closed: Uint8Array.from([1, 0]),
      force: 3,
      iterations: 2,
    },
  };

  test("the pressure on the contact's nodes, zero elsewhere", () => {
    const values = nodalResultValues(
      result,
      "Contact pressure",
      nodes,
      [],
      "top",
    );
    expect(Array.from(values ?? [])).toEqual([0, 0, 12.5]);
  });

  test("1 where a node touches, 0 where it is open or not in contact", () => {
    const values = nodalResultValues(
      result,
      "Contact status",
      nodes,
      [],
      "top",
    );
    expect(Array.from(values ?? [])).toEqual([0, 0, 1]);
  });

  test("a result without contact has no contact field", () => {
    const plain = { displacements: new Float64Array(9) };
    expect(
      nodalResultValues(plain, "Contact pressure", nodes, [], "top"),
    ).toBeNull();
  });
});
