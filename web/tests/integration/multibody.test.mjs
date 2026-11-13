// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Multibody assembly test (#317/#353) — runs the full WASM pipeline in Node.js
// on test_files/two_boxes.stp: two 20×10×10 boxes written as independent
// solids that touch on the full 10×10 face at x=20.
//
// Verifies:
//   1. import reports two bodies (bodyCount) and one bonded interface between
//      them on the shared face
//   2. touching faces are imprinted → ONE conforming mesh: the interface nodes
//      are shared (no duplicated coordinates), tets carry per-body ids {1, 2}
//   3. per-body materials reach the solve: softening one body's E makes the
//      cantilever tip deflection strictly larger

import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, test } from "bun:test";
import { detectInterfaces } from "../../src/lib/interfaces.ts";
import { loadEngine } from "../support/wasm.mjs";

describe("two-box assembly", () => {
  let tess = null;
  let nTris = null;
  let interfaces = null;
  let mesh = null;
  let nNodes = null;
  let nTets = null;
  let fixedVertices = null;
  let tipLoads = null;
  let bcs = null;

  // Mesh and solve run in separate module instances, mirroring production
  // (see wall-bracket.test.mjs for the Netgen-global-state rationale).
  beforeAll(async () => {
    const Module = await loadEngine();
    const stepBytes = new Uint8Array(
      readFileSync(
        new URL("../../../test_files/two_boxes.stp", import.meta.url),
      ),
    );

    tess = Module.tessellate_step(
      stepBytes,
      JSON.stringify({ deflection_relative: 0.001, angular_deflection: 0.5 }),
    );
    nTris = tess.triangles.length / 3;

    const triangles = [];
    for (let tri = 0; tri < nTris; tri++)
      triangles.push([
        tess.triangles[3 * tri],
        tess.triangles[3 * tri + 1],
        tess.triangles[3 * tri + 2],
      ]);
    interfaces = detectInterfaces({
      points: [],
      triangles,
      bodyIds: Array.from(tess.triangleBodyIds),
      faceIds: Array.from(tess.triangleFaceIds),
    });

    mesh = Module.generate_fem_mesh(
      JSON.stringify({
        max_element_size: 5.0,
        min_element_size: 0.5,
        grading: 0.3,
        second_order: false,
        elementsperedge: 2.0,
        elementspercurve: 2.0,
        optsteps_2d: 3,
        optsteps_3d: 3,
      }),
    );
    Module.free_geometry_cache();
    nNodes = mesh.vertices.length / 3;
    nTets = mesh.tetrahedra.length / 4;

    // Cantilever: clamp the x=0 face, load the x=40 tip face down.
    fixedVertices = [];
    tipLoads = [];
    for (let node = 0; node < nNodes; node++) {
      const xCoord = mesh.vertices[3 * node];
      if (Math.abs(xCoord) < 1e-6) fixedVertices.push(node);
      if (Math.abs(xCoord - 40.0) < 1e-6)
        tipLoads.push({ vertex: node, force: [0, -100, 0] });
    }
    bcs = JSON.stringify({
      fixed_vertices: fixedVertices,
      point_loads: tipLoads,
    });
  });

  describe("import", () => {
    test("import reports two bodies", () => {
      expect(
        tess.bodyCount,
        `expected bodyCount 2, got ${tess.bodyCount}`,
      ).toBe(2);
    });

    // KOF-170: the imprinted 10x10 contact face is owned by both bodies, so the
    // face -> body ownership the tessellation reports yields one bonded
    // interface between Body 1 and Body 2 on a single CAD face.
    test("one bonded Body 1 to Body 2 interface on one face", () => {
      expect(interfaces, JSON.stringify(interfaces)).toHaveLength(1);
      expect(interfaces[0].bodyA).toBe(1);
      expect(interfaces[0].bodyB).toBe(2);
      expect(interfaces[0].faceIds).toHaveLength(1);
      expect(interfaces[0].type).toBe("bonded");
    });

    // Per-triangle body ids drive per-body colour/highlight/hide in the
    // geometry view: one 1-based id per display triangle, both bodies present.
    test("one triangle body id per display triangle", () => {
      expect(tess.triangleBodyIds).toHaveLength(nTris);
    });

    test("triangle body ids are {1, 2}", () => {
      const tessBodies = new Set(tess.triangleBodyIds);
      expect(tessBodies.size).toBe(2);
      expect(tessBodies.has(1)).toBe(true);
      expect(tessBodies.has(2)).toBe(true);
    });
  });

  describe("mesh", () => {
    test("one body id per tetrahedron", () => {
      expect(mesh.bodyIds).toHaveLength(nTets);
    });

    test("tetrahedra belong to bodies {1, 2}", () => {
      const bodyTets = new Map();
      for (const id of mesh.bodyIds)
        bodyTets.set(id, (bodyTets.get(id) ?? 0) + 1);
      expect(bodyTets.size).toBe(2);
      expect(bodyTets.has(1)).toBe(true);
      expect(bodyTets.has(2)).toBe(true);
    });

    // Were the bodies meshed independently, every interface node would exist
    // twice (one copy per body) at identical coordinates.
    test("interface is conforming: no duplicated node coordinates", () => {
      const seen = new Set();
      for (let node = 0; node < nNodes; node++) {
        const key = `${mesh.vertices[3 * node].toFixed(6)},${mesh.vertices[3 * node + 1].toFixed(6)},${mesh.vertices[3 * node + 2].toFixed(6)}`;
        expect(seen.has(key), `duplicated node at (${key})`).toBe(false);
        seen.add(key);
      }
    });

    // The shared face at x=20 must have nodes referenced by tets of BOTH bodies.
    test("nodes shared by both bodies lie on the interface plane x=20", () => {
      const nodeBodies = new Map();
      for (let tet = 0; tet < nTets; tet++)
        for (let corner = 0; corner < 4; corner++) {
          const vertex = mesh.tetrahedra[4 * tet + corner];
          if (!nodeBodies.has(vertex)) nodeBodies.set(vertex, new Set());
          nodeBodies.get(vertex).add(mesh.bodyIds[tet]);
        }
      let nInterfaceNodes = 0;
      for (const [vertex, bodies] of nodeBodies)
        if (bodies.size === 2) {
          expect(
            Math.abs(mesh.vertices[3 * vertex] - 20.0),
            `node ${vertex} shared by both bodies but at x=${mesh.vertices[3 * vertex]}, not on the interface plane x=20`,
          ).toBeLessThan(1e-6);
          nInterfaceNodes++;
        }
      expect(
        nInterfaceNodes,
        "no nodes shared between the two bodies, interface not bonded",
      ).toBeGreaterThan(0);
    });
  });

  // Per-tet material attributes come straight from the body ids because
  // material k is assigned to body k here.
  describe("per-body materials reach the solve", () => {
    const steel = { young_modulus: 210000, poisson_ratio: 0.3 };
    const soft = { young_modulus: 21000, poisson_ratio: 0.3 };
    let deflSame = null;
    let deflSoft = null;
    let vonMisesSame = null;
    let vonMisesSoft = null;

    async function solveOnce(materials) {
      const SolveModule = await loadEngine();
      const result = SolveModule.solve_linear_elastic(
        {
          vertices: mesh.vertices,
          tetrahedra: mesh.tetrahedra,
          hexahedra: new Int32Array(0),
          attributes: mesh.bodyIds,
        },
        JSON.stringify(materials),
        bcs,
        1,
      );
      if ("error" in result) throw new Error(result.error);
      let maxDefl = 0;
      for (let node = 0; node < nNodes; node++)
        maxDefl = Math.max(
          maxDefl,
          Math.abs(result.displacements[3 * node + 1]),
        );
      return { maxDefl, vonMises: Array.from(result.von_mises) };
    }

    beforeAll(async () => {
      const same = await solveOnce([steel, steel]);
      deflSame = same.maxDefl;
      vonMisesSame = same.vonMises;
      const softer = await solveOnce([steel, soft]);
      deflSoft = softer.maxDefl;
      vonMisesSoft = softer.vonMises;
    });

    test("the clamp face x=0 has nodes", () => {
      expect(fixedVertices.length).toBeGreaterThan(0);
    });

    test("the tip face x=40 has nodes", () => {
      expect(tipLoads.length).toBeGreaterThan(0);
    });

    test("von Mises stress is finite in both solves", () => {
      for (const value of vonMisesSame)
        expect(Number.isFinite(value), "steel + steel").toBe(true);
      for (const value of vonMisesSoft)
        expect(Number.isFinite(value), "steel + soft tip").toBe(true);
    });

    test("steel/steel solve produces a deflection", () => {
      expect(Number.isFinite(deflSame)).toBe(true);
      expect(deflSame).toBeGreaterThan(0);
    });

    test("softening body 2 increases tip deflection", () => {
      expect(
        deflSoft,
        `${deflSoft} vs ${deflSame}: per-body materials are not reaching the solve`,
      ).toBeGreaterThan(1.5 * deflSame);
    });
  });
});
