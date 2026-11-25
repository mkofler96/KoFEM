// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// The pre-flight warning for a nearly incompressible material on linear
// elements (KOF-400): linear tetrahedra lock when ν is close to ½ and return a
// result far too stiff (−43 % on the nearly incompressible Cook's membrane,
// /examples/cooks-membrane-incompressible/). The warning names each solid body
// meshed with linear elements whose material has ν above 0.45, and stays quiet
// for quadratic elements, shells and suppressed bodies.

import { describe, expect, test } from "bun:test";
import {
  INCOMPRESSIBLE_POISSON,
  incompressibleFindings,
  incompressibleMessage,
} from "../../src/lib/solve/incompressible";
import type {
  Element,
  Material,
  Property,
} from "../../src/workers/solverTypes";

const material = (id: number, poisson: number): Material => ({
  id,
  name: `Material ${id}`,
  young: 1000,
  poisson,
  density: 1e-9,
});

const tet = (id: number, propertyId: number): Element => ({
  id,
  type: "CTETRA",
  nodeIds: [1, 2, 3, 4],
  propertyId,
});

const rubber = material(1, 0.4999);
const steel = material(2, 0.3);

describe("incompressibleFindings", () => {
  test("the threshold is ν = 0.45", () => {
    expect(INCOMPRESSIBLE_POISSON).toBe(0.45);
  });

  test("a linear solid body of a nearly incompressible material is flagged", () => {
    const findings = incompressibleFindings({
      elements: [tet(1, 1)],
      properties: [{ id: 1, materialId: 1 }],
      materials: [rubber],
      elementOrder: 1,
    });
    expect(findings).toEqual([{ bodyId: 1, poisson: 0.4999 }]);
  });

  test("quadratic elements do not lock this way: no warning", () => {
    expect(
      incompressibleFindings({
        elements: [tet(1, 1)],
        properties: [{ id: 1, materialId: 1 }],
        materials: [rubber],
        elementOrder: 2,
      }),
    ).toEqual([]);
  });

  test("ν at or below 0.45 is not flagged, just above it is", () => {
    const at = (poisson: number) =>
      incompressibleFindings({
        elements: [tet(1, 1)],
        properties: [{ id: 1, materialId: 1 }],
        materials: [material(1, poisson)],
        elementOrder: 1,
      });
    expect(at(0.3)).toEqual([]);
    expect(at(0.45)).toEqual([]);
    expect(at(0.46)).toEqual([{ bodyId: 1, poisson: 0.46 }]);
  });

  test("only the bodies with the soft material are named", () => {
    const findings = incompressibleFindings({
      elements: [tet(1, 1), tet(2, 2), tet(3, 3)],
      properties: [
        { id: 1, materialId: 2 },
        { id: 2, materialId: 1 },
        { id: 3, materialId: 1 },
      ],
      materials: [rubber, steel],
      elementOrder: 1,
    });
    expect(findings.map((f) => f.bodyId)).toEqual([2, 3]);
  });

  test("shell, suppressed and unmeshed bodies are not flagged", () => {
    const properties: Property[] = [
      { id: 1, materialId: 1, discretization: "shell" },
      { id: 2, materialId: 1, suppressed: true },
      { id: 3, materialId: 1 },
    ];
    expect(
      incompressibleFindings({
        elements: [
          { id: 1, type: "CTRIA3", nodeIds: [1, 2, 3], propertyId: 1 },
        ],
        properties,
        materials: [rubber],
        elementOrder: 1,
      }),
    ).toEqual([]);
  });
});

test("the message names the body and ν and points to quadratic elements", () => {
  expect(incompressibleMessage({ bodyId: 2, poisson: 0.4999 })).toBe(
    "Nearly incompressible material on body 2 (ν = 0.4999): linear elements lock and give results far too stiff. Use quadratic elements (Mesh panel).",
  );
});
