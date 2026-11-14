// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// CAD edges for the landing bracket, read from a tessellated STEP (AP242
// COMPLEX_TRIANGULATED_FACE). Only the sharp edges leave this module: the
// landing page ships those line segments, never the source geometry.

function entityText(step, id) {
  const start = step.indexOf(`#${id}=`);
  if (start < 0) throw Error(`STEP entity #${id} is missing`);
  let quoted = false;
  for (let i = start; i < step.length; i++) {
    if (step[i] === "'") quoted = !quoted;
    else if (step[i] === ";" && !quoted) return step.slice(start, i);
  }
  throw Error(`STEP entity #${id} is not terminated`);
}

// Top-level comma-separated arguments of `NAME(...)`, nesting kept intact.
function argumentsOf(text) {
  const open = text.indexOf("(");
  const close = text.lastIndexOf(")");
  if (open < 0 || close < open) throw Error(`Malformed STEP entity: ${text}`);
  const result = [];
  let depth = 0,
    quoted = false,
    current = "";
  for (const ch of text.slice(open + 1, close)) {
    if (ch === "'") quoted = !quoted;
    if (!quoted && ch === "(") depth++;
    if (!quoted && ch === ")") depth--;
    if (!quoted && depth === 0 && ch === ",") {
      result.push(current.trim());
      current = "";
    } else current += ch;
  }
  result.push(current.trim());
  return result;
}

// A STEP list of lists, "((1,2,3),(4,5,6))", as arrays of numbers.
function nestedNumbers(text) {
  return [...text.matchAll(/\(([^()]*)\)/g)].map(([, inner]) =>
    inner.split(",").map((value) => {
      const number = Number(value.trim());
      if (!Number.isFinite(number))
        throw Error(`Non-numeric STEP list entry "${value}"`);
      return number;
    }),
  );
}

function flatNumbers(text) {
  if (text === "$" || text === "()") return [];
  return nestedNumbers(text)[0];
}

export function parseTriangulatedStep(step) {
  const match = /#(\d+)=COMPLEX_TRIANGULATED_FACE\(/.exec(step);
  if (!match)
    throw Error(
      "The STEP file has no COMPLEX_TRIANGULATED_FACE: export it with tessellated geometry",
    );
  const face = argumentsOf(entityText(step, match[1]));
  if (face.length !== 8)
    throw Error(
      `COMPLEX_TRIANGULATED_FACE has ${face.length} arguments, expected 8`,
    );
  const coordinatesId = /^#(\d+)$/.exec(face[1]);
  if (!coordinatesId)
    throw Error(`COMPLEX_TRIANGULATED_FACE coordinates are ${face[1]}`);
  const coordinates = argumentsOf(entityText(step, coordinatesId[1]));
  const points = nestedNumbers(coordinates[2]);
  if (points.length !== Number(coordinates[1]))
    throw Error(
      `COORDINATES_LIST declares ${coordinates[1]} points but holds ${points.length}`,
    );
  const pnindex = flatNumbers(face[5]);
  const point = (index) => {
    const coordinate = pnindex.length ? pnindex[index - 1] : index;
    if (!(coordinate >= 1 && coordinate <= points.length))
      throw Error(`Triangle index ${index} is outside the point list`);
    return coordinate - 1;
  };
  const triangles = [];
  const add = (a, b, c) => {
    const triangle = [point(a), point(b), point(c)];
    if (new Set(triangle).size === 3) triangles.push(triangle);
  };
  for (const strip of face[6] === "()" ? [] : nestedNumbers(face[6]))
    for (let k = 0; k + 2 < strip.length; k++)
      if (k % 2 === 0) add(strip[k], strip[k + 1], strip[k + 2]);
      else add(strip[k + 1], strip[k], strip[k + 2]);
  for (const fan of face[7] === "()" ? [] : nestedNumbers(face[7]))
    for (let k = 1; k + 1 < fan.length; k++) add(fan[0], fan[k], fan[k + 1]);
  if (!triangles.length) throw Error("The triangulated face has no triangles");
  return { points, triangles };
}

function unitNormal(points, [first, second, third]) {
  const along = points[second].map(
    (value, axis) => value - points[first][axis],
  );
  const across = points[third].map(
    (value, axis) => value - points[first][axis],
  );
  const normal = [
    along[1] * across[2] - along[2] * across[1],
    along[2] * across[0] - along[0] * across[2],
    along[0] * across[1] - along[1] * across[0],
  ];
  const length = Math.hypot(...normal);
  return length > 0 ? normal.map((value) => value / length) : null;
}

// Edges whose two triangles meet at more than minAngleDeg, as point pairs.
// A finely tessellated fillet bends by a few degrees per edge and is skipped.
export function sharpEdges(points, triangles, minAngleDeg) {
  const faces = new Map();
  triangles.forEach((triangle, face) => {
    for (let corner = 0; corner < 3; corner++) {
      const from = triangle[corner],
        to = triangle[(corner + 1) % 3];
      const key = from < to ? `${from},${to}` : `${to},${from}`;
      const list = faces.get(key);
      if (list) list.push(face);
      else faces.set(key, [face]);
    }
  });
  const normals = triangles.map((triangle) => unitNormal(points, triangle));
  const minCos = Math.cos((minAngleDeg * Math.PI) / 180);
  const segments = [];
  for (const [key, list] of faces) {
    if (list.length !== 2)
      throw Error(
        `The surface is not closed: edge ${key} borders ${list.length} triangles`,
      );
    const [n1, n2] = list.map((face) => normals[face]);
    // A zero-area sliver has no direction; its neighbours decide the edge.
    if (!n1 || !n2) continue;
    const cos = n1[0] * n2[0] + n1[1] * n2[1] + n1[2] * n2[2];
    if (cos < minCos) {
      const [from, to] = key.split(",").map(Number);
      segments.push([points[from], points[to]]);
    }
  }
  return segments;
}
