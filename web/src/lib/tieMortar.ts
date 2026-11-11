// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Dual mortar weights for a constraint tie between linear element faces
// (issue #357).
//
// A node-to-surface tie makes each slave node follow the point of the master
// surface it projects onto. That is exact AT the slave nodes, but between them
// the two faces interpolate differently, so the work a traction does on one
// side is not the work it does on the other: a constant traction does not cross
// the tie exactly, and the patch test fails wherever the slave nodes fall inside
// master faces (KoFEM's tie patch test: 94–105 MPa where 100 MPa is exact).
//
// The mortar method imposes the tie weakly instead, over the interface:
//
//     ∫_Γ ψ_j · (u_slave − u_master) dΓ = 0     for every slave node j,
//
// with ψ_j a multiplier basis on the slave surface. Choosing ψ_j DUAL to the
// slave shape functions N_i — ∫ ψ_j N_i dΓ = δ_ij ∫ N_j dΓ (Wohlmuth 2000) —
// makes the slave block diagonal, so each equation still solves for one slave
// node,
//
//     u_j = Σ_k w_jk u_k,   w_jk = ∫ ψ_j N_k^master dΓ / ∫ ψ_j dΓ,
//
// and the engine's master-slave elimination is unchanged. Because Σ_j ψ_j = 1,
// the sum of the equations is ∫ (u_slave − u_master) dΓ = 0: a constant
// traction is transferred exactly. A linear displacement field satisfies every
// equation, so the patch test is passed to round-off.
//
// The integrals are taken over the overlap of each slave face with each master
// face (segmentation, Puso & Laursen 2004): the master face is projected along
// the slave face's normal into its plane, the two polygons are clipped, and the
// clipped polygon is integrated exactly with a degree-5 triangle rule. Without
// the clipping, the kinks of the master shape functions inside a slave face
// would leave a small error.
//
// Faces are 3-node triangles (tetrahedra) or 4-node quadrilaterals (hexahedra),
// with linear / bilinear shape functions — linear elements. Quadratic elements
// keep the node-to-surface projection (lib/tieConstraints.ts).
//
// References: B. I. Wohlmuth, "A mortar finite element method using dual
// spaces for the Lagrange multiplier", SIAM J. Numer. Anal. 38 (2000) 989–1012;
// M. A. Puso, "A 3D mortar method for solid mechanics", IJNME 59 (2004)
// 315–336; A. Popp, M. W. Gee, W. A. Wall, "A finite deformation mortar contact
// formulation using a primal–dual active set strategy", IJNME 79 (2009).

import { SpatialGrid, type Point3 } from "./spatialGrid.js";

// One element face on a tied surface: its nodes in cyclic order (3 or 4), their
// positions, and the centroid of the element it bounds (to orient its normal
// outwards — the face lists of the elements are not consistently wound).
export interface MortarFace {
  ids: number[];
  points: Point3[];
  elementCentroid: Point3;
}

// Weights of one slave node, and how much of its multiplier support the master
// surface covers (1 = all of it).
export interface MortarRow {
  masterIds: number[];
  weights: number[];
  coverage: number;
}

type Point2 = readonly [number, number];

const sub = (p: Point3, q: Point3): Point3 => [
  p[0] - q[0],
  p[1] - q[1],
  p[2] - q[2],
];
const dot = (p: Point3, q: Point3): number =>
  p[0] * q[0] + p[1] * q[1] + p[2] * q[2];
const cross = (p: Point3, q: Point3): Point3 => [
  p[1] * q[2] - p[2] * q[1],
  p[2] * q[0] - p[0] * q[2],
  p[0] * q[1] - p[1] * q[0],
];
const scale = (p: Point3, factor: number): Point3 => [
  factor * p[0],
  factor * p[1],
  factor * p[2],
];
const unit = (p: Point3): Point3 => scale(p, 1 / Math.hypot(...p));
const average = (points: readonly Point3[]): Point3 =>
  scale(
    points.reduce<Point3>(
      (sum, point) => [sum[0] + point[0], sum[1] + point[1], sum[2] + point[2]],
      [0, 0, 0],
    ),
    1 / points.length,
  );

// A face with its outward normal and an orthonormal frame in its plane.
interface FaceFrame {
  face: MortarFace;
  centroid: Point3;
  normal: Point3;
  axisU: Point3;
  axisV: Point3;
  radius: number;
}

function frameOf(face: MortarFace): FaceFrame {
  const centroid = average(face.points);
  // Newell's normal: robust for a slightly warped quadrilateral.
  let normal: Point3 = [0, 0, 0];
  face.points.forEach((point, k) => {
    const next = face.points[(k + 1) % face.points.length];
    normal = [
      normal[0] + (point[1] - next[1]) * (point[2] + next[2]),
      normal[1] + (point[2] - next[2]) * (point[0] + next[0]),
      normal[2] + (point[0] - next[0]) * (point[1] + next[1]),
    ];
  });
  normal = unit(normal);
  if (dot(normal, sub(centroid, face.elementCentroid)) < 0)
    normal = scale(normal, -1);
  const edge = sub(face.points[1], face.points[0]);
  const axisU = unit(sub(edge, scale(normal, dot(edge, normal))));
  const axisV = cross(normal, axisU);
  const radius = Math.max(
    ...face.points.map((point) => Math.hypot(...sub(point, centroid))),
  );
  return { face, centroid, normal, axisU, axisV, radius };
}

// A point projected into a frame's plane, as 2-D coordinates.
function inPlane(frame: FaceFrame, point: Point3): Point2 {
  const offset = sub(point, frame.centroid);
  return [dot(offset, frame.axisU), dot(offset, frame.axisV)];
}

const signedArea = (polygon: readonly Point2[]): number => {
  let twice = 0;
  polygon.forEach((point, k) => {
    const next = polygon[(k + 1) % polygon.length];
    twice += point[0] * next[1] - next[0] * point[1];
  });
  return twice / 2;
};

// ── Shape functions of a face, at a point of its (projected) plane ───────────

// Shape-function values of a triangle or bilinear quadrilateral with 2-D
// corners `corners`, at the point `q` of their plane. The quadrilateral is
// inverted by Newton's method on its bilinear map; a point outside the face is
// not an error (round-off at a clipped edge), its values just extrapolate.
function shapeAt(corners: readonly Point2[], q: Point2): number[] {
  if (corners.length === 3) {
    const [p0, p1, p2] = corners;
    const det =
      (p1[0] - p0[0]) * (p2[1] - p0[1]) - (p2[0] - p0[0]) * (p1[1] - p0[1]);
    const l1 =
      ((q[0] - p0[0]) * (p2[1] - p0[1]) - (p2[0] - p0[0]) * (q[1] - p0[1])) /
      det;
    const l2 =
      ((p1[0] - p0[0]) * (q[1] - p0[1]) - (q[0] - p0[0]) * (p1[1] - p0[1])) /
      det;
    return [1 - l1 - l2, l1, l2];
  }
  const [p0, p1, p2, p3] = corners;
  const bilinear = (s: number, t: number) => [
    (1 - s) * (1 - t),
    s * (1 - t),
    s * t,
    (1 - s) * t,
  ];
  // Reference coordinates (refS, refT) ∈ [0, 1]² of the point, by Newton.
  let refS = 0.5,
    refT = 0.5;
  for (let iteration = 0; iteration < 30; iteration++) {
    const shape = bilinear(refS, refT);
    const mappedX =
      shape[0] * p0[0] + shape[1] * p1[0] + shape[2] * p2[0] + shape[3] * p3[0];
    const mappedY =
      shape[0] * p0[1] + shape[1] * p1[1] + shape[2] * p2[1] + shape[3] * p3[1];
    // ∂x/∂s, ∂x/∂t, ∂y/∂s, ∂y/∂t of the bilinear map.
    const xs = (1 - refT) * (p1[0] - p0[0]) + refT * (p2[0] - p3[0]);
    const xt = (1 - refS) * (p3[0] - p0[0]) + refS * (p2[0] - p1[0]);
    const ys = (1 - refT) * (p1[1] - p0[1]) + refT * (p2[1] - p3[1]);
    const yt = (1 - refS) * (p3[1] - p0[1]) + refS * (p2[1] - p1[1]);
    const det = xs * yt - xt * ys;
    const rx = q[0] - mappedX,
      ry = q[1] - mappedY;
    const ds = (yt * rx - xt * ry) / det;
    const dt = (-ys * rx + xs * ry) / det;
    refS += ds;
    refT += dt;
    if (Math.abs(ds) + Math.abs(dt) < 1e-14) break;
  }
  return bilinear(refS, refT);
}

// ── The dual basis of a slave face ───────────────────────────────────────────

// Gauss–Legendre points on [0, 1], three per direction: exact for the
// biquadratic integrands of a parallelogram's mass matrix.
const GAUSS_01: readonly [number, number][] = [
  [0.5 - Math.sqrt(0.15), 5 / 18],
  [0.5, 8 / 18],
  [0.5 + Math.sqrt(0.15), 5 / 18],
];

// Inverse of a small dense matrix (Gauss–Jordan with partial pivoting).
function inverse(matrix: number[][]): number[][] {
  const n = matrix.length;
  const work = matrix.map((row, i) => [
    ...row,
    ...row.map((_, j) => (i === j ? 1 : 0)),
  ]);
  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let row = col + 1; row < n; row++)
      if (Math.abs(work[row][col]) > Math.abs(work[pivot][col])) pivot = row;
    [work[col], work[pivot]] = [work[pivot], work[col]];
    const lead = work[col][col];
    if (lead === 0) throw new Error("tie: degenerate slave face (zero area)");
    for (let j = 0; j < 2 * n; j++) work[col][j] /= lead;
    for (let row = 0; row < n; row++) {
      if (row === col) continue;
      const factor = work[row][col];
      for (let j = 0; j < 2 * n; j++) work[row][j] -= factor * work[col][j];
    }
  }
  return work.map((row) => row.slice(n));
}

// The coefficients A of the dual basis ψ_j = Σ_i A_ji N_i of a slave face, and
// ∫ N_j over it. Biorthogonality ∫ ψ_j N_i = δ_ij ∫ N_j gives A = D·M⁻¹, with
// M the face's mass matrix and D = diag(∫ N_j).
function dualBasis(corners: readonly Point2[]): {
  coefficients: number[][];
  integrals: number[];
} {
  const n = corners.length;
  const mass = Array.from({ length: n }, () => new Array<number>(n).fill(0));
  const integrals = new Array<number>(n).fill(0);
  if (n === 3) {
    const area = Math.abs(signedArea(corners));
    for (let i = 0; i < 3; i++) {
      integrals[i] = area / 3;
      for (let j = 0; j < 3; j++) mass[i][j] = (area * (i === j ? 2 : 1)) / 12;
    }
  } else {
    const [p0, p1, p2, p3] = corners;
    for (const [s, ws] of GAUSS_01)
      for (const [t, wt] of GAUSS_01) {
        const xs = (1 - t) * (p1[0] - p0[0]) + t * (p2[0] - p3[0]);
        const xt = (1 - s) * (p3[0] - p0[0]) + s * (p2[0] - p1[0]);
        const ys = (1 - t) * (p1[1] - p0[1]) + t * (p2[1] - p3[1]);
        const yt = (1 - s) * (p3[1] - p0[1]) + s * (p2[1] - p1[1]);
        const measure = ws * wt * Math.abs(xs * yt - xt * ys);
        const shape = [(1 - s) * (1 - t), s * (1 - t), s * t, (1 - s) * t];
        for (let i = 0; i < 4; i++) {
          integrals[i] += measure * shape[i];
          for (let j = 0; j < 4; j++)
            mass[i][j] += measure * shape[i] * shape[j];
        }
      }
  }
  const massInverse = inverse(mass);
  const coefficients = massInverse.map((row, j) =>
    row.map((value) => integrals[j] * value),
  );
  return { coefficients, integrals };
}

// ── Segmentation ─────────────────────────────────────────────────────────────

// Sutherland–Hodgman: `subject` clipped by the convex, counter-clockwise
// polygon `clip`.
function clipPolygon(
  subject: readonly Point2[],
  clip: readonly Point2[],
): Point2[] {
  let output: Point2[] = [...subject];
  for (let k = 0; k < clip.length && output.length > 0; k++) {
    // eslint-disable-next-line kofem/min-identifier-length -- a, b: the clip edge's endpoints
    const a = clip[k];
    // eslint-disable-next-line kofem/min-identifier-length -- a, b: the clip edge's endpoints
    const b = clip[(k + 1) % clip.length];
    // Signed distance (times |b − a|) of a point from the clip edge's line:
    // ≥ 0 inside. The crossing is interpolated from these values, which stay
    // well defined when an edge of the subject runs along the clip edge.
    const side = (point: Point2) =>
      (b[0] - a[0]) * (point[1] - a[1]) - (b[1] - a[1]) * (point[0] - a[0]);
    const inside = (point: Point2) => side(point) >= 0;
    const crossing = (from: Point2, to: Point2): Point2 => {
      const sideFrom = side(from);
      const along = sideFrom / (sideFrom - side(to));
      return [
        from[0] + along * (to[0] - from[0]),
        from[1] + along * (to[1] - from[1]),
      ];
    };
    const input = output;
    output = [];
    input.forEach((current, i) => {
      const previous = input[(i + input.length - 1) % input.length];
      if (inside(current)) {
        if (!inside(previous)) output.push(crossing(previous, current));
        output.push(current);
      } else if (inside(previous)) output.push(crossing(previous, current));
    });
  }
  return output;
}

// Dunavant's 7-point rule on a triangle (degree 5): barycentric points and
// weights summing to one.
const A1 = 0.0597158717897698,
  B1 = 0.4701420641051151,
  A2 = 0.7974269853530873,
  B2 = 0.1012865073234563;
const W1 = 0.1323941527885062,
  W2 = 0.1259391805448271;
const DUNAVANT_7: readonly [number, number, number, number][] = [
  [1 / 3, 1 / 3, 1 / 3, 0.225],
  [A1, B1, B1, W1],
  [B1, A1, B1, W1],
  [B1, B1, A1, W1],
  [A2, B2, B2, W2],
  [B2, A2, B2, W2],
  [B2, B2, A2, W2],
];

// Faces whose normals are less opposed than this are not treated as facing each
// other across the tie (e.g. the far wall of a cylinder seen through the bore).
const FACING = -0.3;
// A slave node is tied only where the master surface covers at least this much
// of its multiplier support; at the ragged edge of a partial contact the
// normalisation ∫ψ_j over a sliver would be ill-conditioned.
const MIN_COVERAGE = 0.5;

// Add `value` to the entry `key` of a running sum.
function accumulate<K>(sums: Map<K, number>, key: K, value: number): void {
  const previous = sums.get(key);
  sums.set(key, previous === undefined ? value : previous + value);
}

// Mortar weights of every slave node on the slave faces, over the master faces
// within `limit` of them (Infinity for the whole surface).
export function mortarWeights(
  slaveFaces: MortarFace[],
  masterFaces: MortarFace[],
  limit: number,
): Map<number, MortarRow> {
  const masters = masterFaces.map(frameOf);
  let maxRadius = 0;
  for (const master of masters) maxRadius = Math.max(maxRadius, master.radius);
  const cell = Math.max(2 * maxRadius, 1e-9);
  const grid = new SpatialGrid(masters, (master) => master.centroid, cell);
  // Rings needed to reach every master from anywhere near the surface.
  const low: [number, number, number] = [Infinity, Infinity, Infinity];
  const high: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (const face of [...masterFaces, ...slaveFaces])
    for (const point of face.points)
      for (let axis = 0; axis < 3; axis++) {
        low[axis] = Math.min(low[axis], point[axis]);
        high[axis] = Math.max(high[axis], point[axis]);
      }
  const maxRing = Math.ceil(Math.hypot(...sub(high, low)) / cell) + 2;

  const coupling = new Map<number, Map<number, number>>();
  const integralOf = new Map<number, number>();

  for (const original of slaveFaces) {
    const slave = frameOf(original);
    // Counter-clockwise in the slave frame, which the clipping relies on.
    let corners = original.points.map((point) => inPlane(slave, point));
    let ids = original.ids;
    let points = original.points;
    if (signedArea(corners) < 0) {
      corners = [...corners].reverse();
      ids = [...ids].reverse();
      points = [...points].reverse();
    }
    const { coefficients, integrals } = dualBasis(corners);
    ids.forEach((id, i) => accumulate(integralOf, id, integrals[i]));

    // Master faces near enough to overlap this one: within the search reach,
    // or — for a full-surface tie — within one face size of the nearest.
    const nearby: FaceFrame[] = [];
    let nearest = Infinity;
    const reach = Number.isFinite(limit)
      ? limit + slave.radius + maxRadius
      : Infinity;
    for (let ring = 0; ring <= maxRing; ring++) {
      for (const master of grid.candidates(slave.centroid, ring, ring)) {
        if (dot(master.normal, slave.normal) > FACING) continue;
        const distance = Math.hypot(...sub(master.centroid, slave.centroid));
        if (distance > reach) continue;
        nearby.push(master);
        nearest = Math.min(nearest, distance);
      }
      // Every master not yet scanned is at least this far away.
      const scanned = ring * cell - maxRadius;
      if (scanned > reach) break;
      if (scanned > nearest + 2 * (slave.radius + maxRadius)) break;
    }
    const gapLimit = Number.isFinite(limit)
      ? limit
      : nearest + slave.radius + maxRadius;

    for (const master of nearby) {
      let clip = master.face.points.map((point) => inPlane(slave, point));
      if (signedArea(clip) < 0) clip = [...clip].reverse();
      const masterCorners = master.face.points.map((point) =>
        inPlane(slave, point),
      );
      const overlap = clipPolygon(corners, clip);
      if (
        overlap.length < 3 ||
        Math.abs(signedArea(overlap)) < 1e-14 * slave.radius ** 2
      )
        continue;
      for (let k = 1; k + 1 < overlap.length; k++) {
        const [p0, p1, p2] = [overlap[0], overlap[k], overlap[k + 1]];
        const area = Math.abs(signedArea([p0, p1, p2]));
        for (const [l0, l1, l2, weight] of DUNAVANT_7) {
          const quadraturePoint: Point2 = [
            l0 * p0[0] + l1 * p1[0] + l2 * p2[0],
            l0 * p0[1] + l1 * p1[1] + l2 * p2[1],
          ];
          const slaveShape = shapeAt(corners, quadraturePoint);
          const masterShape = shapeAt(masterCorners, quadraturePoint);
          const onSlave = points.reduce<Point3>(
            (sum, point, i) => [
              sum[0] + slaveShape[i] * point[0],
              sum[1] + slaveShape[i] * point[1],
              sum[2] + slaveShape[i] * point[2],
            ],
            [0, 0, 0],
          );
          const onMaster = master.face.points.reduce<Point3>(
            (sum, point, i) => [
              sum[0] + masterShape[i] * point[0],
              sum[1] + masterShape[i] * point[1],
              sum[2] + masterShape[i] * point[2],
            ],
            [0, 0, 0],
          );
          if (Math.hypot(...sub(onMaster, onSlave)) > gapLimit) continue;
          const measure = weight * area;
          ids.forEach((slaveId, j) => {
            let psi = 0;
            for (let i = 0; i < slaveShape.length; i++)
              psi += coefficients[j][i] * slaveShape[i];
            let row = coupling.get(slaveId);
            if (!row) coupling.set(slaveId, (row = new Map()));
            master.face.ids.forEach((masterId, m) =>
              accumulate(row, masterId, measure * psi * masterShape[m]),
            );
          });
        }
      }
    }
  }

  const rows = new Map<number, MortarRow>();
  for (const [slaveId, row] of coupling) {
    let total = 0;
    for (const value of row.values()) total += value;
    const full = integralOf.get(slaveId);
    if (full === undefined || !(full > 0) || !Number.isFinite(total))
      throw new Error(
        `tie: the mortar integrals of node ${slaveId} are not finite — a degenerate face on the tied surface?`,
      );
    const coverage = total / full;
    if (coverage < MIN_COVERAGE) continue;
    const masterIds: number[] = [];
    const weights: number[] = [];
    for (const [masterId, value] of row) {
      const weight = value / total;
      if (Math.abs(weight) < 1e-12) continue;
      masterIds.push(masterId);
      weights.push(weight);
    }
    let sum = 0;
    for (const weight of weights) sum += weight;
    rows.set(slaveId, {
      masterIds,
      weights: weights.map((weight) => weight / sum),
      coverage,
    });
  }
  return rows;
}
