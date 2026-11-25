// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Element sizes on selected CAD faces (KOF-394). generate_fem_mesh takes
// face_max_sizes: Netgen meshes each listed face at its size and grades the
// volume from there to the body size. Without face sizes the mesh is the one
// the global size makes, and a face size that cannot be applied is an error.
//
// The geometry is the plate-with-hole example's quarter strip, made 5 mm thick
// so the hole is not already refined by the elements Netgen puts along a thin
// plate's thickness edge.

import { beforeAll, describe, expect, test } from "bun:test";
import { quarterStripWithHoleStep } from "../../../examples/gallery/step-prism.mjs";
import { loadEngine } from "../support/wasm.mjs";

const HOLE_RADIUS = 10; // mm
const HALF_WIDTH = 50; // mm
const HALF_LENGTH = 150; // mm
const THICKNESS = 5; // mm
const BODY_SIZE = 5; // mm
const HOLE_SIZE = 0.5; // mm

const STEP = new TextEncoder().encode(
  quarterStripWithHoleStep(
    HOLE_RADIUS,
    HALF_WIDTH,
    HALF_LENGTH,
    THICKNESS,
    "Quarter strip with a hole",
  ),
);
const TESSELLATION = JSON.stringify({
  deflection_relative: 0.001,
  angular_deflection: 0.5,
  format: "step",
});

function options(faceMaxSizes) {
  return JSON.stringify({
    max_element_size: BODY_SIZE,
    min_element_size: 0.05,
    ...(faceMaxSizes ? { face_max_sizes: faceMaxSizes } : {}),
    grading: 0.3,
    second_order: false,
    elementsperedge: 2,
    elementspercurve: 2,
    optsteps_2d: 3,
    optsteps_3d: 3,
  });
}

// The CAD face whose display tessellation lies entirely where `inside` holds.
function faceWhere(tessellation, inside) {
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
  const faces = [...matches].filter(([, all]) => all).map(([face]) => face);
  if (faces.length !== 1)
    throw new Error(`expected one matching face, found ${faces.length}`);
  return faces[0];
}

// Mean edge length of the surface elements Netgen made on `face`.
function meanEdgeOnFace(mesh, face) {
  const { vertices, surfaceTriangles, surfaceFaceIds } = mesh;
  const point = (i) => [
    vertices[3 * i],
    vertices[3 * i + 1],
    vertices[3 * i + 2],
  ];
  let sum = 0;
  let count = 0;
  for (let tri = 0; tri < surfaceFaceIds.length; tri++) {
    if (surfaceFaceIds[tri] !== face) continue;
    const corners = [0, 1, 2].map((k) => point(surfaceTriangles[3 * tri + k]));
    for (let k = 0; k < 3; k++) {
      const [p, q] = [corners[k], corners[(k + 1) % 3]];
      sum += Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);
      count++;
    }
  }
  if (count === 0) throw new Error(`no surface elements on face ${face}`);
  return sum / count;
}

// Mean edge length of the tetrahedra whose centroid lies within
// [from, to) of the hole axis: how the size grades away from the hole.
function meanTetEdgeBetween(mesh, from, to) {
  const { vertices, tetrahedra } = mesh;
  let sum = 0;
  let count = 0;
  for (let t = 0; t < tetrahedra.length; t += 4) {
    const ids = [0, 1, 2, 3].map((k) => tetrahedra[t + k]);
    const corners = ids.map((i) => [
      vertices[3 * i],
      vertices[3 * i + 1],
      vertices[3 * i + 2],
    ]);
    const cx = corners.reduce((total, c) => total + c[0], 0) / 4;
    const cy = corners.reduce((total, c) => total + c[1], 0) / 4;
    const radius = Math.hypot(cx, cy);
    if (radius < from || radius >= to) continue;
    for (let a = 0; a < 4; a++)
      for (let b = a + 1; b < 4; b++) {
        sum += Math.hypot(
          corners[a][0] - corners[b][0],
          corners[a][1] - corners[b][1],
          corners[a][2] - corners[b][2],
        );
        count++;
      }
  }
  if (count === 0) throw new Error(`no tetrahedra between r=${from} and ${to}`);
  return sum / count;
}

function meshOf(engine, faceMaxSizes) {
  const mesh = engine.generate_fem_mesh(options(faceMaxSizes));
  if ("overlaps" in mesh)
    throw new Error(`did not mesh: ${JSON.stringify(mesh.overlaps)}`);
  return mesh;
}

function errorOf(engine, faceMaxSizes) {
  try {
    engine.generate_fem_mesh(options(faceMaxSizes));
  } catch (error) {
    return String(engine.getExceptionMessage?.(error) ?? error);
  }
  return null;
}

const summary = (mesh) => ({
  nodes: mesh.vertices.length / 3,
  tets: mesh.tetrahedra.length / 4,
});

async function loadedEngine() {
  const engine = await loadEngine();
  const tessellation = engine.tessellate_step(STEP, TESSELLATION);
  return { engine, tessellation };
}

describe("element sizes on selected faces", () => {
  let hole = 0;
  let end = 0;
  let plain = null;
  let sized = null;
  let emptyList = null;
  let clearedAfterSized = null;
  let unknownFace = null;
  let zeroSize = null;
  let negativeSize = null;

  beforeAll(async () => {
    const fresh = await loadedEngine();
    const { engine, tessellation } = fresh;
    hole = faceWhere(
      tessellation,
      (x, y) => Math.abs(Math.hypot(x, y) - HOLE_RADIUS) < 1e-3,
    );
    end = faceWhere(tessellation, (x) => Math.abs(x - HALF_LENGTH) < 1e-6);

    sized = meshOf(engine, [{ face: hole, max_size: HOLE_SIZE }]);
    clearedAfterSized = summary(meshOf(engine, undefined));
    emptyList = summary(meshOf(engine, []));
    unknownFace = errorOf(engine, [{ face: 999, max_size: HOLE_SIZE }]);
    zeroSize = errorOf(engine, [{ face: hole, max_size: 0 }]);
    negativeSize = errorOf(engine, [{ face: hole, max_size: -1 }]);

    plain = meshOf((await loadedEngine()).engine, undefined);
  });

  test("the hole face meshes at the face size", () => {
    const before = meanEdgeOnFace(plain, hole);
    const after = meanEdgeOnFace(sized, hole);
    console.log(
      `hole face mean edge: ${before.toFixed(3)} mm without, ${after.toFixed(3)} mm with a ${HOLE_SIZE} mm face size`,
    );
    expect(before).toBeGreaterThan(2 * HOLE_SIZE);
    expect(after).toBeLessThan(1.3 * HOLE_SIZE);
  });

  test("away from the face the mesh keeps the body size", () => {
    const before = meanEdgeOnFace(plain, end);
    const after = meanEdgeOnFace(sized, end);
    console.log(
      `end face mean edge: ${before.toFixed(3)} mm without, ${after.toFixed(3)} mm with`,
    );
    expect(after).toBeGreaterThan(0.8 * before);
  });

  test("the size grades from the face to the body size", () => {
    const rings = [
      [HOLE_RADIUS, HOLE_RADIUS + 1],
      [HOLE_RADIUS + 5, HOLE_RADIUS + 7],
      [HOLE_RADIUS + 20, HOLE_RADIUS + 25],
      [100, 140],
    ].map(([from, to]) => ({
      from,
      to,
      size: meanTetEdgeBetween(sized, from, to),
      plain: meanTetEdgeBetween(plain, from, to),
    }));
    for (const ring of rings)
      console.log(
        `r ∈ [${ring.from}, ${ring.to}) mm: tet edge ${ring.size.toFixed(3)} mm with the face size, ${ring.plain.toFixed(3)} mm without`,
      );
    const [atFace, near, mid, far] = rings;
    // Finest at the face, coarser outwards, and back at the body size by the
    // time the plate is plain strip again.
    expect(atFace.size).toBeLessThan(2 * HOLE_SIZE);
    expect(near.size).toBeGreaterThan(atFace.size);
    expect(mid.size).toBeGreaterThan(near.size);
    expect(mid.size).toBeGreaterThan(0.8 * mid.plain);
    expect(far.size).toBeGreaterThan(0.8 * far.plain);
  });

  test("a face size adds elements", () => {
    console.log(
      `tetrahedra: ${summary(plain).tets} without, ${summary(sized).tets} with the face size`,
    );
    expect(summary(sized).tets).toBeGreaterThan(summary(plain).tets);
  });

  test("no face size, or an empty list, meshes as before", () => {
    expect(emptyList).toEqual(summary(plain));
  });

  test("a face size does not outlive the mesh it was set for", () => {
    expect(clearedAfterSized).toEqual(summary(plain));
  });

  test("a face the geometry does not have is an error", () => {
    expect(unknownFace).toContain("face 999");
  });

  test("a size that is not positive is an error", () => {
    expect(zeroSize).toContain("must be a positive number");
    expect(negativeSize).toContain("must be a positive number");
  });
});
