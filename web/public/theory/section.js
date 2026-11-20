// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// The section cut of the Theory Guide's result viewer. A plane normal to one
// axis (x = 0, y = 1, z = 2) at `level` keeps the part of the model below it:
//
//   cutTets      the cap — where the plane cuts the tetrahedra — with the
//                field interpolated linearly along each cut edge, as the
//                field varies over a linear tetrahedron;
//   clipSurface  the boundary surface below the plane, its triangles split
//                where they cross it;
//   sectionMesh  both together: the lower part, closed by its cap.
//
// Plain arrays in, plain arrays out ({ positions, values, triangles }), so
// viewer.js draws it in the browser and the Theory generator draws the same
// cut into the static figure.

/** One crossing per cut edge, shared by the triangles that use it. */
function crossings(positions, values, axis, level, out) {
  const index = new Map();
  return (a, b) => {
    const key = a < b ? `${a},${b}` : `${b},${a}`;
    const known = index.get(key);
    if (known !== undefined) return known;
    const da = positions[3 * a + axis] - level;
    const db = positions[3 * b + axis] - level;
    const t = da / (da - db);
    for (let k = 0; k < 3; k++)
      out.positions.push(
        positions[3 * a + k] +
          t * (positions[3 * b + k] - positions[3 * a + k]),
      );
    out.values.push(values[a] + t * (values[b] - values[a]));
    const id = out.values.length - 1;
    index.set(key, id);
    return id;
  };
}

function checkAxis(axis) {
  if (axis !== 0 && axis !== 1 && axis !== 2)
    throw new Error(`section axis must be 0, 1 or 2, got ${axis}`);
}

/**
 * The cap where the plane cuts the tetrahedra: a triangle where it separates
 * one corner from three, two where it separates two from two.
 */
export function cutTets({ positions, tets, values }, axis, level) {
  checkAxis(axis);
  const out = { positions: [], values: [], triangles: [] };
  const cross = crossings(positions, values, axis, level, out);
  for (let e = 0; e < tets.length; e += 4) {
    const corners = [tets[e], tets[e + 1], tets[e + 2], tets[e + 3]];
    const below = corners.filter((n) => positions[3 * n + axis] < level);
    const above = corners.filter((n) => positions[3 * n + axis] >= level);
    if (below.length === 0 || above.length === 0) continue;
    if (below.length === 2) {
      const [a, b] = below;
      const [c, d] = above;
      const ring = [cross(a, c), cross(a, d), cross(b, d), cross(b, c)];
      facing(out, axis, ring[0], ring[1], ring[2]);
      facing(out, axis, ring[0], ring[2], ring[3]);
    } else {
      const [lone, others] =
        below.length === 1 ? [below[0], above] : [above[0], below];
      const [p, q, r] = others.map((other) => cross(lone, other));
      facing(out, axis, p, q, r);
    }
  }
  return out;
}

/**
 * Add a cap triangle wound so its normal points along +axis, out of the
 * part kept below the plane: shading then lights the whole cap alike.
 */
function facing(out, axis, a, b, c) {
  const at = (n, k) => out.positions[3 * n + k];
  const [u, v] = [(axis + 1) % 3, (axis + 2) % 3];
  const normal =
    (at(b, u) - at(a, u)) * (at(c, v) - at(a, v)) -
    (at(b, v) - at(a, v)) * (at(c, u) - at(a, u));
  if (normal >= 0) out.triangles.push(a, b, c);
  else out.triangles.push(a, c, b);
}

/**
 * The boundary triangles below the plane; a triangle crossing it is cut
 * along it (Sutherland–Hodgman on one plane) and fanned back into triangles.
 */
export function clipSurface({ positions, values, triangles }, axis, level) {
  checkAxis(axis);
  const out = { positions: [], values: [], triangles: [] };
  const kept = new Map();
  const keep = (n) => {
    const known = kept.get(n);
    if (known !== undefined) return known;
    for (let k = 0; k < 3; k++) out.positions.push(positions[3 * n + k]);
    out.values.push(values[n]);
    const id = out.values.length - 1;
    kept.set(n, id);
    return id;
  };
  const cross = crossings(positions, values, axis, level, out);
  const inside = (n) => positions[3 * n + axis] <= level;
  for (let t = 0; t < triangles.length; t += 3) {
    const loop = [triangles[t], triangles[t + 1], triangles[t + 2]];
    const polygon = [];
    for (let k = 0; k < 3; k++) {
      const a = loop[k];
      const b = loop[(k + 1) % 3];
      if (inside(a)) polygon.push(keep(a));
      if (inside(a) !== inside(b)) polygon.push(cross(a, b));
    }
    for (let k = 1; k + 1 < polygon.length; k++)
      out.triangles.push(polygon[0], polygon[k], polygon[k + 1]);
  }
  return out;
}

/** The part of the model below the plane: its clipped boundary and its cap. */
export function sectionMesh(model, axis, level) {
  const surface = clipSurface(model, axis, level);
  const cap = cutTets(model, axis, level);
  const offset = surface.values.length;
  return {
    positions: [...surface.positions, ...cap.positions],
    values: [...surface.values, ...cap.values],
    triangles: [...surface.triangles, ...cap.triangles.map((n) => n + offset)],
  };
}
