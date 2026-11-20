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
  return (from, to) => {
    const key = from < to ? `${from},${to}` : `${to},${from}`;
    const known = index.get(key);
    if (known !== undefined) return known;
    const near = positions[3 * from + axis] - level;
    const far = positions[3 * to + axis] - level;
    const fraction = near / (near - far);
    for (let component = 0; component < 3; component++)
      out.positions.push(
        positions[3 * from + component] +
          fraction *
            (positions[3 * to + component] - positions[3 * from + component]),
      );
    out.values.push(values[from] + fraction * (values[to] - values[from]));
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
    const below = corners.filter((node) => positions[3 * node + axis] < level);
    const above = corners.filter((node) => positions[3 * node + axis] >= level);
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
function facing(out, axis, one, two, three) {
  const at = (node, component) => out.positions[3 * node + component];
  const [first, second] = [(axis + 1) % 3, (axis + 2) % 3];
  const normal =
    (at(two, first) - at(one, first)) * (at(three, second) - at(one, second)) -
    (at(two, second) - at(one, second)) * (at(three, first) - at(one, first));
  if (normal >= 0) out.triangles.push(one, two, three);
  else out.triangles.push(one, three, two);
}

/**
 * The boundary triangles below the plane; a triangle crossing it is cut
 * along it (Sutherland–Hodgman on one plane) and fanned back into triangles.
 */
export function clipSurface({ positions, values, triangles }, axis, level) {
  checkAxis(axis);
  const out = { positions: [], values: [], triangles: [] };
  const kept = new Map();
  const keep = (node) => {
    const known = kept.get(node);
    if (known !== undefined) return known;
    for (let component = 0; component < 3; component++)
      out.positions.push(positions[3 * node + component]);
    out.values.push(values[node]);
    const id = out.values.length - 1;
    kept.set(node, id);
    return id;
  };
  const cross = crossings(positions, values, axis, level, out);
  const inside = (node) => positions[3 * node + axis] <= level;
  for (let first = 0; first < triangles.length; first += 3) {
    const loop = [triangles[first], triangles[first + 1], triangles[first + 2]];
    const polygon = [];
    for (let corner = 0; corner < 3; corner++) {
      const from = loop[corner];
      const to = loop[(corner + 1) % 3];
      if (inside(from)) polygon.push(keep(from));
      if (inside(from) !== inside(to)) polygon.push(cross(from, to));
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
    triangles: [
      ...surface.triangles,
      ...cap.triangles.map((node) => node + offset),
    ],
  };
}
