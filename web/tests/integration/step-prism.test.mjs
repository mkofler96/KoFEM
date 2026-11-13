// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Checks the STEP writers of step-prism.mjs against the real engine, through the
// calls the app makes on import and mesh (web/src/workers/solver.worker.ts):
//
//   - tessellate_step (OCCT import) gives one body and the expected faces, and
//     every CAD face id is the face the writer documents: each display triangle
//     of face k lies on face k's surface, and face k's tessellated area matches
//     its analytic area;
//   - generate_fem_mesh (Netgen, the worker's options) gives a tet mesh with one
//     body, consistently oriented tets, every CAD face meshed on its surface, and
//     a total volume within 0.5 % of the analytic volume;
//   - prismStep still writes byte-identical files, and invalid profiles throw;
//   - product names are escaped as ISO 10303-21 strings (an apostrophe written
//     twice), and such a file still imports.

import { createHash } from "node:crypto";
import { beforeAll, describe, expect, test } from "bun:test";
import {
  annulusStep,
  arc,
  circleLoop,
  extrudedProfileStep,
  line,
  plateWithHoleStep,
  prismStep,
  profileArea,
  quarterStripWithHoleStep,
  stepString,
} from "../../../examples/gallery/step-prism.mjs";
import { loadEngine } from "../support/wasm.mjs";

const TESSELLATION_OPTIONS = JSON.stringify({
  deflection_relative: 0.001,
  angular_deflection: 0.5,
  format: "step",
});

// ── prismStep is unchanged ────────────────────────────────────────────────────
// SHA-256 of prismStep's output before the profile writer was added; the
// gallery generators and Playwright specs import files written by it.
test("prismStep output is byte-identical", () => {
  const prismHash = createHash("sha256")
    .update(
      prismStep(
        [
          [0, 0],
          [1000, 0],
          [1000, 100],
          [0, 100],
        ],
        100,
        "Cantilever beam",
      ),
    )
    .digest("hex");
  expect(prismHash).toBe(
    "a9bbfe78262f0b91fd796ba0d9bd741ee8f35ac325b19385ab028536a9c94d37",
  );
});

// ── Invalid profiles throw ────────────────────────────────────────────────────
describe("invalid profiles", () => {
  const square = [line([1, 0]), line([1, 1]), line([0, 1]), line([0, 0])];

  test("clockwise outer loop is rejected", () => {
    expect(() =>
      extrudedProfileStep({ outer: [...square].reverse(), holes: [] }, 1, "x"),
    ).toThrow(/counter-clockwise/);
  });

  test("counter-clockwise hole is rejected", () => {
    expect(() =>
      extrudedProfileStep(
        { outer: square, holes: [circleLoop([0.5, 0.5], 0.2, true)] },
        1,
        "x",
      ),
    ).toThrow(/clockwise/);
  });

  test("arc with unequal end radii is rejected", () => {
    expect(() =>
      extrudedProfileStep(
        {
          outer: [line([2, 0]), arc([0, 1], [0, 0], true), line([0, 0])],
          holes: [],
        },
        1,
        "x",
      ),
    ).toThrow(/radius/);
  });

  test("non-positive depth is rejected", () => {
    expect(() =>
      extrudedProfileStep({ outer: square, holes: [] }, 0, "x"),
    ).toThrow(/depth/);
  });
});

// ── Product names are escaped as ISO 10303-21 strings ────────────────────────
// An apostrophe inside a string is written twice ('Cook''s membrane'); the
// file still imports as the one solid it describes.
describe("STEP string escaping", () => {
  const step = prismStep(
    [
      [0, 0],
      [48, 44],
      [48, 60],
      [0, 44],
    ],
    1,
    "Cook's membrane",
  );

  test("an apostrophe in the product name is written twice in every string", () => {
    const named = step.split("\n").filter((row) => row.includes("Cook"));
    expect(named).toHaveLength(4);
    for (const row of named) expect(row).toContain("'Cook''s membrane'");
    expect(step).not.toMatch(/[^']'s membrane/);
  });

  describe("import", () => {
    let tess;

    beforeAll(async () => {
      const engine = await loadEngine();
      tess = engine.tessellate_step(
        new TextEncoder().encode(step),
        TESSELLATION_OPTIONS,
      );
    });

    test("a product name with an apostrophe imports: one body, six CAD faces", () => {
      expect(tess.bodyCount).toBe(1);
      expect(new Set(tess.triangleFaceIds).size).toBe(6);
    });
  });

  test("a backslash in a STEP string is written twice", () => {
    expect(stepString("a\\b's")).toBe("a\\\\b''s");
  });

  test("a name outside printable ASCII is rejected, not mis-encoded", () => {
    expect(() => stepString("Träger")).toThrow(/"ä" is not printable ASCII/);
  });
});

// ── The engine ────────────────────────────────────────────────────────────────

/**
 * @typedef {object} ExpectedFace
 * @property {string} label
 * @property {(x: number, y: number, z: number) => number} distance  0 on the face's surface
 * @property {number} area  analytic face area (mm²)
 */

/**
 * Import `step`, mesh it and check both against the analytic part.
 *
 * @param {string} label
 * @param {string} step
 * @param {ExpectedFace[]} faces  in CAD face id order (id = index + 1)
 * @param {number} volume         analytic volume (mm³)
 * @param {number} size           extent of the part (mm), for tolerances
 * @param {number} maxElementSize the mesh size to check the volume at (mm)
 */
function describePart(label, step, faces, volume, size, maxElementSize) {
  // Float32 display vertices: allow a few ulps of the part's size.
  const tolerance = 4e-6 * size;

  describe(label, () => {
    let tess;
    let worst;
    let area;
    let dto;

    beforeAll(async () => {
      const engine = await loadEngine();
      tess = engine.tessellate_step(
        new TextEncoder().encode(step),
        TESSELLATION_OPTIONS,
      );
      const points = tess.vertices;
      const triangles = tess.triangles;
      const faceIds = tess.triangleFaceIds;
      worst = faces.map(() => 0);
      area = faces.map(() => 0);
      for (let triangle = 0; triangle < faceIds.length; triangle++) {
        const faceIndex = faceIds[triangle] - 1;
        if (!faces[faceIndex]) continue;
        const corners = [0, 1, 2].map((corner) => {
          const vertex = triangles[3 * triangle + corner];
          return [
            points[3 * vertex],
            points[3 * vertex + 1],
            points[3 * vertex + 2],
          ];
        });
        for (const [coordX, coordY, coordZ] of corners)
          worst[faceIndex] = Math.max(
            worst[faceIndex],
            Math.abs(faces[faceIndex].distance(coordX, coordY, coordZ)),
          );
        const edgeA = [0, 1, 2].map(
          (axis) => corners[1][axis] - corners[0][axis],
        );
        const edgeB = [0, 1, 2].map(
          (axis) => corners[2][axis] - corners[0][axis],
        );
        area[faceIndex] +=
          Math.hypot(
            edgeA[1] * edgeB[2] - edgeA[2] * edgeB[1],
            edgeA[2] * edgeB[0] - edgeA[0] * edgeB[2],
            edgeA[0] * edgeB[1] - edgeA[1] * edgeB[0],
          ) / 2;
      }

      // Mesh with the app worker's exact options.
      dto = engine.generate_fem_mesh(
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
    });

    test("one body", () => {
      expect(tess.bodyCount).toBe(1);
    });

    test(`${faces.length} CAD faces`, () => {
      const ids = [...new Set(tess.triangleFaceIds)].sort(
        (left, right) => left - right,
      );
      expect(ids).toEqual(faces.map((_, index) => index + 1));
    });

    test.each(faces.map((face, index) => [index + 1, face.label, index]))(
      "face %d is %s",
      (_id, _label, index) => {
        expect(
          worst[index],
          `max distance ${worst[index].toExponential(2)} mm`,
        ).toBeLessThanOrEqual(tolerance);
      },
    );

    // Display tessellation inscribes curved faces; a coarse chord loses ~1 %.
    test.each(faces.map((face, index) => [index + 1, face.label, index]))(
      "face %d (%s) has its analytic area",
      (_id, _label, index) => {
        const relative = area[index] / faces[index].area - 1;
        expect(
          Math.abs(relative),
          `${(relative * 100).toFixed(3)} %`,
        ).toBeLessThan(0.02);
      },
    );

    test("tets consistently oriented, none degenerate", () => {
      const verts = dto.vertices;
      const tetNodes = dto.tetrahedra;
      const tetCount = tetNodes.length / 4;
      let positive = 0;
      let degenerate = 0;
      for (let element = 0; element < tetCount; element++) {
        const corners = [0, 1, 2, 3].map((corner) => {
          const vertex = tetNodes[4 * element + corner];
          return [
            verts[3 * vertex],
            verts[3 * vertex + 1],
            verts[3 * vertex + 2],
          ];
        });
        const edgeA = [0, 1, 2].map(
          (axis) => corners[1][axis] - corners[0][axis],
        );
        const edgeB = [0, 1, 2].map(
          (axis) => corners[2][axis] - corners[0][axis],
        );
        const edgeC = [0, 1, 2].map(
          (axis) => corners[3][axis] - corners[0][axis],
        );
        const det =
          edgeA[0] * (edgeB[1] * edgeC[2] - edgeB[2] * edgeC[1]) -
          edgeA[1] * (edgeB[0] * edgeC[2] - edgeB[2] * edgeC[0]) +
          edgeA[2] * (edgeB[0] * edgeC[1] - edgeB[1] * edgeC[0]);
        if (det > 0) positive++;
        if (Math.abs(det) < 1e-12 * size ** 3) degenerate++;
      }
      const detail = `${tetCount} tets, ${positive} positive, ${degenerate} degenerate`;
      expect(tetCount, detail).toBeGreaterThan(0);
      expect(positive === 0 || positive === tetCount, detail).toBe(true);
      expect(degenerate, detail).toBe(0);
    });

    test("one body in the mesh", () => {
      expect(Array.from(dto.bodyIds).every((body) => body === 1)).toBe(true);
    });

    test(`mesh volume within 0.5 % (h = ${maxElementSize} mm)`, () => {
      const verts = dto.vertices;
      const tetNodes = dto.tetrahedra;
      const tetCount = tetNodes.length / 4;
      let sum = 0;
      for (let element = 0; element < tetCount; element++) {
        const corners = [0, 1, 2, 3].map((corner) => {
          const vertex = tetNodes[4 * element + corner];
          return [
            verts[3 * vertex],
            verts[3 * vertex + 1],
            verts[3 * vertex + 2],
          ];
        });
        const edgeA = [0, 1, 2].map(
          (axis) => corners[1][axis] - corners[0][axis],
        );
        const edgeB = [0, 1, 2].map(
          (axis) => corners[2][axis] - corners[0][axis],
        );
        const edgeC = [0, 1, 2].map(
          (axis) => corners[3][axis] - corners[0][axis],
        );
        sum +=
          (edgeA[0] * (edgeB[1] * edgeC[2] - edgeB[2] * edgeC[1]) -
            edgeA[1] * (edgeB[0] * edgeC[2] - edgeB[2] * edgeC[0]) +
            edgeA[2] * (edgeB[0] * edgeC[1] - edgeB[1] * edgeC[0])) /
          6;
      }
      const volumeError = Math.abs(sum) / volume - 1;
      expect(
        Math.abs(volumeError),
        `${(volumeError * 100).toFixed(4)} %, ${tetCount} tets`,
      ).toBeLessThan(0.005);
    });

    // The Netgen surface mesh keeps the same face ids on the same surfaces.
    test("mesh surface triangles lie on their CAD faces", () => {
      const verts = dto.vertices;
      const surface = dto.surfaceTriangles;
      const surfaceFaces = dto.surfaceFaceIds;
      const meshIds = [...new Set(surfaceFaces)];
      let off = 0;
      for (let triangle = 0; triangle < surfaceFaces.length; triangle++) {
        const face = faces[surfaceFaces[triangle] - 1];
        if (!face) {
          off = Infinity;
          continue;
        }
        for (let corner = 0; corner < 3; corner++) {
          const vertex = surface[3 * triangle + corner];
          off = Math.max(
            off,
            Math.abs(
              face.distance(
                verts[3 * vertex],
                verts[3 * vertex + 1],
                verts[3 * vertex + 2],
              ),
            ),
          );
        }
      }
      const detail = `${meshIds.length} faces, max distance ${off.toExponential(2)} mm`;
      expect(meshIds.length, detail).toBe(faces.length);
      expect(off, detail).toBeLessThanOrEqual(tolerance);
    });
  });
}

/** Distance helpers: 0 on the surface. */
const onX = (/** @type {number} */ offset) => (/** @type {number} */ coordX) =>
  coordX - offset;
const onY =
  (/** @type {number} */ offset) =>
  /** @type {(x: number, y: number) => number} */ (_x, coordY) =>
    coordY - offset;
const onZ =
  (/** @type {number} */ offset) =>
  /** @type {(x: number, y: number, z: number) => number} */ (_x, _y, coordZ) =>
    coordZ - offset;
const onRadius =
  (
    /** @type {number} */ radius,
    /** @type {number} */ centerX = 0,
    /** @type {number} */ centerY = 0,
  ) =>
  /** @type {(x: number, y: number) => number} */ (coordX, coordY) =>
    Math.hypot(coordX - centerX, coordY - centerY) - radius;

// ── Hollow shaft (examples/validation/cases/shaft-torsion.mjs) ────────────────
{
  const innerRadius = 30;
  const outerRadius = 50;
  const length = 500;
  const sectionArea = Math.PI * (outerRadius ** 2 - innerRadius ** 2);
  describePart(
    "annulusStep",
    annulusStep(innerRadius, outerRadius, length, "Hollow shaft"),
    [
      {
        label: "outer cylinder r = 50",
        distance: onRadius(outerRadius),
        area: 2 * Math.PI * outerRadius * length,
      },
      {
        label: "bore r = 30",
        distance: onRadius(innerRadius),
        area: 2 * Math.PI * innerRadius * length,
      },
      { label: "end z = 0", distance: onZ(0), area: sectionArea },
      { label: "end z = 500", distance: onZ(length), area: sectionArea },
    ],
    sectionArea * length,
    length,
    10,
  );
}

// ── Plate with a hole (examples/validation/cases/plate-with-hole*.mjs) ────────
const holeRadius = 1000;
const halfWidth = 10000;
const thickness = 500;
{
  const plateArea =
    4 * halfWidth * halfWidth - Math.PI * holeRadius * holeRadius;
  const side = 2 * halfWidth * thickness;
  describePart(
    "plateWithHoleStep",
    plateWithHoleStep(holeRadius, halfWidth, thickness, "Plate with a hole"),
    [
      { label: "edge y = −b", distance: onY(-halfWidth), area: side },
      { label: "edge x = +b", distance: onX(halfWidth), area: side },
      { label: "edge y = +b", distance: onY(halfWidth), area: side },
      { label: "edge x = −b", distance: onX(-halfWidth), area: side },
      {
        label: "hole r = a",
        distance: onRadius(holeRadius),
        area: 2 * Math.PI * holeRadius * thickness,
      },
      { label: "face z = 0", distance: onZ(0), area: plateArea },
      { label: "face z = t", distance: onZ(thickness), area: plateArea },
    ],
    plateArea * thickness,
    2 * halfWidth,
    1000,
  );
}
{
  // The strip of plate-with-hole.mjs and plate-with-hole-shell.mjs: L = 3b.
  const stripLength = 3 * halfWidth;
  const stripArea =
    stripLength * halfWidth - (Math.PI * holeRadius * holeRadius) / 4;
  describePart(
    "quarterStripWithHoleStep",
    quarterStripWithHoleStep(
      holeRadius,
      halfWidth,
      stripLength,
      thickness,
      "Quarter strip with a hole",
    ),
    [
      {
        label: "symmetry edge y = 0",
        distance: onY(0),
        area: (stripLength - holeRadius) * thickness,
      },
      {
        label: "edge x = L",
        distance: onX(stripLength),
        area: halfWidth * thickness,
      },
      {
        label: "edge y = b",
        distance: onY(halfWidth),
        area: stripLength * thickness,
      },
      {
        label: "symmetry edge x = 0",
        distance: onX(0),
        area: (halfWidth - holeRadius) * thickness,
      },
      {
        label: "quarter hole r = a",
        distance: onRadius(holeRadius),
        area: (Math.PI / 2) * holeRadius * thickness,
      },
      { label: "face z = 0", distance: onZ(0), area: stripArea },
      { label: "face z = t", distance: onZ(thickness), area: stripArea },
    ],
    stripArea * thickness,
    stripLength,
    1000,
  );
}

// ── A general profile: arcs across the cylinder seam, two kinds of hole ───────
// A slot (stadium) 0 ≤ x ≤ 100 between semicircular ends of radius 20, with a
// round hole and a square hole.
{
  const endRadius = 20;
  const height = 8;
  const profile = {
    outer: [
      line([100, -endRadius]),
      arc([100, endRadius], [100, 0], true),
      line([0, endRadius]),
      arc([0, -endRadius], [0, 0], true),
    ],
    holes: [
      circleLoop([25, 0], 8, false),
      [line([60, 10]), line([70, 10]), line([70, -10]), line([60, -10])],
    ],
  };
  const slotArea =
    100 * 2 * endRadius + Math.PI * endRadius * endRadius - Math.PI * 64 - 200;

  test("profileArea of the slot", () => {
    expect(
      Math.abs(profileArea(profile) - slotArea),
      `${profileArea(profile)} vs ${slotArea}`,
    ).toBeLessThan(1e-9 * slotArea);
  });

  describePart(
    "extrudedProfileStep (slot)",
    extrudedProfileStep(profile, height, "Slot"),
    [
      {
        label: "flat y = −20",
        distance: onY(-endRadius),
        area: 100 * height,
      },
      {
        label: "right end r = 20 about (100, 0)",
        distance: onRadius(endRadius, 100),
        area: Math.PI * endRadius * height,
      },
      { label: "flat y = +20", distance: onY(endRadius), area: 100 * height },
      {
        label: "left end r = 20 about (0, 0)",
        distance: onRadius(endRadius),
        area: Math.PI * endRadius * height,
      },
      {
        label: "round hole r = 8",
        distance: onRadius(8, 25),
        area: 2 * Math.PI * 8 * height,
      },
      // The loop starts at its last segment's end, (60, −10).
      { label: "square hole x = 60", distance: onX(60), area: 20 * height },
      { label: "square hole y = 10", distance: onY(10), area: 10 * height },
      { label: "square hole x = 70", distance: onX(70), area: 20 * height },
      { label: "square hole y = −10", distance: onY(-10), area: 10 * height },
      { label: "face z = 0", distance: onZ(0), area: slotArea },
      { label: "face z = 8", distance: onZ(height), area: slotArea },
    ],
    slotArea * height,
    140,
    4,
  );
}
