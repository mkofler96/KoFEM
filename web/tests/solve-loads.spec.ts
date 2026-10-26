// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

import { test, expect } from "@playwright/test";
import { coupledLoads, shellPointLoads } from "../src/lib/solveLoads";
import type { SurfaceLoad } from "../src/store/boundarySlice";

// The right half of a 4 x 2 rectangle is refined more than the left half.
// Equal nodal shares put the resultant at x=15/7 instead of the area centroid x=2.
const positions: [number, number, number][] = [
  [0, 0, 0],
  [2, 0, 0],
  [4, 0, 0],
  [0, 2, 0],
  [2, 2, 0],
  [4, 2, 0],
  [3, 1, 0],
];
const coarse = [
  [0, 1, 4],
  [0, 4, 3],
  [1, 2, 5],
  [1, 5, 4],
];
const graded = [
  [0, 1, 4],
  [0, 4, 3],
  [1, 2, 6],
  [2, 5, 6],
  [5, 4, 6],
  [4, 1, 6],
];
const posOf = (nodeId: number) => positions[nodeId - 100];
const facesWithIds = (faces: number[][]) =>
  faces.map((f) => f.map((n) => n + 100));
const poolOf = (nodeId: number) => nodeId - 100;
const noRef = () => false;

function resultant(load: ReturnType<typeof coupledLoads>) {
  const force = [0, 0, 0];
  const moment = [0, 0, 0];
  load.load_dofs.forEach((dof, index) => {
    const component = dof % 6;
    const value = load.load_vals[index];
    if (component > 2) {
      moment[component - 3] += value;
      return;
    }
    force[component] += value;
    const [px, py, pz] = positions[Math.floor(dof / 6)];
    if (component === 0) {
      moment[1] += pz * value;
      moment[2] -= py * value;
    }
    if (component === 1) {
      moment[0] -= pz * value;
      moment[2] += px * value;
    }
    if (component === 2) {
      moment[0] += py * value;
      moment[1] -= px * value;
    }
  });
  return { force, moment };
}

function checkVector(got: number[], expected: number[]) {
  expected.forEach((value, index) => expect(got[index]).toBeCloseTo(value, 10));
}

test("graded facets preserve total force and area-centroid moment after refinement", () => {
  for (const faces of [coarse, graded]) {
    const load: SurfaceLoad = {
      type: "force",
      force: [0, 0, -120],
      faces: facesWithIds(faces),
    };
    const coupled = coupledLoads([], [load], poolOf, noRef, posOf);
    checkVector(resultant(coupled).force, [0, 0, -120]);
    checkVector(resultant(coupled).moment, [-120, 240, 0]);
    // Both entry points must hand their respective engines the same forces.
    const shell = shellPointLoads([], [load], posOf, poolOf);
    for (const { vertex, force } of shell) {
      for (let component = 0; component < 3; component++) {
        const at = coupled.load_dofs.indexOf(6 * vertex + component);
        expect(at < 0 ? 0 : coupled.load_vals[at]).toBeCloseTo(
          force![component],
          10,
        );
      }
    }
  }
});

test("traction scales with area and pressure follows facet winding", () => {
  for (const faces of [coarse, graded]) {
    const selection = facesWithIds(faces);
    const traction = coupledLoads(
      [],
      [{ type: "traction", force: [0, 0, -15], faces: selection }],
      poolOf,
      noRef,
      posOf,
    );
    checkVector(resultant(traction).force, [0, 0, -120]);
    checkVector(resultant(traction).moment, [-120, 240, 0]);
    for (const sign of [1, -1]) {
      const pressure = coupledLoads(
        [],
        [
          {
            type: "pressure",
            pressure: 15,
            faces:
              sign === 1 ? selection : selection.map((f) => [...f].reverse()),
          },
        ],
        poolOf,
        noRef,
        posOf,
      );
      checkVector(resultant(pressure).force, [0, 0, -120 * sign]);
      checkVector(resultant(pressure).moment, [-120 * sign, 240 * sign, 0]);
    }
  }
});

test("unequal edges share total force by length and preserve its line of action", () => {
  const edgePositions: [number, number, number][] = [
    [0, 0, 0],
    [1, 0, 0],
    [4, 0, 0],
  ];
  const load = coupledLoads(
    [],
    [
      {
        type: "force",
        force: [0, 8, 0],
        faces: [
          [100, 101],
          [101, 102],
        ],
      },
    ],
    poolOf,
    noRef,
    (nodeId) => edgePositions[poolOf(nodeId)],
  );
  expect(load.load_dofs).toEqual([1, 7, 13]);
  expect(load.load_vals).toEqual([1, 4, 3]);
  expect(
    load.load_vals.reduce(
      (sum, value, index) => sum + edgePositions[index][0] * value,
      0,
    ),
  ).toBe(16);
});

test("surface loads superpose with point forces and reference-point moments after pool remapping", () => {
  const load: SurfaceLoad = {
    type: "force",
    force: [0, 0, -12],
    faces: [[100, 101, 104]],
  };
  const mapped = coupledLoads(
    [
      { nodeId: 100, dof: 2, value: 5 },
      { nodeId: 101, dof: 5, value: 7 },
      { nodeId: 104, dof: 5, value: 99 },
    ],
    [load, load],
    (nodeId) => (nodeId === 104 ? 0 : poolOf(nodeId)),
    (pi) => pi === 1,
    posOf,
  );
  const sumAt = (dof: number) =>
    mapped.load_dofs.reduce(
      (sum, candidate, index) =>
        sum + (candidate === dof ? mapped.load_vals[index] : 0),
      0,
    );
  expect(sumAt(2)).toBe(-11);
  expect(sumAt(8)).toBe(-8);
  expect(sumAt(11)).toBe(7);
  expect(sumAt(5)).toBe(0);
});

for (const [label, load, error] of [
  [
    "empty",
    { type: "force", force: [0, 1, 0], faces: [] },
    /no faces or edges/,
  ],
  [
    "mixed area and length",
    {
      type: "force",
      force: [0, 1, 0],
      faces: [
        [100, 101, 104],
        [100, 101],
      ],
    },
    /both faces and edges/,
  ],
  [
    "pressure on mixed selection",
    {
      type: "pressure",
      pressure: 1,
      faces: [
        [100, 101, 104],
        [100, 101],
      ],
    },
    /cannot act on an edge/,
  ],
  [
    "edge traction",
    { type: "traction", force: [0, 1, 0], faces: [[100, 101]] },
    /cannot act on an edge/,
  ],
  [
    "degenerate",
    { type: "force", force: [0, 1, 0], faces: [[100, 101, 102]] },
    /zero total area/,
  ],
  [
    "missing pressure",
    { type: "pressure", faces: [[100, 101, 104]] },
    /no magnitude/,
  ],
] as [string, SurfaceLoad, RegExp][]) {
  test(`invalid surface selection fails loudly: ${label}`, () => {
    expect(() => coupledLoads([], [load], poolOf, noRef, posOf)).toThrow(error);
  });
}
