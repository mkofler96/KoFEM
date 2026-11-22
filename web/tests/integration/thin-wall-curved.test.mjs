// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Linear thin-wall check on a curved wall (KOF-312): a tube has no opposite
// planar faces, so only the curved-wall pass can find its wall. The tube is
// written by the gallery's STEP writer and meshed by Netgen with the app
// worker's options, as an imported part would be.

import { beforeAll, describe, expect, test } from "bun:test";
import { annulusStep } from "../../../examples/gallery/step-prism.mjs";
import {
  thinWallFindings,
  thinWallMessage,
} from "../../src/lib/solve/thinWall.ts";
import { loadEngine, loadFem } from "../support/wasm.mjs";

// The store-model view of a Netgen mesh: 1-based node ids, one CTETRA per tet.
function meshTube(engine, rInner, rOuter, length, maxElementSize) {
  engine.tessellate_step(
    new TextEncoder().encode(annulusStep(rInner, rOuter, length, "tube")),
    JSON.stringify({
      deflection_relative: 0.001,
      angular_deflection: 0.5,
      format: "step",
    }),
  );
  const dto = engine.generate_fem_mesh(
    JSON.stringify({
      max_element_size: maxElementSize,
      min_element_size: maxElementSize / 10,
      grading: 0.3,
      second_order: false,
      elementsperedge: 2.0,
      elementspercurve: 2.0,
      optsteps_2d: 3,
      optsteps_3d: 3,
    }),
  );
  if (!dto.tetrahedra) throw new Error("Netgen did not mesh the tube");
  const nodes = [];
  for (let i = 0; i < dto.vertices.length / 3; i++)
    nodes.push({
      id: i + 1,
      x: dto.vertices[3 * i],
      y: dto.vertices[3 * i + 1],
      z: dto.vertices[3 * i + 2],
    });
  const elements = [];
  for (let e = 0; e < dto.tetrahedra.length / 4; e++)
    elements.push({
      id: e + 1,
      type: "CTETRA",
      propertyId: dto.bodyIds[e],
      nodeIds: Array.from(
        dto.tetrahedra.subarray(4 * e, 4 * e + 4),
        (v) => v + 1,
      ),
    });
  const surfaceTriangles = [];
  for (let t = 0; t < dto.surfaceFaceIds.length; t++)
    surfaceTriangles.push(
      Array.from(dto.surfaceTriangles.subarray(3 * t, 3 * t + 3), (v) => v + 1),
    );
  return {
    nodes,
    elements,
    properties: [...new Set(dto.bodyIds)].map((id) => ({ id, materialId: 1 })),
    surfaceTriangles,
    surfaceFaceIds: Array.from(dto.surfaceFaceIds),
    elementOrder: 1,
  };
}

describe("linear thin-wall check on a tube", () => {
  let tube;

  beforeAll(async () => {
    await loadFem();
    // 2 mm wall, 5 mm elements: well under one element through the wall.
    tube = meshTube(await loadEngine(), 20, 22, 60, 5);
  });

  test("coarse tube: the curved wall is flagged", () => {
    const found = thinWallFindings(tube);
    expect(found, JSON.stringify(found)).toHaveLength(1);
  });

  test("coarse tube: thickness is about 2 mm, under 4 elements through", () => {
    const [finding] = thinWallFindings(tube);
    expect(Math.abs(finding.thickness - 2)).toBeLessThan(0.1);
    expect(finding.elementsThrough).toBeLessThan(4);
  });

  test("coarse tube: the advice is quadratic elements or Shell", () => {
    // Shell idealisation collapses curved walls too (KOF-448), so a tube can
    // be set to Shell like a flat wall.
    const [finding] = thinWallFindings(tube);
    expect(finding.curved).toBe(true);
    const message = thinWallMessage(finding);
    expect(message).toContain("quadratic");
    expect(message).toContain("set the body to Shell");
  });

  test("coarse tube, quadratic elements: no finding", () => {
    expect(thinWallFindings({ ...tube, elementOrder: 2 })).toHaveLength(0);
  });
});
