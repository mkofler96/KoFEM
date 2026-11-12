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
//   - prismStep still writes byte-identical files, and invalid profiles throw.
//
// Run: bun examples/gallery/step-prism.test.mjs

import { createHash } from "node:crypto";
import { loadEngine } from "../shell-coupling/lib.mjs";
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
} from "./step-prism.mjs";

/** @type {{ name: string, ok: boolean, detail?: string }[]} */
const checks = [];
/** @param {string} name @param {boolean} ok @param {string} [detail] */
const check = (name, ok, detail) => checks.push({ name, ok, detail });

// ── prismStep is unchanged ────────────────────────────────────────────────────
// SHA-256 of prismStep's output before the profile writer was added; the
// gallery generators and Playwright specs import files written by it.
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
check(
  "prismStep output is byte-identical",
  prismHash ===
    "a9bbfe78262f0b91fd796ba0d9bd741ee8f35ac325b19385ab028536a9c94d37",
  prismHash,
);

// ── Invalid profiles throw ────────────────────────────────────────────────────
/** @param {string} name @param {() => unknown} fn @param {RegExp} message */
const throws = (name, fn, message) => {
  try {
    fn();
    check(name, false, "did not throw");
  } catch (err) {
    const text = err instanceof Error ? err.message : String(err);
    check(name, message.test(text), text);
  }
};
const square = [line([1, 0]), line([1, 1]), line([0, 1]), line([0, 0])];
throws(
  "clockwise outer loop is rejected",
  () =>
    extrudedProfileStep({ outer: [...square].reverse(), holes: [] }, 1, "x"),
  /counter-clockwise/,
);
throws(
  "counter-clockwise hole is rejected",
  () =>
    extrudedProfileStep(
      { outer: square, holes: [circleLoop([0.5, 0.5], 0.2, true)] },
      1,
      "x",
    ),
  /clockwise/,
);
throws(
  "arc with unequal end radii is rejected",
  () =>
    extrudedProfileStep(
      {
        outer: [line([2, 0]), arc([0, 1], [0, 0], true), line([0, 0])],
        holes: [],
      },
      1,
      "x",
    ),
  /radius/,
);
throws(
  "non-positive depth is rejected",
  () => extrudedProfileStep({ outer: square, holes: [] }, 0, "x"),
  /depth/,
);

// ── The engine ────────────────────────────────────────────────────────────────
const engine = await loadEngine();

/**
 * @typedef {object} ExpectedFace
 * @property {string} label
 * @property {(x: number, y: number, z: number) => number} distance  0 on the face's surface
 * @property {number} area  analytic face area (mm²)
 */

/**
 * @param {string} label
 * @param {string} step
 * @param {ExpectedFace[]} faces  in CAD face id order (id = index + 1)
 * @param {number} volume         analytic volume (mm³)
 * @param {number} size           extent of the part (mm), for tolerances
 * @param {number} maxElementSize the mesh size to check the volume at (mm)
 */
function checkPart(label, step, faces, volume, size, maxElementSize) {
  const tess = engine.tessellate_step(
    new TextEncoder().encode(step),
    JSON.stringify({
      deflection_relative: 0.001,
      angular_deflection: 0.5,
      format: "step",
    }),
  );
  check(`${label}: one body`, tess.bodyCount === 1, `${tess.bodyCount}`);
  const P = tess.vertices;
  const tri = tess.triangles;
  const faceIds = tess.triangleFaceIds;
  const ids = [...new Set(faceIds)].sort((a, b) => a - b);
  check(
    `${label}: ${faces.length} CAD faces`,
    ids.length === faces.length && ids.every((id, k) => id === k + 1),
    `[${ids.join(", ")}]`,
  );

  // Float32 display vertices: allow a few ulps of the part's size.
  const tol = 4e-6 * size;
  const worst = faces.map(() => 0);
  const area = faces.map(() => 0);
  for (let t = 0; t < faceIds.length; t++) {
    const k = faceIds[t] - 1;
    if (!faces[k]) continue;
    const p = [0, 1, 2].map((c) => {
      const v = tri[3 * t + c];
      return [P[3 * v], P[3 * v + 1], P[3 * v + 2]];
    });
    for (const [x, y, z] of p)
      worst[k] = Math.max(worst[k], Math.abs(faces[k].distance(x, y, z)));
    const u = [0, 1, 2].map((i) => p[1][i] - p[0][i]);
    const w = [0, 1, 2].map((i) => p[2][i] - p[0][i]);
    area[k] +=
      Math.hypot(
        u[1] * w[2] - u[2] * w[1],
        u[2] * w[0] - u[0] * w[2],
        u[0] * w[1] - u[1] * w[0],
      ) / 2;
  }
  faces.forEach((f, k) => {
    check(
      `${label}: face ${k + 1} is ${f.label}`,
      worst[k] <= tol,
      `max distance ${worst[k].toExponential(2)} mm`,
    );
    // Display tessellation inscribes curved faces; a coarse chord loses ~1 %.
    const err = area[k] / f.area - 1;
    check(
      `${label}: face ${k + 1} area`,
      Math.abs(err) < 0.02,
      `${(err * 100).toFixed(3)} %`,
    );
  });

  // Mesh with the app worker's exact options.
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
  const V = dto.vertices;
  const T = dto.tetrahedra;
  const nTets = T.length / 4;
  let sum = 0;
  let positive = 0;
  let degenerate = 0;
  for (let e = 0; e < nTets; e++) {
    const q = [0, 1, 2, 3].map((c) => {
      const v = T[4 * e + c];
      return [V[3 * v], V[3 * v + 1], V[3 * v + 2]];
    });
    const a = [0, 1, 2].map((i) => q[1][i] - q[0][i]);
    const b = [0, 1, 2].map((i) => q[2][i] - q[0][i]);
    const c = [0, 1, 2].map((i) => q[3][i] - q[0][i]);
    const det =
      a[0] * (b[1] * c[2] - b[2] * c[1]) -
      a[1] * (b[0] * c[2] - b[2] * c[0]) +
      a[2] * (b[0] * c[1] - b[1] * c[0]);
    if (det > 0) positive++;
    if (Math.abs(det) < 1e-12 * size ** 3) degenerate++;
    sum += det / 6;
  }
  check(
    `${label}: tets consistently oriented, none degenerate`,
    nTets > 0 && (positive === 0 || positive === nTets) && degenerate === 0,
    `${nTets} tets, ${positive} positive, ${degenerate} degenerate`,
  );
  check(
    `${label}: one body in the mesh`,
    Array.from(dto.bodyIds).every((b) => b === 1),
  );
  const volErr = Math.abs(sum) / volume - 1;
  check(
    `${label}: mesh volume within 0.5 % (h = ${maxElementSize} mm)`,
    Math.abs(volErr) < 0.005,
    `${(volErr * 100).toFixed(4)} %, ${nTets} tets`,
  );

  // The Netgen surface mesh keeps the same face ids on the same surfaces.
  const S = dto.surfaceTriangles;
  const SF = dto.surfaceFaceIds;
  const meshIds = [...new Set(SF)].sort((a, b) => a - b);
  let off = 0;
  for (let t = 0; t < SF.length; t++) {
    const f = faces[SF[t] - 1];
    if (!f) {
      off = Infinity;
      continue;
    }
    for (let c = 0; c < 3; c++) {
      const v = S[3 * t + c];
      off = Math.max(
        off,
        Math.abs(f.distance(V[3 * v], V[3 * v + 1], V[3 * v + 2])),
      );
    }
  }
  check(
    `${label}: mesh surface triangles lie on their CAD faces`,
    meshIds.length === faces.length && off <= tol,
    `${meshIds.length} faces, max distance ${off.toExponential(2)} mm`,
  );
}

/** Distance helpers: 0 on the surface. */
const onX = (/** @type {number} */ x0) => (/** @type {number} */ x) => x - x0;
const onY =
  (/** @type {number} */ y0) =>
  /** @type {(x: number, y: number) => number} */ (_x, y) =>
    y - y0;
const onZ =
  (/** @type {number} */ z0) =>
  /** @type {(x: number, y: number, z: number) => number} */ (_x, _y, z) =>
    z - z0;
const onR =
  (
    /** @type {number} */ r,
    /** @type {number} */ cx = 0,
    /** @type {number} */ cy = 0,
  ) =>
  /** @type {(x: number, y: number) => number} */ (x, y) =>
    Math.hypot(x - cx, y - cy) - r;

// ── Hollow shaft (examples/validation/cases/shaft-torsion.mjs) ────────────────
{
  const ri = 30;
  const ro = 50;
  const L = 500;
  const A = Math.PI * (ro ** 2 - ri ** 2);
  checkPart(
    "annulusStep",
    annulusStep(ri, ro, L, "Hollow shaft"),
    [
      {
        label: "outer cylinder r = 50",
        distance: onR(ro),
        area: 2 * Math.PI * ro * L,
      },
      { label: "bore r = 30", distance: onR(ri), area: 2 * Math.PI * ri * L },
      { label: "end z = 0", distance: onZ(0), area: A },
      { label: "end z = 500", distance: onZ(L), area: A },
    ],
    A * L,
    L,
    10,
  );
}

// ── Plate with a hole (examples/validation/cases/plate-with-hole*.mjs) ────────
const a = 1000;
const b = 10000;
const t = 500;
{
  const A = 4 * b * b - Math.PI * a * a;
  const side = 2 * b * t;
  checkPart(
    "plateWithHoleStep",
    plateWithHoleStep(a, b, t, "Plate with a hole"),
    [
      { label: "edge y = −b", distance: onY(-b), area: side },
      { label: "edge x = +b", distance: onX(b), area: side },
      { label: "edge y = +b", distance: onY(b), area: side },
      { label: "edge x = −b", distance: onX(-b), area: side },
      { label: "hole r = a", distance: onR(a), area: 2 * Math.PI * a * t },
      { label: "face z = 0", distance: onZ(0), area: A },
      { label: "face z = t", distance: onZ(t), area: A },
    ],
    A * t,
    2 * b,
    1000,
  );
}
{
  // The strip of plate-with-hole.mjs and plate-with-hole-shell.mjs: L = 3b.
  const L = 3 * b;
  const A = L * b - (Math.PI * a * a) / 4;
  checkPart(
    "quarterStripWithHoleStep",
    quarterStripWithHoleStep(a, b, L, t, "Quarter strip with a hole"),
    [
      { label: "symmetry edge y = 0", distance: onY(0), area: (L - a) * t },
      { label: "edge x = L", distance: onX(L), area: b * t },
      { label: "edge y = b", distance: onY(b), area: L * t },
      { label: "symmetry edge x = 0", distance: onX(0), area: (b - a) * t },
      {
        label: "quarter hole r = a",
        distance: onR(a),
        area: (Math.PI / 2) * a * t,
      },
      { label: "face z = 0", distance: onZ(0), area: A },
      { label: "face z = t", distance: onZ(t), area: A },
    ],
    A * t,
    L,
    1000,
  );
}

// ── A general profile: arcs across the cylinder seam, two kinds of hole ───────
// A slot (stadium) 0 ≤ x ≤ 100 between semicircular ends of radius 20, with a
// round hole and a square hole.
{
  const R = 20;
  const H = 8;
  const profile = {
    outer: [
      line([100, -R]),
      arc([100, R], [100, 0], true),
      line([0, R]),
      arc([0, -R], [0, 0], true),
    ],
    holes: [
      circleLoop([25, 0], 8, false),
      [line([60, 10]), line([70, 10]), line([70, -10]), line([60, -10])],
    ],
  };
  const A = 100 * 2 * R + Math.PI * R * R - Math.PI * 64 - 200;
  check(
    "profileArea of the slot",
    Math.abs(profileArea(profile) - A) < 1e-9 * A,
    `${profileArea(profile)} vs ${A}`,
  );
  checkPart(
    "extrudedProfileStep (slot)",
    extrudedProfileStep(profile, H, "Slot"),
    [
      { label: "flat y = −20", distance: onY(-R), area: 100 * H },
      {
        label: "right end r = 20 about (100, 0)",
        distance: onR(R, 100),
        area: Math.PI * R * H,
      },
      { label: "flat y = +20", distance: onY(R), area: 100 * H },
      {
        label: "left end r = 20 about (0, 0)",
        distance: onR(R),
        area: Math.PI * R * H,
      },
      {
        label: "round hole r = 8",
        distance: onR(8, 25),
        area: 2 * Math.PI * 8 * H,
      },
      // The loop starts at its last segment's end, (60, −10).
      { label: "square hole x = 60", distance: onX(60), area: 20 * H },
      { label: "square hole y = 10", distance: onY(10), area: 10 * H },
      { label: "square hole x = 70", distance: onX(70), area: 20 * H },
      { label: "square hole y = −10", distance: onY(-10), area: 10 * H },
      { label: "face z = 0", distance: onZ(0), area: A },
      { label: "face z = 8", distance: onZ(H), area: A },
    ],
    A * H,
    140,
    4,
  );
}

// ── Report ────────────────────────────────────────────────────────────────────
console.log("\nSTEP profile writer test (examples/gallery/step-prism.mjs)\n");
let failed = 0;
for (const c of checks) {
  console.log(
    `  ${c.ok ? "PASS" : "FAIL"}  ${c.name}${c.detail ? "  — " + c.detail : ""}`,
  );
  if (!c.ok) failed++;
}
if (failed) {
  console.error(`\n${failed} check(s) FAILED.\n`);
  process.exit(1);
}
console.log(
  "\nPASS — every writer gives OCCT and Netgen the solid it documents.\n",
);
