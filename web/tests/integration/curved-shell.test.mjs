// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// A curved thin wall marked Shell collapses to its mid-surface and solves on
// the shell path (KOF-448). The part is a thin pressurised tube, written by
// the gallery's STEP writer, imported through OCCT and meshed by Netgen with
// the app worker's options; the solve-time auto-shell path
// (lib/solve/autoShell.ts) idealises it and the Rust shell solve
// (lib/solve/shellRust.ts) solves it.
//
// The whole tube, not a quarter: the solve-time path maps supports onto the
// shell's translations only, and a quarter ring on two symmetry rollers
// without their rotations keeps a rigid rotation free. Here the end z = 0 is
// held axially and three points of it hold the tube's in-plane rigid motion
// in directions square to the radius, which the expansion does not move.
//
// Reference: an open-ended thin cylinder under internal pressure p carries
// only hoop stress. The pressure acts on the bore (r_i = 995 mm), so the hoop
// force per unit length is p·r_i, σ_θ = p·r_i/t = 99.5 MPa and the mid-surface
// (r = 1000 mm) moves out by u_r = σ_θ·r/E = 0.4738 mm.

import { beforeAll, describe, expect, test } from "bun:test";
import { annulusStep } from "../../../examples/gallery/step-prism.mjs";
import { prepareAutoShellSolve } from "../../src/lib/solve/autoShell.ts";
import { solveShellInRust } from "../../src/lib/solve/shellRust.ts";
import { loadEngine, loadFem } from "../support/wasm.mjs";

const R_INNER = 995;
const R_OUTER = 1005;
const R_MID = (R_INNER + R_OUTER) / 2;
const THICKNESS = R_OUTER - R_INNER;
const LENGTH = 1000;
const PRESSURE = 1;
const YOUNG = 210000;
const HOOP = (PRESSURE * R_INNER) / THICKNESS;
const RADIAL = (HOOP * R_MID) / YOUNG;

const TUBE = annulusStep(R_INNER, R_OUTER, LENGTH, "thin tube");

// The store-model view of a Netgen mesh: 1-based node ids, one CTETRA per tet.
function meshStep(engine, step, maxElementSize) {
  engine.tessellate_step(
    new TextEncoder().encode(step),
    JSON.stringify({
      deflection_relative: 0.001,
      angular_deflection: 0.5,
      format: "step",
    }),
  );
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
  if (!dto.tetrahedra) throw new Error("Netgen did not mesh the part");
  const nodes = [];
  for (let i = 0; i < dto.vertices.length / 3; i++)
    nodes.push({
      id: i + 1,
      x: dto.vertices[3 * i],
      y: dto.vertices[3 * i + 1],
      z: dto.vertices[3 * i + 2],
    });
  const elements = [];
  for (let e = 0; e < dto.tetrahedra.length / 4; e++)
    elements.push({
      id: e + 1,
      type: "CTETRA",
      propertyId: dto.bodyIds[e],
      nodeIds: Array.from(
        dto.tetrahedra.subarray(4 * e, 4 * e + 4),
        (v) => v + 1,
      ),
    });
  const surfaceTriangles = [];
  for (let t = 0; t < dto.surfaceFaceIds.length; t++)
    surfaceTriangles.push(
      Array.from(dto.surfaceTriangles.subarray(3 * t, 3 * t + 3), (v) => v + 1),
    );
  return {
    nodes,
    elements,
    bodies: [...new Set(dto.bodyIds)],
    surfaceTriangles,
    surfaceFaceIds: Array.from(dto.surfaceFaceIds),
  };
}

// The surface triangles of the CAD face whose every node passes `on`.
function faceTriangles(mesh, on) {
  const byId = new Map(mesh.nodes.map((node) => [node.id, node]));
  const byFace = new Map();
  mesh.surfaceTriangles.forEach((tri, t) => {
    const face = mesh.surfaceFaceIds[t];
    if (!byFace.has(face)) byFace.set(face, []);
    byFace.get(face).push(tri);
  });
  const matching = [...byFace.values()].filter((tris) =>
    tris.every((tri) => tri.every((id) => on(byId.get(id)))),
  );
  if (matching.length !== 1)
    throw new Error(`expected one face, found ${matching.length}`);
  return matching[0];
}

const nodesOf = (triangles) => [...new Set(triangles.flat())];
const near = (value, target) => Math.abs(value - target) < 1e-3;
const radiusOf = (x, y) => Math.hypot(x, y);
const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
};

describe("a pressurised thin tube, marked Shell", () => {
  let solve = null;
  let result = null;
  let mapped = null;

  beforeAll(async () => {
    const fem = await loadFem();
    const mesh = meshStep(await loadEngine(), TUBE, 50);
    if (mesh.bodies.length !== 1)
      throw new Error(`expected one body, got ${mesh.bodies.length}`);
    const [body] = mesh.bodies;
    const bore = faceTriangles(mesh, (n) => near(radiusOf(n.x, n.y), R_INNER));
    const end = nodesOf(faceTriangles(mesh, (n) => near(n.z, 0)));
    const byId = new Map(mesh.nodes.map((node) => [node.id, node]));
    // The node of the end z = 0 nearest to (x, y, 0).
    const endNodeAt = (x, y) =>
      end.reduce((best, id) => {
        const distance = (node) => Math.hypot(node.x - x, node.y - y);
        return distance(byId.get(id)) < distance(byId.get(best)) ? id : best;
      });
    const constraints = [
      ...end.map((nodeId) => ({ nodeId, dof: 2 })),
      { nodeId: endNodeAt(R_OUTER, 0), dof: 1 },
      { nodeId: endNodeAt(-R_OUTER, 0), dof: 1 },
      { nodeId: endNodeAt(0, R_OUTER), dof: 0 },
    ];
    const payload = {
      nodes: mesh.nodes,
      elements: mesh.elements,
      materials: [
        { id: 1, name: "steel", young: YOUNG, poisson: 0.3, density: 7.85e-9 },
      ],
      properties: [{ id: body, materialId: 1, discretization: "shell" }],
      constraints,
      loads: [],
      surfaceLoads: [{ type: "pressure", faces: bore, pressure: PRESSURE }],
      elementOrder: 1,
      surfaceTriangles: mesh.surfaceTriangles,
      surfaceFaceIds: mesh.surfaceFaceIds,
      solverMethod: "amg",
    };
    const auto = prepareAutoShellSolve(payload, new Set([body]), () => {});
    if (auto.kind !== "pure")
      throw new Error(`expected the pure shell path, got ${auto.kind}`);
    solve = auto.solve;
    result = await solveShellInRust(
      fem,
      solve,
      undefined,
      () => {
        throw new Error("the CG iteration budget ran out");
      },
      () => {},
    );
    mapped = solve.mapResult(result);
  });

  test("the shell lies on the mid-surface, r = 1000 mm, within 1 % of t", () => {
    const vertices = solve.mesh.vertices;
    for (let i = 0; i < vertices.length / 3; i++) {
      const radius = radiusOf(vertices[3 * i], vertices[3 * i + 1]);
      expect(Math.abs(radius - R_MID)).toBeLessThan(0.01 * THICKNESS);
    }
  });

  test("every facet carries the 10 mm wall thickness", () => {
    for (const thickness of solve.mesh.thicknesses)
      expect(Math.abs(thickness - THICKNESS)).toBeLessThan(0.01 * THICKNESS);
  });

  // The mean over the mid-surface nodes: the axisymmetric part of the
  // response. A tube of r/t = 100 with a free end is soft in ovalisation, and
  // the irregular facet mesh leaves an out-of-round part of some 25 % of it
  // (ring bending, adding under 10 % to the surface stress).
  test("the mid-surface moves out by p·r_i·r/(E·t) on average", () => {
    const vertices = solve.mesh.vertices;
    const radial = [];
    for (let i = 0; i < vertices.length / 3; i++) {
      const [x, y] = [vertices[3 * i], vertices[3 * i + 1]];
      const radius = radiusOf(x, y);
      const [ux, uy] = [
        result.displacements[3 * i],
        result.displacements[3 * i + 1],
      ];
      radial.push((x * ux + y * uy) / radius);
    }
    const mean = radial.reduce((sum, u) => sum + u, 0) / radial.length;
    expect(Math.abs(mean - RADIAL) / RADIAL).toBeLessThan(0.02);
  });

  test("the wall carries the hoop stress p·r_i/t", () => {
    expect(Math.abs(median(mapped.vonMises) - HOOP) / HOOP).toBeLessThan(0.03);
    expect(Math.max(...mapped.vonMises)).toBeLessThan(1.15 * HOOP);
  });
});
