// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Finding CAD faces by where they are, on the display tessellation that
// tessellate_step returns. Face ids are what OCCT assigns on import, so a test
// names a face by its geometry rather than by a number it would have to guess.

/**
 * The CAD faces whose display tessellation lies entirely where `inside` holds.
 *
 * @param {{ vertices: ArrayLike<number>, triangles: ArrayLike<number>, triangleFaceIds: ArrayLike<number> }} tessellation
 * @param {(x: number, y: number, z: number) => boolean} inside
 * @returns {number[]} sorted face ids
 */
export function facesWhere(tessellation, inside) {
  const { vertices, triangles, triangleFaceIds } = tessellation;
  const matches = new Map();
  for (let tri = 0; tri < triangleFaceIds.length; tri++) {
    const face = triangleFaceIds[tri];
    let all = matches.get(face) ?? true;
    for (let corner = 0; corner < 3; corner++) {
      const at = 3 * triangles[3 * tri + corner];
      all &&= inside(vertices[at], vertices[at + 1], vertices[at + 2]);
    }
    matches.set(face, all);
  }
  return [...matches]
    .filter(([, all]) => all)
    .map(([face]) => face)
    .sort((a, b) => a - b);
}

/**
 * The one CAD face whose display tessellation lies entirely where `inside`
 * holds; an error when none or several do.
 *
 * @param {Parameters<typeof facesWhere>[0]} tessellation
 * @param {(x: number, y: number, z: number) => boolean} inside
 * @returns {number}
 */
export function faceWhere(tessellation, inside) {
  const faces = facesWhere(tessellation, inside);
  if (faces.length !== 1)
    throw new Error(
      `expected one matching face, found ${faces.length}: ${faces.join(", ")}`,
    );
  return faces[0];
}

/**
 * Every CAD face of the tessellation.
 *
 * @param {Parameters<typeof facesWhere>[0]} tessellation
 * @returns {number[]} sorted face ids
 */
export function allFaces(tessellation) {
  return [...new Set(Array.from(tessellation.triangleFaceIds))].sort(
    (a, b) => a - b,
  );
}

/**
 * Distance of (x, y) from the line through `start` and `end`, in the xy plane:
 * which side face of an extruded outline a point lies on.
 *
 * @param {[number, number]} start
 * @param {[number, number]} end
 * @param {number} x
 * @param {number} y
 */
export function distanceFromLine(start, end, x, y) {
  const along = [end[0] - start[0], end[1] - start[1]];
  return (
    Math.abs(along[0] * (y - start[1]) - along[1] * (x - start[0])) /
    Math.hypot(along[0], along[1])
  );
}
