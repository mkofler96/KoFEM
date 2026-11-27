// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// The engine's per-face CAD properties (cad_face_properties, KOF-493) on parts
// with known faces, decoded the way the worker decodes them: each face's
// surface type, its area from the CAD surface (not the display tessellation),
// a plane's outward normal, and a cylinder's or cone's axis and a cylinder's
// radius. Face ids are those tessellate_step reports, as the writers document.

import { beforeAll, describe, expect, test } from "bun:test";
import { plateWithHoleStep } from "../../../examples/gallery/step-prism.mjs";
import {
  arc,
  line,
  revolvedSectorStep,
} from "../../../examples/gallery/step-revolve.mjs";
import { decodeCadFaceProperties } from "../../src/lib/cadFaceProperties.ts";
import { TESSELLATION_OPTIONS } from "../support/step-parts.mjs";
import { loadEngine } from "../support/wasm.mjs";

// Areas are integrals over the exact surface: far tighter than any
// tessellation, whose chords inscribe a curved face by about 1e-3.
const AREA_TOLERANCE = 1e-6;

async function facesOf(step) {
  const engine = await loadEngine();
  engine.tessellate_step(new TextEncoder().encode(step), TESSELLATION_OPTIONS);
  return decodeCadFaceProperties(engine.cad_face_properties());
}

function expectArea(face, area) {
  expect(Math.abs(face.area - area) / area).toBeLessThan(AREA_TOLERANCE);
}

function expectDirection(actual, expected) {
  for (let i = 0; i < 3; i++) expect(actual[i]).toBeCloseTo(expected[i], 9);
}

// An axis has no sign: either way along it is the same axis.
function expectAxis(actual, expected) {
  const dot =
    actual[0] * expected[0] + actual[1] * expected[1] + actual[2] * expected[2];
  expect(Math.abs(dot)).toBeCloseTo(1, 9);
}

describe("plate with a Ø3.2 hole", () => {
  // Faces (step-prism.mjs): 1 y = −b, 2 x = +b, 3 y = +b, 4 x = −b, 5 hole,
  // 6 z = 0, 7 z = t.
  const holeRadius = 1.6;
  const halfWidth = 10;
  const thickness = 4;
  const plateArea =
    4 * halfWidth * halfWidth - Math.PI * holeRadius * holeRadius;
  let faces = [];

  beforeAll(async () => {
    faces = await facesOf(
      plateWithHoleStep(holeRadius, halfWidth, thickness, "Plate with a hole"),
    );
  });

  test("there is one entry per CAD face", () => {
    expect(faces.length).toBe(7);
  });

  test("the top face is a plane of the plate's area facing +Z", () => {
    const top = faces[6];
    expect(top.kind).toBe("plane");
    if (top.kind !== "plane") return;
    expectArea(top, plateArea);
    expectDirection(top.normal, [0, 0, 1]);
  });

  test("the bottom face faces −Z, out of the solid", () => {
    const bottom = faces[5];
    expect(bottom.kind).toBe("plane");
    if (bottom.kind !== "plane") return;
    expectArea(bottom, plateArea);
    expectDirection(bottom.normal, [0, 0, -1]);
  });

  test("a side face faces −Y", () => {
    const side = faces[0];
    expect(side.kind).toBe("plane");
    if (side.kind !== "plane") return;
    expectArea(side, 2 * halfWidth * thickness);
    expectDirection(side.normal, [0, -1, 0]);
  });

  test("the hole is a cylinder of radius 1.6 about Z", () => {
    const hole = faces[4];
    expect(hole.kind).toBe("cylinder");
    if (hole.kind !== "cylinder") return;
    expect(hole.radius).toBeCloseTo(holeRadius, 12);
    expectAxis(hole.axis, [0, 0, 1]);
    expectArea(hole, 2 * Math.PI * holeRadius * thickness);
  });
});

describe("quarter of a revolved frustum ring", () => {
  // Profile (r, z): (10, 0) → (20, 0) → (15, 10) → (10, 10) → (10, 0), swept
  // 90° about +z. Faces (step-revolve.mjs): 1 plane z = 0, 2 cone,
  // 3 plane z = 10, 4 cylinder r = 10, 5 end θ = 0, 6 end θ = 90°.
  const quarter = Math.PI / 2;
  let faces = [];

  beforeAll(async () => {
    faces = await facesOf(
      revolvedSectorStep(
        [[line([20, 0]), line([15, 10]), line([10, 10]), line([10, 0])]],
        90,
        "Frustum ring",
      ),
    );
  });

  test("the sloped face is a cone about Z", () => {
    const cone = faces[1];
    expect(cone.kind).toBe("cone");
    if (cone.kind !== "cone") return;
    expectAxis(cone.axis, [0, 0, 1]);
    // Lateral area of a frustum sector: sweep/2 · (r1 + r2) · slant length.
    expectArea(cone, (quarter / 2) * (20 + 15) * Math.hypot(5, 10));
  });

  test("the inner face is a cylinder of radius 10 about Z", () => {
    const inner = faces[3];
    expect(inner.kind).toBe("cylinder");
    if (inner.kind !== "cylinder") return;
    expect(inner.radius).toBeCloseTo(10, 12);
    expectAxis(inner.axis, [0, 0, 1]);
    expectArea(inner, quarter * 10 * 10);
  });

  test("the planar end θ = 0 faces −Y with the profile's area", () => {
    const end = faces[4];
    expect(end.kind).toBe("plane");
    if (end.kind !== "plane") return;
    expectDirection(end.normal, [0, -1, 0]);
    expectArea(end, ((10 + 5) / 2) * 10);
  });
});

describe("a sphere sector", () => {
  test("a spherical face is another surface, with its area", async () => {
    // Profile (r, z): a quarter disc of radius 10 on the axis, swept 90°:
    // face 1 the plane z = 0, face 2 the octant of the sphere (the segment on
    // the axis sweeps no face), then the two ends.
    const faces = await facesOf(
      revolvedSectorStep(
        [[line([10, 0]), arc([0, 10], [0, 0], true), line([0, 0])]],
        90,
        "Sphere octant",
      ),
    );
    const sphere = faces[1];
    expect(sphere.kind).toBe("other");
    // One eighth of the sphere's 4πr².
    expectArea(sphere, (4 * Math.PI * 100) / 8);
  });
});
