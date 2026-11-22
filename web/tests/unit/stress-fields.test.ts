// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Stress components and principal stresses as result fields (KOF-447): one
// value per element from the solve's tensors, on the chosen shell surface,
// averaged to the nodes as von Mises is, so the colours, the legend, the
// probes and the hand check read the same numbers.

import { describe, expect, test } from "bun:test";
import {
  computeResultRange,
  nodalResultValues,
  resultFieldSymbol,
  resultUnit,
} from "../../src/lib/resultField";
import { readProbes } from "../../src/lib/resultProbe";
import {
  STRESS_FIELDS,
  type ElementStress,
  type SolverResult,
} from "../../src/store/resultsSlice";
import { principalStresses } from "../../src/lib/stressFields";
import type { Element, Node } from "../../src/store/modelStore";

const nodes: Node[] = [
  { id: 1, x: 0, y: 0, z: 0 },
  { id: 2, x: 1, y: 0, z: 0 },
  { id: 3, x: 0, y: 1, z: 0 },
  { id: 4, x: 1, y: 1, z: 0 },
];
// Two shell facets of equal area sharing the edge 2–3.
const elements: Element[] = [
  { id: 1, type: "CTRIA3", nodeIds: [1, 2, 3], propertyId: 1 },
  { id: 2, type: "CTRIA3", nodeIds: [2, 4, 3], propertyId: 1 },
];

// σxx σyy σzz τxy τyz τzx per facet corner; `uniform` gives every corner of a
// facet its facet's tensor (in principal axes or with a shear).
const uniform = (...facets: number[][]) =>
  Float64Array.from(facets.flatMap((t) => [...t, ...t, ...t]));
const stress: ElementStress = {
  top: uniform([11, 0, -1, 0, 0, 0], [31, 0, -2, 0, 0, 0]),
  middle: uniform([5, 0, 0, 0, 0, 0], [15, 0, 0, 0, 0, 0]),
  bottom: uniform([0, -1, 0, -2, 0, 0], [0, -3, 0, -4, 0, 0]),
};
const result: SolverResult = {
  displacements: new Float64Array(12),
  vonMises: Float64Array.from([1, 2]),
  stress,
};

describe("stress fields", () => {
  test("lists every component and both extreme principal stresses", () => {
    expect(STRESS_FIELDS).toEqual([
      "Normal stress σxx",
      "Normal stress σyy",
      "Normal stress σzz",
      "Shear stress τxy",
      "Shear stress τyz",
      "Shear stress τzx",
      "Max principal stress σ1",
      "Min principal stress σ3",
    ]);
    for (const field of STRESS_FIELDS) expect(resultUnit(field)).toBe("MPa");
    expect(resultFieldSymbol("Normal stress σyy")).toBe("σyy");
    expect(resultFieldSymbol("Max principal stress σ1")).toBe("σ1");
  });

  test("averages a component to the nodes on the chosen surface", () => {
    const top = nodalResultValues(
      result,
      "Normal stress σxx",
      nodes,
      elements,
      "top",
    )!;
    // Node 1 is on facet 1 only, node 4 on facet 2 only, nodes 2 and 3 on both.
    expect([...top]).toEqual([11, 21, 21, 31]);
    const middle = nodalResultValues(
      result,
      "Normal stress σxx",
      nodes,
      elements,
      "middle",
    )!;
    expect([...middle]).toEqual([5, 10, 10, 15]);
    expect([
      ...nodalResultValues(
        result,
        "Shear stress τxy",
        nodes,
        elements,
        "bottom",
      )!,
    ]).toEqual([-2, -3, -3, -4]);
  });

  test("averages each element's principal stresses to the nodes", () => {
    expect([
      ...nodalResultValues(
        result,
        "Max principal stress σ1",
        nodes,
        elements,
        "top",
      )!,
    ]).toEqual([11, 21, 21, 31]);
    const range = computeResultRange(
      result,
      "Min principal stress σ3",
      nodes,
      elements,
      "bottom",
    )!;
    // Facet 1 bottom: [[0, −2], [−2, −1]] in x, y; facet 2: [[0, −4], [−4, −3]].
    expect(range.min).toBeCloseTo((-3 - Math.sqrt(73)) / 2, 12);
    expect(range.max).toBeCloseTo((-1 - Math.sqrt(17)) / 2, 12);
  });

  test("averages each node over the element corners at it", () => {
    // Facet 1's corners at nodes 1, 2, 3 read 1, 2, 3; facet 2's at 2, 4, 3
    // read 4, 5, 6 (σxx only).
    const corner = (v: number) => [v, 0, 0, 0, 0, 0];
    const tensors = Float64Array.from(
      [1, 2, 3, 4, 5, 6].flatMap((v) => corner(v)),
    );
    const cornered: SolverResult = {
      displacements: new Float64Array(12),
      stress: { top: tensors, middle: tensors, bottom: tensors },
    };
    expect([
      ...nodalResultValues(
        cornered,
        "Normal stress σxx",
        nodes,
        elements,
        "middle",
      )!,
    ]).toEqual([1, (2 + 4) / 2, (3 + 6) / 2, 5]);
  });

  test("leaves von Mises and the displacements independent of the surface", () => {
    for (const s of ["top", "middle", "bottom"] as const)
      expect([
        ...nodalResultValues(result, "Von Mises stress", nodes, elements, s)!,
      ]).toEqual([1, 1.5, 1.5, 2]);
  });

  test("is null for a stress field when the result carries no tensors", () => {
    expect(
      nodalResultValues(
        { displacements: new Float64Array(12) },
        "Normal stress σyy",
        nodes,
        elements,
        "top",
      ),
    ).toBeNull();
  });

  test("refuses tensors of another mesh", () => {
    const stale: SolverResult = {
      displacements: new Float64Array(12),
      stress: {
        top: uniform([1, 2, 3, 4, 5, 6]),
        middle: uniform([1, 2, 3, 4, 5, 6]),
        bottom: uniform([1, 2, 3, 4, 5, 6]),
      },
    };
    expect(() =>
      nodalResultValues(stale, "Normal stress σxx", nodes, elements, "top"),
    ).toThrow(/3 element corners for a mesh of 6/);
  });

  test("a probe reads the component at its point", () => {
    const [reading] = readProbes(
      [{ id: 1, point: [0, 0, 0], triangle: [1, 2, 3] }],
      {
        nodes,
        elements,
        result,
        surfaceTriangles: [],
        surfaceFaceIds: [],
      },
      "Normal stress σyy",
      "top",
    );
    expect(reading).toMatchObject({ kind: "value", value: 0 });
  });
});

describe("principalStresses", () => {
  const of = (t: number[]) => principalStresses(Float64Array.from(t), 0);

  test("sorts a diagonal tensor's entries", () => {
    const [s1, s2, s3] = of([5, -2, 7, 0, 0, 0]);
    expect(s1).toBeCloseTo(7, 12);
    expect(s2).toBeCloseTo(5, 12);
    expect(s3).toBeCloseTo(-2, 12);
  });

  test("gives ±τ for pure shear", () => {
    const [s1, s2, s3] = of([0, 0, 0, 4, 0, 0]);
    expect(s1).toBeCloseTo(4, 12);
    expect(s2).toBeCloseTo(0, 12);
    expect(s3).toBeCloseTo(-4, 12);
  });

  test("keeps the three invariants of a general tensor", () => {
    const [sx, sy, sz, txy, tyz, tzx] = [10, -3, 2, 4, -1.5, 2.5];
    const [s1, s2, s3] = of([sx, sy, sz, txy, tyz, tzx]);
    expect(s1 >= s2 && s2 >= s3).toBe(true);
    expect(s1 + s2 + s3).toBeCloseTo(sx + sy + sz, 9);
    expect(s1 * s2 + s2 * s3 + s3 * s1).toBeCloseTo(
      sx * sy + sy * sz + sz * sx - txy * txy - tyz * tyz - tzx * tzx,
      9,
    );
    expect(s1 * s2 * s3).toBeCloseTo(
      sx * sy * sz +
        2 * txy * tyz * tzx -
        sx * tyz * tyz -
        sy * tzx * tzx -
        sz * txy * txy,
      8,
    );
  });

  test("reads the tensor at its offset", () => {
    const [s1] = principalStresses(
      Float64Array.from([0, 0, 0, 0, 0, 0, 9, 0, 0, 0, 0, 0]),
      6,
    );
    expect(s1).toBeCloseTo(9, 12);
  });
});
