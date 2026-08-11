// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Starting element size for a freshly imported part (KOF-222). A fixed default
// only ever suits one scale of model: 20 mm meshes a bracket sensibly and a
// 1 mm cube not at all. This sizes the mesh to the geometry instead, aiming at
// a target element count.

// Element count a default mesh aims for: fine enough to see a stress field,
// coarse enough to mesh and solve in the browser.
export const TARGET_ELEMENT_COUNT = 50_000;

// Default ratio between the two size fields. min_element_size floors Netgen's
// curvature-driven refinement; h/10 is what the worker assumes when a caller
// sends no minimum.
export const MIN_SIZE_RATIO = 10;

export interface GeometryMeasure {
  // Bounding box side lengths, in mm.
  dx: number;
  dy: number;
  dz: number;
  // Enclosed volume and boundary area of the tessellated shape, mm³ and mm².
  volume: number;
  area: number;
}

// Volume, area and bounding box of the display tessellation. The volume is the
// divergence-theorem sum over the closed surface, V = (1/6) Σ a·(b×c) — exact
// for the tessellated polyhedron, and within a fraction of a percent of the CAD
// volume at the deflection the viewer tessellates with. (OCCT's
// BRepGProp::VolumeProperties would give the exact CAD value, but reaching it
// from here needs a new engine entry point and a WASM rebuild; the difference is
// far below the accuracy this estimate claims.) Open, surface-only geometry
// yields volume ≈ 0, which sizeFromMeasure handles via the area term alone.
export function measureTessellation(
  points: [number, number, number][],
  triangles: [number, number, number][],
): GeometryMeasure | null {
  if (points.length === 0 || triangles.length === 0) return null;

  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (const point of points) {
    for (let i = 0; i < 3; i++) {
      if (point[i] < min[i]) min[i] = point[i];
      if (point[i] > max[i]) max[i] = point[i];
    }
  }

  let sixVolume = 0;
  let area = 0;
  for (const [ia, ib, ic] of triangles) {
    const pa = points[ia];
    const pb = points[ib];
    const pc = points[ic];
    if (pa === undefined || pb === undefined || pc === undefined)
      throw new Error(
        `measureTessellation: triangle (${ia}, ${ib}, ${ic}) references a vertex outside the ${points.length}-point tessellation`,
      );
    sixVolume +=
      pa[0] * (pb[1] * pc[2] - pb[2] * pc[1]) -
      pa[1] * (pb[0] * pc[2] - pb[2] * pc[0]) +
      pa[2] * (pb[0] * pc[1] - pb[1] * pc[0]);
    const ux = pb[0] - pa[0];
    const uy = pb[1] - pa[1];
    const uz = pb[2] - pa[2];
    const vx = pc[0] - pa[0];
    const vy = pc[1] - pa[1];
    const vz = pc[2] - pa[2];
    area +=
      0.5 * Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx);
  }

  return {
    dx: max[0] - min[0],
    dy: max[1] - min[1],
    dz: max[2] - min[2],
    volume: Math.abs(sixVolume) / 6,
    area,
  };
}

// Elements Netgen produces at element size h. Two terms, because two regimes
// exist: a bulky part fills its volume with roughly 6 tets per h³ cell (the
// structured hex-to-tet split), while a thin or heavily featured part is
// dominated by its boundary — the surface mesh alone carries ~2 triangles per h²
// and each seeds tets through the wall. Ignoring the surface term made a
// thin-walled crane holder (160,000 mm² of surface over 57,000 mm³) come out at
// 190K tets when 50K was asked for. Both coefficients are empirical, calibrated
// against Netgen on the parts in test_files/; they hold the prediction inside
// 0.6–1.3x of the target across bulky, hollow and thin-walled geometry.
const TETS_PER_VOLUME_CELL = 6;
const TRIANGLES_PER_AREA_CELL = 2;

export function estimateElementCount(
  measure: GeometryMeasure,
  size: number,
): number {
  return (
    (TETS_PER_VOLUME_CELL * measure.volume) / size ** 3 +
    (TRIANGLES_PER_AREA_CELL * measure.area) / size ** 2
  );
}

// Largest element size whose estimated count still reaches `target`. The count
// falls monotonically with size, so a geometric bisection over the size range
// inverts it — no closed form is needed for the mixed cubic/quadratic.
export function sizeFromMeasure(
  measure: GeometryMeasure,
  target = TARGET_ELEMENT_COUNT,
): number | null {
  const diagonal = Math.hypot(measure.dx, measure.dy, measure.dz);
  if (!Number.isFinite(diagonal) || diagonal <= 0) return null;
  if (estimateElementCount(measure, diagonal) <= 0) return null;

  // The whole part in one element is coarser than any useful mesh, and 1e-6 of
  // the diagonal is finer than any; the answer is strictly between.
  let coarse = diagonal;
  let fine = diagonal * 1e-6;
  for (let i = 0; i < 100; i++) {
    const mid = Math.sqrt(coarse * fine);
    if (estimateElementCount(measure, mid) > target) fine = mid;
    else coarse = mid;
  }
  const size = Math.sqrt(coarse * fine);
  return Number.isFinite(size) && size > 0 ? size : null;
}

// Round to three significant digits so the suggestion reads as a mesh setting
// ("2.95 mm") rather than a raw solve of the estimator ("2.9537841...").
export function formatElementSize(size: number): string {
  return Number(size.toPrecision(3)).toString();
}

// The pair of sizes a fresh import starts from: max sized to the target count,
// min at the ratio the worker would have assumed anyway.
export function suggestElementSizes(
  points: [number, number, number][],
  triangles: [number, number, number][],
  target = TARGET_ELEMENT_COUNT,
): { max: string; min: string; measure: GeometryMeasure } | null {
  const measure = measureTessellation(points, triangles);
  if (!measure) return null;
  const size = sizeFromMeasure(measure, target);
  if (size === null) return null;
  return {
    max: formatElementSize(size),
    min: formatElementSize(size / MIN_SIZE_RATIO),
    measure,
  };
}
