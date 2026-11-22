// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Checks the revolved-sector STEP writers of step-revolve.mjs against the real
// engine (see support/step-parts.mjs): OCCT imports one body with the faces
// the writer documents, each on its analytic surface and with its analytic
// area, and Netgen meshes it with the analytic volume. Invalid profiles throw.

import { beforeAll, describe, expect, test } from "bun:test";
import {
  arc,
  cappedCylinderStep,
  cylindricalPanelStep,
  hyperbolaArc,
  hyperboloidShellStep,
  line,
  revolvedSectorStep,
  sphericalShellStep,
} from "../../../examples/gallery/step-revolve.mjs";
import {
  describePart,
  onRadius,
  onY,
  onZ,
  simpson,
  TESSELLATION_OPTIONS,
} from "../support/step-parts.mjs";
import { loadEngine } from "../support/wasm.mjs";

const DEG = Math.PI / 180;

// ── Analytic helpers ──────────────────────────────────────────────────────────

/**
 * Area and first moment ∫∫ r dA of a section in the (r, z) half-plane, from
 * its boundary sampled densely: each piece maps t ∈ [0, 1] to (r, z), the
 * pieces run counter-clockwise end to end. The volume of the section revolved
 * through `sweep` radians is sweep · moment (Pappus).
 *
 * @param {((t: number) => [number, number])[]} pieces
 */
function section(pieces) {
  const samples = 20000;
  let area = 0;
  let moment = 0;
  for (const piece of pieces) {
    let [r0, z0] = piece(0);
    for (let i = 1; i <= samples; i++) {
      const [r1, z1] = piece(i / samples);
      // Straight chord: ∮ r dz and ∮ r²/2 dz exactly.
      area += ((r0 + r1) / 2) * (z1 - z0);
      moment += ((z1 - z0) / 6) * (r0 * r0 + r0 * r1 + r1 * r1);
      r0 = r1;
      z0 = z1;
    }
  }
  return { area, moment };
}

/** @param {[number, number]} from @param {[number, number]} to */
const segment = (from, to) => (/** @type {number} */ t) =>
  /** @type {[number, number]} */ ([
    from[0] + t * (to[0] - from[0]),
    from[1] + t * (to[1] - from[1]),
  ]);

/**
 * The arc about `center` of radius `radius` from angle a0 to a1 (rad, measured
 * from +r towards +z).
 *
 * @param {[number, number]} center @param {number} radius @param {number} a0 @param {number} a1
 */
const circular = (center, radius, a0, a1) => (/** @type {number} */ t) => {
  const angle = a0 + t * (a1 - a0);
  return /** @type {[number, number]} */ ([
    center[0] + radius * Math.cos(angle),
    center[1] + radius * Math.sin(angle),
  ]);
};

/**
 * The hyperbola r²/a² − z²/b² = 1 from height z0 to z1.
 *
 * @param {number} a @param {number} b @param {number} z0 @param {number} z1
 */
const hyperbolic = (a, b, z0, z1) => (/** @type {number} */ t) => {
  const height = z0 + t * (z1 - z0);
  return /** @type {[number, number]} */ ([
    a * Math.sqrt(1 + (height / b) ** 2),
    height,
  ]);
};

/** 0 on the sphere of radius `radius` about (0, 0, centerZ). */
const onSphere =
  (/** @type {number} */ radius, /** @type {number} */ centerZ = 0) =>
  /** @type {(x: number, y: number, z: number) => number} */ (
    coordX,
    coordY,
    coordZ,
  ) =>
    Math.hypot(coordX, coordY, coordZ - centerZ) - radius;

/** 0 on the half-plane θ = angle (rad) through the z axis. */
const onMeridian =
  (/** @type {number} */ angle) =>
  /** @type {(x: number, y: number) => number} */ (coordX, coordY) =>
    -coordX * Math.sin(angle) + coordY * Math.cos(angle);

/** 0 on the cone through the meridian line (r0, z0)–(r1, z1). */
const onCone =
  (
    /** @type {[number, number]} */ [r0, z0],
    /** @type {[number, number]} */ [r1, z1],
  ) =>
  /** @type {(x: number, y: number, z: number) => number} */ (
    coordX,
    coordY,
    coordZ,
  ) =>
    ((Math.hypot(coordX, coordY) - r0) * (z1 - z0) -
      (coordZ - z0) * (r1 - r0)) /
    Math.hypot(r1 - r0, z1 - z0);

/** 0 (to first order) on the hyperboloid r²/a² − z²/b² = 1. */
const onHyperboloid =
  (/** @type {number} */ a, /** @type {number} */ b) =>
  /** @type {(x: number, y: number, z: number) => number} */ (
    coordX,
    coordY,
    coordZ,
  ) => {
    const radius = Math.hypot(coordX, coordY);
    const level = (radius / a) ** 2 - (coordZ / b) ** 2 - 1;
    return level / Math.hypot((2 * radius) / a ** 2, (2 * coordZ) / b ** 2);
  };

/** Area of the hyperboloid r²/a² − z²/b² = 1, z0 ≤ z ≤ z1, over `sweep` rad. */
function hyperboloidArea(a, b, z0, z1, sweep) {
  return (
    sweep *
    simpson(
      (height) => {
        const radius = a * Math.sqrt(1 + (height / b) ** 2);
        const slope = (a * a * height) / (b * b * radius);
        return radius * Math.hypot(1, slope);
      },
      z0,
      z1,
    )
  );
}

/** Area of the cone frustum between meridian points p and q over `sweep` rad. */
const frustumArea = (
  /** @type {[number, number]} */ p,
  /** @type {[number, number]} */ q,
  /** @type {number} */ sweep,
) => (sweep * (p[0] + q[0]) * Math.hypot(q[0] - p[0], q[1] - p[1])) / 2;

// ── Invalid inputs throw ──────────────────────────────────────────────────────
describe("invalid revolved profiles", () => {
  const rectangle = [
    line([20, 0]),
    line([20, 10]),
    line([10, 10]),
    line([10, 0]),
  ];

  test.each([0, 360, 400, -30, Number.NaN])(
    "sweep %p° is rejected",
    (sweep) => {
      expect(() => revolvedSectorStep([rectangle], sweep, "x")).toThrow(
        /sweep/,
      );
    },
  );

  test("no profile is rejected", () => {
    expect(() => revolvedSectorStep([], 90, "x")).toThrow(/profile/);
  });

  test("a vertex at r < 0 is rejected", () => {
    expect(() =>
      revolvedSectorStep(
        [[line([20, 0]), line([20, 10]), line([-1, 10]), line([-1, 0])]],
        90,
        "x",
      ),
    ).toThrow(/r ≥ 0/);
  });

  test("a clockwise profile is rejected", () => {
    expect(() =>
      revolvedSectorStep([[...rectangle].reverse()], 90, "x"),
    ).toThrow(/counter-clockwise/);
  });

  test("an arc with unequal end radii is rejected", () => {
    expect(() =>
      revolvedSectorStep(
        [[line([20, 0]), arc([10, 11], [10, 0], true), line([10, 0])]],
        90,
        "x",
      ),
    ).toThrow(/radius/);
  });

  test("an arc that crosses the axis is rejected", () => {
    // About (2, 0) with radius 5 from (2, −5) clockwise, through r = −3.
    expect(() =>
      revolvedSectorStep(
        [[arc([2, 5], [2, 0], false), line([2, -5])]],
        90,
        "x",
      ),
    ).toThrow(/axis/);
  });

  test("a hyperbolic arc ending off its hyperbola is rejected", () => {
    expect(() =>
      revolvedSectorStep(
        [
          [
            line([110, 0]),
            line([110, 50]),
            line([100, 50]),
            hyperbolaArc([100, 0], { a: 100, b: 100 }),
          ],
        ],
        90,
        "x",
      ),
    ).toThrow(/hyperbola/);
  });
});

// ── Every surface kind in one solid ───────────────────────────────────────────
// A solid of revolution through 120°: a disc sector on z = 0 from the axis, a
// cone, a cylinder, a convex torus and a sphere cap closing on the axis, which
// itself carries no face.
{
  const sweepDeg = 120;
  const sweep = sweepDeg * DEG;
  /** @type {[number, number][]} */
  const [p0, p1, p2, p3, p4, p5] = [
    [0, 0],
    [40, 0],
    [50, 30],
    [50, 50],
    [30, 70],
    [0, 100],
  ];
  const step = revolvedSectorStep(
    [
      [
        line(p1),
        line(p2),
        line(p3),
        arc(p4, [30, 50], true),
        arc(p5, [0, 70], true),
        line(p0),
      ],
    ],
    sweepDeg,
    "Every surface",
  );
  const { area, moment } = section([
    segment(p0, p1),
    segment(p1, p2),
    segment(p2, p3),
    circular([30, 50], 20, 0, Math.PI / 2),
    circular([0, 70], 30, 0, Math.PI / 2),
    segment(p5, p0),
  ]);
  describePart(
    "revolvedSectorStep (every surface kind)",
    step,
    [
      {
        label: "disc sector z = 0",
        distance: onZ(0),
        area: (sweep / 2) * 1600,
      },
      {
        label: "cone",
        distance: onCone(p1, p2),
        area: frustumArea(p1, p2, sweep),
      },
      {
        label: "cylinder r = 50",
        distance: onRadius(50),
        area: sweep * 50 * 20,
      },
      {
        label: "torus R = 30, r = 20",
        distance: (coordX, coordY, coordZ) =>
          Math.hypot(Math.hypot(coordX, coordY) - 30, coordZ - 50) - 20,
        area: sweep * 20 * (30 * (Math.PI / 2) + 20),
      },
      {
        label: "sphere cap r = 30 about z = 70",
        distance: onSphere(30, 70),
        area: sweep * 900,
      },
      { label: "end θ = 0", distance: onY(0), area },
      { label: "end θ = 120°", distance: onMeridian(sweep), area },
    ],
    sweep * moment,
    100,
    4,
    { areaTolerance: 0.005 },
  );
}

// ── NAFEMS LE2: cylindrical panel ─────────────────────────────────────────────
{
  const sweep = 30 * DEG;
  const [inner, outer, length] = [995, 1005, 500];
  const ring = (sweep / 2) * (outer ** 2 - inner ** 2);
  const end = (outer - inner) * length;
  describePart(
    "cylindricalPanelStep (NAFEMS LE2)",
    cylindricalPanelStep(1000, 10, 500, 30, "Cylindrical panel"),
    [
      { label: "end z = 0", distance: onZ(0), area: ring },
      {
        label: "outer cylinder r = 1005",
        distance: onRadius(outer),
        area: sweep * outer * length,
      },
      { label: "end z = 500", distance: onZ(length), area: ring },
      {
        label: "inner cylinder r = 995",
        distance: onRadius(inner),
        area: sweep * inner * length,
      },
      { label: "edge θ = 0", distance: onY(0), area: end },
      { label: "edge θ = 30°", distance: onMeridian(sweep), area: end },
    ],
    ring * length,
    1000,
    40,
    { areaTolerance: 0.005 },
  );
}

// ── NAFEMS LE3: hemisphere with an 18° hole ───────────────────────────────────
{
  const sweep = 90 * DEG;
  const [inner, outer] = [9980, 10020];
  const top = 72 * DEG;
  const zone = (radius) => sweep * radius * radius * Math.sin(top);
  const { area, moment } = section([
    segment([inner, 0], [outer, 0]),
    circular([0, 0], outer, 0, top),
    segment(
      [outer * Math.cos(top), outer * Math.sin(top)],
      [inner * Math.cos(top), inner * Math.sin(top)],
    ),
    circular([0, 0], inner, top, 0),
  ]);
  const topOuter = [outer * Math.cos(top), outer * Math.sin(top)];
  const topInner = [inner * Math.cos(top), inner * Math.sin(top)];
  describePart(
    "sphericalShellStep (NAFEMS LE3)",
    sphericalShellStep(10000, 40, 0, 72, 90, "Hemisphere"),
    [
      {
        label: "equator z = 0",
        distance: onZ(0),
        area: (sweep / 2) * (outer ** 2 - inner ** 2),
        // The display tessellation chords this 40 mm wide, 10 m radius ring's
        // inner arc more coarsely than its outer one and overstates it by
        // 1.3 %; Netgen's surface mesh of it is within 0.05 %.
        areaTolerance: 0.02,
      },
      { label: "outer sphere", distance: onSphere(outer), area: zone(outer) },
      {
        label: "hole edge (cone through the centre)",
        distance: onCone(topOuter, topInner),
        area: frustumArea(topOuter, topInner, sweep),
      },
      { label: "inner sphere", distance: onSphere(inner), area: zone(inner) },
      { label: "edge θ = 0", distance: onY(0), area },
      { label: "edge θ = 90°", distance: onMeridian(sweep), area },
    ],
    sweep * moment,
    10000,
    300,
    { areaTolerance: 0.005 },
  );
}

// ── NAFEMS LE4: hyperboloid ───────────────────────────────────────────────────
{
  const sweep = 90 * DEG;
  const [waist, height, thickness] = [1000, 1000, 10];
  // Mid-surface r² − z² = 1000²; the faces offset it by ± t/2 along its normal
  // at both ends: at the waist, and at the top, where the end face is normal to
  // the mid-surface.
  const midTop = [Math.SQRT2 * waist, height];
  const normal = [midTop[0], -midTop[1]].map((c) => c / Math.hypot(...midTop));
  const offset = (/** @type {number} */ sign) =>
    /** @type {[number, number]} */ ([
      midTop[0] + (sign * thickness * normal[0]) / 2,
      midTop[1] + (sign * thickness * normal[1]) / 2,
    ]);
  const [topIn, topOut] = [offset(-1), offset(1)];
  const aIn = waist - thickness / 2;
  const aOut = waist + thickness / 2;
  const imaginary = (a, [r, z]) => z / Math.sqrt((r / a) ** 2 - 1);
  const bIn = imaginary(aIn, topIn);
  const bOut = imaginary(aOut, topOut);
  const { area, moment } = section([
    segment([aIn, 0], [aOut, 0]),
    hyperbolic(aOut, bOut, 0, topOut[1]),
    segment(topOut, topIn),
    hyperbolic(aIn, bIn, topIn[1], 0),
  ]);
  describePart(
    "hyperboloidShellStep (NAFEMS LE4)",
    hyperboloidShellStep(waist, waist, height, thickness, 90, "Hyperboloid"),
    [
      {
        label: "waist z = 0",
        distance: onZ(0),
        area: (sweep / 2) * (aOut ** 2 - aIn ** 2),
      },
      {
        label: "outer hyperboloid",
        distance: onHyperboloid(aOut, bOut),
        area: hyperboloidArea(aOut, bOut, 0, topOut[1], sweep),
      },
      {
        label: "top edge (normal to the mid-surface)",
        distance: onCone(topOut, topIn),
        area: frustumArea(topOut, topIn, sweep),
      },
      {
        label: "inner hyperboloid",
        distance: onHyperboloid(aIn, bIn),
        area: hyperboloidArea(aIn, bIn, 0, topIn[1], sweep),
      },
      { label: "edge θ = 0", distance: onY(0), area },
      { label: "edge θ = 90°", distance: onMeridian(sweep), area },
    ],
    sweep * moment,
    1500,
    50,
    { areaTolerance: 0.005 },
  );
}

// ── NAFEMS LE7: cylinder with a hemispherical cap ─────────────────────────────
{
  const sweep = 90 * DEG;
  const [inner, outer, length] = [987.5, 1012.5, 1500];
  const { area, moment } = section([
    segment([inner, 0], [outer, 0]),
    segment([outer, 0], [outer, length]),
    circular([0, length], outer, 0, Math.PI / 2),
    segment([0, length + outer], [0, length + inner]),
    circular([0, length], inner, Math.PI / 2, 0),
    segment([inner, length], [inner, 0]),
  ]);
  describePart(
    "cappedCylinderStep (NAFEMS LE7)",
    cappedCylinderStep(1000, 25, 1500, 90, "Capped cylinder"),
    [
      {
        label: "end z = 0",
        distance: onZ(0),
        area: (sweep / 2) * (outer ** 2 - inner ** 2),
      },
      {
        label: "outer cylinder",
        distance: onRadius(outer),
        area: sweep * outer * length,
      },
      {
        label: "outer hemisphere",
        distance: onSphere(outer, length),
        area: sweep * outer * outer,
      },
      {
        label: "inner hemisphere",
        distance: onSphere(inner, length),
        area: sweep * inner * inner,
      },
      {
        label: "inner cylinder",
        distance: onRadius(inner),
        area: sweep * inner * length,
      },
      { label: "edge θ = 0", distance: onY(0), area },
      { label: "edge θ = 90°", distance: onMeridian(sweep), area },
    ],
    sweep * moment,
    2500,
    100,
    { areaTolerance: 0.005 },
  );
}

// ── A closed quarter spherical shell: its pole is one vertex ──────────────────
test("sphericalShellStep up to the pole has no hole face", async () => {
  const engine = await loadEngine();
  const tess = engine.tessellate_step(
    new TextEncoder().encode(
      sphericalShellStep(100, 10, 0, 90, 90, "Quarter dome"),
    ),
    TESSELLATION_OPTIONS,
  );
  expect(tess.bodyCount).toBe(1);
  expect(new Set(tess.triangleFaceIds).size).toBe(5);
});

// ── Several profiles: several bodies ──────────────────────────────────────────
describe("two revolved rings 1 mm apart in one file", () => {
  const ring = (/** @type {number} */ z0) => [
    line([20, z0]),
    line([20, z0 + 10]),
    line([10, z0 + 10]),
    line([10, z0]),
  ];
  let tess = null;

  beforeAll(async () => {
    const engine = await loadEngine();
    tess = engine.tessellate_step(
      new TextEncoder().encode(
        revolvedSectorStep([ring(0), ring(11)], 90, "Two rings"),
      ),
      TESSELLATION_OPTIONS,
    );
  });

  test("import as two bodies of six faces each", () => {
    expect(tess.bodyCount).toBe(2);
    expect(new Set(tess.triangleFaceIds).size).toBe(12);
  });
});
