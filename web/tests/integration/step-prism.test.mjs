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
//     twice), and such a file still imports;
//   - several profiles in one file (extrudedProfilesStep) import and mesh as
//     that many bodies, each with its own faces and elements.

import { createHash } from "node:crypto";
import { beforeAll, describe, expect, test } from "bun:test";
import {
  annulusStep,
  arc,
  circleLoop,
  ellipseArc,
  ellipticMembraneStep,
  extrudedProfileStep,
  extrudedProfilesStep,
  line,
  plateWithHoleStep,
  prismStep,
  profileArea,
  quarterStripWithHoleStep,
  stepString,
} from "../../../examples/gallery/step-prism.mjs";
import {
  describePart,
  onRadius,
  onX,
  onY,
  onZ,
  simpson,
  TESSELLATION_OPTIONS,
} from "../support/step-parts.mjs";
import { loadEngine } from "../support/wasm.mjs";

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

  test("elliptic arc ending off its ellipse is rejected", () => {
    expect(() =>
      extrudedProfileStep(
        {
          outer: [
            line([2, 0]),
            ellipseArc([0, 1.5], [0, 0], [2, 1], true),
            line([0, 0]),
          ],
          holes: [],
        },
        1,
        "x",
      ),
    ).toThrow(/ellipse/);
  });

  test("elliptic arc with a non-positive semi-axis is rejected", () => {
    expect(() =>
      extrudedProfileStep(
        {
          outer: [
            line([2, 0]),
            ellipseArc([0, 0], [0, 0], [2, 0], true),
            line([0, 0]),
          ],
          holes: [],
        },
        1,
        "x",
      ),
    ).toThrow(/semi-axes/);
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
    let tess = null;

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

// ── Several solids in one file ────────────────────────────────────────────────
describe("two blocks 1 mm apart in one file", () => {
  const block = (x0, x1) => ({
    outer: [line([x1, 0]), line([x1, 10]), line([x0, 10]), line([x0, 0])],
    holes: [],
  });
  const step = extrudedProfilesStep(
    [block(0, 20), block(21, 41)],
    10,
    "Two blocks",
  );
  let tess = null;
  let dto = null;

  beforeAll(async () => {
    const engine = await loadEngine();
    tess = engine.tessellate_step(
      new TextEncoder().encode(step),
      TESSELLATION_OPTIONS,
    );
    dto = engine.generate_fem_mesh(
      JSON.stringify({
        max_element_size: 5,
        min_element_size: 0.5,
        grading: 0.3,
        second_order: false,
        elementsperedge: 2.0,
        elementspercurve: 2.0,
        optsteps_2d: 3,
        optsteps_3d: 3,
      }),
    );
  });

  test("import as two bodies of six faces each", () => {
    expect(tess.bodyCount).toBe(2);
    const faces = new Set(tess.triangleFaceIds);
    expect(faces.size).toBe(12);
    // Each body owns its own six faces: the gap keeps them apart.
    const bodiesOfFace = new Map();
    tess.triangleFaceIds.forEach((face, triangle) => {
      const set = bodiesOfFace.get(face) ?? new Set();
      set.add(tess.triangleBodyIds[triangle]);
      bodiesOfFace.set(face, set);
    });
    for (const owners of bodiesOfFace.values()) expect(owners.size).toBe(1);
  });

  test("mesh as two bodies with their elements on either side of the gap", () => {
    const bodies = new Set(Array.from(dto.bodyIds));
    expect([...bodies].sort()).toEqual([1, 2]);
  });
});

// ── Elliptic arcs ─────────────────────────────────────────────────────────────

/**
 * Distance (to first order) from (x, y) to the ellipse ((x−cx)/a)² + ((y−cy)/b)² = 1.
 *
 * @param {number} a
 * @param {number} b
 * @param {number} [centerX]
 * @param {number} [centerY]
 */
const onEllipse =
  (a, b, centerX = 0, centerY = 0) =>
  /** @type {(x: number, y: number) => number} */ (coordX, coordY) => {
    const scaledX = (coordX - centerX) / a;
    const scaledY = (coordY - centerY) / b;
    const rho = Math.hypot(scaledX, scaledY);
    const gradient = Math.hypot(scaledX / a, scaledY / b) / rho;
    return (rho - 1) / gradient;
  };

/**
 * Arc length of x = a cos t, y = b sin t for t0 ≤ t ≤ t1 (composite Simpson).
 *
 * @param {number} a
 * @param {number} b
 * @param {number} t0
 * @param {number} t1
 */
function ellipseArcLength(a, b, t0, t1) {
  return simpson((t) => Math.hypot(a * Math.sin(t), b * Math.cos(t)), t0, t1);
}

// NAFEMS LE1 / LE10: the quarter x, y ≥ 0 between the ellipses
// (x/2000)² + (y/1000)² = 1 and (x/3250)² + (y/2750)² = 1.
{
  const depth = 100;
  const area = (Math.PI / 4) * (3250 * 2750 - 2000 * 1000);
  const step = ellipticMembraneStep(depth, "Elliptic membrane");

  test("profileArea of the elliptic membrane is exact", () => {
    const quarter = {
      outer: [
        line([3250, 0]),
        ellipseArc([0, 2750], [0, 0], [3250, 2750], true),
        line([0, 1000]),
        ellipseArc([2000, 0], [0, 0], [2000, 1000], false),
      ],
      holes: [],
    };
    expect(Math.abs(profileArea(quarter) / area - 1)).toBeLessThan(1e-12);
  });

  describePart(
    "ellipticMembraneStep",
    step,
    [
      { label: "edge DC on y = 0", distance: onY(0), area: 1250 * depth },
      {
        label: "outer arc CB",
        distance: onEllipse(3250, 2750),
        area: ellipseArcLength(3250, 2750, 0, Math.PI / 2) * depth,
      },
      { label: "edge BA on x = 0", distance: onX(0), area: 1750 * depth },
      {
        label: "inner arc AD",
        distance: onEllipse(2000, 1000),
        area: ellipseArcLength(2000, 1000, 0, Math.PI / 2) * depth,
      },
      { label: "face z = 0", distance: onZ(0), area },
      { label: "face z = depth", distance: onZ(depth), area },
    ],
    area * depth,
    3250,
    250,
    { areaTolerance: 0.005 },
  );
}

// A full elliptic hole, taller than wide (major axis along y), seamed at its
// start (12, 5), and an elliptic arc that crosses the +x axis.
{
  const depth = 5;
  const profile = {
    outer: [
      line([40, -10]),
      ellipseArc([40, 30], [40, 10], [10, 20], true),
      line([0, 30]),
      line([0, -10]),
    ],
    holes: [[ellipseArc([12, 5], [8, 5], [4, 9], false)]],
  };
  const holeArea = Math.PI * 4 * 9;
  const area = 40 * 40 + (Math.PI * 10 * 20) / 2 - holeArea;

  test("profileArea with a full elliptic hole is exact", () => {
    expect(Math.abs(profileArea(profile) / area - 1)).toBeLessThan(1e-12);
  });

  describePart(
    "extrudedProfileStep (elliptic arc and hole)",
    extrudedProfileStep(profile, depth, "Elliptic arc and hole"),
    [
      { label: "flat y = −10", distance: onY(-10), area: 40 * depth },
      {
        label: "half ellipse about (40, 10)",
        distance: onEllipse(10, 20, 40, 10),
        area: ellipseArcLength(10, 20, -Math.PI / 2, Math.PI / 2) * depth,
      },
      { label: "flat y = 30", distance: onY(30), area: 40 * depth },
      { label: "flat x = 0", distance: onX(0), area: 40 * depth },
      {
        label: "elliptic hole about (8, 5)",
        distance: onEllipse(4, 9, 8, 5),
        area: ellipseArcLength(4, 9, 0, 2 * Math.PI) * depth,
      },
      { label: "face z = 0", distance: onZ(0), area },
      { label: "face z = 5", distance: onZ(depth), area },
    ],
    area * depth,
    60,
    3,
    { areaTolerance: 0.005 },
  );
}
