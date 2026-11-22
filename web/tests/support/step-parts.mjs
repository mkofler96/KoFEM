// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Checks a STEP part written by examples/gallery/step-*.mjs against the real
// engine, through the calls the app makes on import and mesh
// (web/src/workers/solver.worker.ts): tessellate_step (OCCT) and
// generate_fem_mesh (Netgen, the worker's options). Shared by
// step-prism.test.mjs and step-revolve.test.mjs.

import { beforeAll, describe, expect, test } from "bun:test";
import { loadEngine } from "./wasm.mjs";

export const TESSELLATION_OPTIONS = JSON.stringify({
  deflection_relative: 0.001,
  angular_deflection: 0.5,
  format: "step",
});

/**
 * @typedef {object} ExpectedFace
 * @property {string} label
 * @property {(x: number, y: number, z: number) => number} distance  0 on the face's surface
 * @property {number} area  analytic face area (mm²)
 */

/**
 * Import `step`, mesh it and check both against the analytic part.
 *
 * @param {string} label
 * @param {string} step
 * @param {ExpectedFace[]} faces  in CAD face id order (id = index + 1)
 * @param {number} volume         analytic volume (mm³)
 * @param {number} size           extent of the part (mm), for tolerances
 * @param {number} maxElementSize the mesh size to check the volume at (mm)
 * @param {object} [options]
 * @param {number} [options.areaTolerance]  relative tolerance on each face's
 *   tessellated area (default 2 %: a coarse chord inscribes curved faces)
 */
export function describePart(
  label,
  step,
  faces,
  volume,
  size,
  maxElementSize,
  { areaTolerance = 0.02 } = {},
) {
  // Float32 display vertices: allow a few ulps of the part's size.
  const tolerance = 4e-6 * size;

  describe(label, () => {
    let tess = null;
    let worst = null;
    let area = null;
    let dto = null;

    beforeAll(async () => {
      const engine = await loadEngine();
      tess = engine.tessellate_step(
        new TextEncoder().encode(step),
        TESSELLATION_OPTIONS,
      );
      const points = tess.vertices;
      const triangles = tess.triangles;
      const faceIds = tess.triangleFaceIds;
      worst = faces.map(() => 0);
      area = faces.map(() => 0);
      for (let triangle = 0; triangle < faceIds.length; triangle++) {
        const faceIndex = faceIds[triangle] - 1;
        if (!faces[faceIndex]) continue;
        const corners = [0, 1, 2].map((corner) => {
          const vertex = triangles[3 * triangle + corner];
          return [
            points[3 * vertex],
            points[3 * vertex + 1],
            points[3 * vertex + 2],
          ];
        });
        for (const [coordX, coordY, coordZ] of corners)
          worst[faceIndex] = Math.max(
            worst[faceIndex],
            Math.abs(faces[faceIndex].distance(coordX, coordY, coordZ)),
          );
        const edgeA = [0, 1, 2].map(
          (axis) => corners[1][axis] - corners[0][axis],
        );
        const edgeB = [0, 1, 2].map(
          (axis) => corners[2][axis] - corners[0][axis],
        );
        area[faceIndex] +=
          Math.hypot(
            edgeA[1] * edgeB[2] - edgeA[2] * edgeB[1],
            edgeA[2] * edgeB[0] - edgeA[0] * edgeB[2],
            edgeA[0] * edgeB[1] - edgeA[1] * edgeB[0],
          ) / 2;
      }

      // Mesh with the app worker's exact options.
      dto = engine.generate_fem_mesh(
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
    });

    test("one body", () => {
      expect(tess.bodyCount).toBe(1);
    });

    test(`${faces.length} CAD faces`, () => {
      const ids = [...new Set(tess.triangleFaceIds)].sort(
        (left, right) => left - right,
      );
      expect(ids).toEqual(faces.map((_, index) => index + 1));
    });

    test.each(faces.map((face, index) => [index + 1, face.label, index]))(
      "face %d is %s",
      (_id, _label, index) => {
        expect(
          worst[index],
          `max distance ${worst[index].toExponential(2)} mm`,
        ).toBeLessThanOrEqual(tolerance);
      },
    );

    // Display tessellation inscribes curved faces; a coarse chord loses ~1 %.
    test.each(faces.map((face, index) => [index + 1, face.label, index]))(
      "face %d (%s) has its analytic area",
      (_id, _label, index) => {
        const relative = area[index] / faces[index].area - 1;
        expect(
          Math.abs(relative),
          `${(relative * 100).toFixed(3)} %`,
        ).toBeLessThan(areaTolerance);
      },
    );

    test("tets consistently oriented, none degenerate", () => {
      const verts = dto.vertices;
      const tetNodes = dto.tetrahedra;
      const tetCount = tetNodes.length / 4;
      let positive = 0;
      let degenerate = 0;
      for (let element = 0; element < tetCount; element++) {
        const corners = [0, 1, 2, 3].map((corner) => {
          const vertex = tetNodes[4 * element + corner];
          return [
            verts[3 * vertex],
            verts[3 * vertex + 1],
            verts[3 * vertex + 2],
          ];
        });
        const edgeA = [0, 1, 2].map(
          (axis) => corners[1][axis] - corners[0][axis],
        );
        const edgeB = [0, 1, 2].map(
          (axis) => corners[2][axis] - corners[0][axis],
        );
        const edgeC = [0, 1, 2].map(
          (axis) => corners[3][axis] - corners[0][axis],
        );
        const det =
          edgeA[0] * (edgeB[1] * edgeC[2] - edgeB[2] * edgeC[1]) -
          edgeA[1] * (edgeB[0] * edgeC[2] - edgeB[2] * edgeC[0]) +
          edgeA[2] * (edgeB[0] * edgeC[1] - edgeB[1] * edgeC[0]);
        if (det > 0) positive++;
        if (Math.abs(det) < 1e-12 * size ** 3) degenerate++;
      }
      const detail = `${tetCount} tets, ${positive} positive, ${degenerate} degenerate`;
      expect(tetCount, detail).toBeGreaterThan(0);
      expect(positive === 0 || positive === tetCount, detail).toBe(true);
      expect(degenerate, detail).toBe(0);
    });

    test("one body in the mesh", () => {
      expect(Array.from(dto.bodyIds).every((body) => body === 1)).toBe(true);
    });

    test(`mesh volume within 0.5 % (h = ${maxElementSize} mm)`, () => {
      const verts = dto.vertices;
      const tetNodes = dto.tetrahedra;
      const tetCount = tetNodes.length / 4;
      let sum = 0;
      for (let element = 0; element < tetCount; element++) {
        const corners = [0, 1, 2, 3].map((corner) => {
          const vertex = tetNodes[4 * element + corner];
          return [
            verts[3 * vertex],
            verts[3 * vertex + 1],
            verts[3 * vertex + 2],
          ];
        });
        const edgeA = [0, 1, 2].map(
          (axis) => corners[1][axis] - corners[0][axis],
        );
        const edgeB = [0, 1, 2].map(
          (axis) => corners[2][axis] - corners[0][axis],
        );
        const edgeC = [0, 1, 2].map(
          (axis) => corners[3][axis] - corners[0][axis],
        );
        sum +=
          (edgeA[0] * (edgeB[1] * edgeC[2] - edgeB[2] * edgeC[1]) -
            edgeA[1] * (edgeB[0] * edgeC[2] - edgeB[2] * edgeC[0]) +
            edgeA[2] * (edgeB[0] * edgeC[1] - edgeB[1] * edgeC[0])) /
          6;
      }
      const volumeError = Math.abs(sum) / volume - 1;
      expect(
        Math.abs(volumeError),
        `${(volumeError * 100).toFixed(4)} %, ${tetCount} tets`,
      ).toBeLessThan(0.005);
    });

    // The Netgen surface mesh keeps the same face ids on the same surfaces.
    test("mesh surface triangles lie on their CAD faces", () => {
      const verts = dto.vertices;
      const surface = dto.surfaceTriangles;
      const surfaceFaces = dto.surfaceFaceIds;
      const meshIds = [...new Set(surfaceFaces)];
      let off = 0;
      for (let triangle = 0; triangle < surfaceFaces.length; triangle++) {
        const face = faces[surfaceFaces[triangle] - 1];
        if (!face) {
          off = Infinity;
          continue;
        }
        for (let corner = 0; corner < 3; corner++) {
          const vertex = surface[3 * triangle + corner];
          off = Math.max(
            off,
            Math.abs(
              face.distance(
                verts[3 * vertex],
                verts[3 * vertex + 1],
                verts[3 * vertex + 2],
              ),
            ),
          );
        }
      }
      const detail = `${meshIds.length} faces, max distance ${off.toExponential(2)} mm`;
      expect(meshIds.length, detail).toBe(faces.length);
      expect(off, detail).toBeLessThanOrEqual(tolerance);
    });
  });
}

/** Distance helpers: 0 on the surface. */
export const onX =
  (/** @type {number} */ offset) => (/** @type {number} */ coordX) =>
    coordX - offset;
export const onY =
  (/** @type {number} */ offset) =>
  /** @type {(x: number, y: number) => number} */ (_x, coordY) =>
    coordY - offset;
export const onZ =
  (/** @type {number} */ offset) =>
  /** @type {(x: number, y: number, z: number) => number} */ (_x, _y, coordZ) =>
    coordZ - offset;
export const onRadius =
  (
    /** @type {number} */ radius,
    /** @type {number} */ centerX = 0,
    /** @type {number} */ centerY = 0,
  ) =>
  /** @type {(x: number, y: number) => number} */ (coordX, coordY) =>
    Math.hypot(coordX - centerX, coordY - centerY) - radius;

/**
 * ∫ integrand(t) dt from `lower` to `upper` by composite Simpson's rule on
 * 20 000 intervals: exact to round-off for the smooth integrands of the tests.
 *
 * @param {(t: number) => number} integrand
 * @param {number} lower
 * @param {number} upper
 */
export function simpson(integrand, lower, upper) {
  const intervals = 20000;
  const width = (upper - lower) / intervals;
  let sum = integrand(lower) + integrand(upper);
  for (let i = 1; i < intervals; i++)
    sum += (i % 2 ? 4 : 2) * integrand(lower + i * width);
  return (sum * width) / 3;
}
