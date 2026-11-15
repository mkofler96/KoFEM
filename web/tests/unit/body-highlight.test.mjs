// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Unit tests for src/lib/bodyHighlight.ts — resolving a hovered Bodies-panel
// row to the CAD body the geometry view can highlight.
//
// The viewport expresses a highlight as "dim every body except this one", so an
// id that no tessellated body carries fades the whole assembly to 15 % opacity
// and the model reads as gone. The resolver is what keeps that from happening:
// a mesh-time PSHELL resolves back to the body it was idealised from, and
// anything still unmatched resolves to null (highlight nothing) rather than to
// an id nobody has.

import { describe, expect, test } from "bun:test";
import {
  resolveHighlightedBody,
  tessellationBodyIds,
} from "../../src/lib/bodyHighlight.ts";

// Two CAD bodies; body 2 is thin-walled and was idealised at mesh time, which
// appended PSHELL id 3 (the fin_two_parts.step shape of the model).
const tessellation = {
  points: [
    [0, 0, 0],
    [1, 0, 0],
    [0, 1, 0],
  ],
  triangles: [
    [0, 1, 2],
    [0, 1, 2],
  ],
  bodyIds: [1, 2],
};
const properties = [
  { id: 1, materialId: 1, discretization: "solid" },
  { id: 2, materialId: 1, discretization: "shell" },
  {
    id: 3,
    materialId: 1,
    thickness: 2,
    discretization: "shell",
    sourceBodyId: 2,
  },
];

describe("tessellationBodyIds", () => {
  test("tessellation body ids come from bodyIds", () => {
    expect([...tessellationBodyIds(tessellation)].sort()).toEqual([1, 2]);
  });

  test("a tessellation saved before per-body ids is all body 1", () => {
    expect([
      ...tessellationBodyIds({ ...tessellation, bodyIds: undefined }),
    ]).toEqual([1]);
  });

  test("no tessellation → no bodies", () => {
    expect(tessellationBodyIds(null).size).toBe(0);
  });
});

describe("resolveHighlightedBody", () => {
  test("a CAD body resolves to itself", () => {
    expect(resolveHighlightedBody(1, properties, tessellation)).toBe(1);
  });

  test("a derived PSHELL resolves to the body it was idealised from", () => {
    expect(resolveHighlightedBody(3, properties, tessellation)).toBe(2);
  });

  test("nothing hovered → nothing highlighted", () => {
    expect(resolveHighlightedBody(null, properties, tessellation)).toBeNull();
  });

  test("a property the tessellation has no body for highlights nothing", () => {
    // Without sourceBodyId the PSHELL id must not be treated as a body id.
    expect(
      resolveHighlightedBody(
        3,
        [...properties.slice(0, 2), { id: 3, materialId: 1, thickness: 2 }],
        tessellation,
      ),
    ).toBeNull();
  });

  test("a mesh with no CAD geometry behind it highlights nothing", () => {
    expect(resolveHighlightedBody(1, properties, null)).toBeNull();
  });

  test("an empty tessellation highlights nothing", () => {
    expect(
      resolveHighlightedBody(1, properties, {
        ...tessellation,
        triangles: [],
        bodyIds: [],
      }),
    ).toBeNull();
  });
});
