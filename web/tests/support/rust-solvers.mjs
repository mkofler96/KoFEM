// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// The C++ engine's three solve entries — solve_linear_elastic, solve_shell and
// solve_coupled — with their signatures and result shapes, run on the app's
// Rust paths (web/src/lib/solve). The C++ solvers left the engine (KOF-309);
// the tests that checked their behaviour on hand-built inputs keep those
// inputs and check the Rust solve instead.
//
// Each entry resolves to the result the engine returned, or rejects with the
// Rust path's error where the engine returned { error } or threw.

import { solveSolidInRust } from "../../src/lib/solve/amg.ts";
import { solveShellInRust } from "../../src/lib/solve/shellRust.ts";
import { solveCoupledInRust } from "../../src/lib/solve/coupledRust.ts";
import { buildVertexIndexer } from "../../src/lib/solveMeshPacking.ts";
import { loadFem } from "./wasm.mjs";

const neverAsk = () => {
  throw new Error("the CG iteration budget ran out");
};

// The store model the app's solid solve takes, from the engine's inputs: flat
// vertices and tets/hexes, 1-based per-element material attributes (all 1
// when absent), materials as one object or an array, and the BC JSON.
function solidModel(mesh, matJson, bcsJson) {
  const vertices = Array.from(mesh.vertices);
  const nodes = Array.from({ length: vertices.length / 3 }, (_, id) => ({
    id,
    x: vertices[3 * id],
    y: vertices[3 * id + 1],
    z: vertices[3 * id + 2],
  }));
  const tets = Array.from(mesh.tetrahedra ?? []);
  const hexes = Array.from(mesh.hexahedra ?? []);
  const tetCount = tets.length / 4;
  const hexCount = hexes.length / 8;
  const attributes = mesh.attributes
    ? Array.from(mesh.attributes)
    : Array.from({ length: tetCount + hexCount }, () => 1);
  if (attributes.length !== tetCount + hexCount)
    throw new Error(
      `mesh.attributes has ${attributes.length} entries for ${tetCount + hexCount} elements`,
    );
  const elements = [
    ...Array.from({ length: tetCount }, (_, e) => ({
      id: e,
      type: "CTETRA",
      nodeIds: tets.slice(4 * e, 4 * e + 4),
      propertyId: attributes[e],
    })),
    ...Array.from({ length: hexCount }, (_, e) => ({
      id: tetCount + e,
      type: "CHEXA",
      nodeIds: hexes.slice(8 * e, 8 * e + 8),
      propertyId: attributes[tetCount + e],
    })),
  ];
  const parsed = JSON.parse(matJson);
  const list = Array.isArray(parsed) ? parsed : [parsed];
  const materials = list.map((m, index) => ({
    id: index + 1,
    name: `material ${index + 1}`,
    young: m.young_modulus,
    poisson: m.poisson_ratio,
    density: m.density,
  }));
  const properties = materials.map((m) => ({ id: m.id, materialId: m.id }));
  const bcs = JSON.parse(bcsJson);
  const constraints = [
    ...(bcs.fixed_vertices ?? []).flatMap((nodeId) =>
      [0, 1, 2].map((dof) => ({ nodeId, dof })),
    ),
    ...(bcs.fixed_dofs ?? []).flatMap(({ vertex, dofs }) =>
      dofs.map((dof) => ({ nodeId: vertex, dof })),
    ),
    ...(bcs.prescribed_dofs ?? []).map(({ vertex, dof, value }) => ({
      nodeId: vertex,
      dof,
      prescribedValue: value,
    })),
  ];
  const loads = (bcs.point_loads ?? []).flatMap(({ vertex, force }) =>
    force
      .map((value, dof) => ({ nodeId: vertex, dof, value }))
      .filter(({ value }) => value !== 0),
  );
  return {
    nodes,
    elements,
    materials,
    properties,
    constraints,
    loads,
    surfaceLoads: bcs.surface_loads ?? [],
  };
}

/**
 * The engine's solve entries on the Rust module.
 *
 * @returns {Promise<{
 *   solve_linear_elastic(mesh, matJson: string, bcsJson: string, order?: number): Promise<{displacements: Float64Array, von_mises: Float64Array}>,
 *   solve_shell(mesh, matJson: string, bcsJson: string): Promise<{displacements: Float64Array, von_mises: Float64Array}>,
 *   solve_coupled(mesh, coupling, bcs, matJson: string, preconditioner?: string): Promise<object>,
 * }>}
 */
export async function loadRustSolvers({ log = () => {} } = {}) {
  const fem = await loadFem();
  return {
    async solve_linear_elastic(mesh, matJson, bcsJson, order = 1) {
      const model = solidModel(mesh, matJson, bcsJson);
      const vid = buildVertexIndexer(model.nodes);
      const result = await solveSolidInRust(
        fem,
        model,
        order,
        "amg",
        vid,
        vid,
        undefined,
        neverAsk,
        log,
      );
      return {
        displacements: result.displacements,
        von_mises: result.vonMises,
      };
    },
    solve_shell(mesh, matJson, bcsJson) {
      return solveShellInRust(
        fem,
        { mesh, matJson, bcsJson },
        undefined,
        neverAsk,
        log,
      );
    },
    solve_coupled(
      mesh,
      coupling,
      bcs,
      matJson,
      preconditioner = "incomplete-cholesky",
    ) {
      return solveCoupledInRust(
        fem,
        { mesh, coupling, bcs, matJson },
        preconditioner,
        undefined,
        neverAsk,
        log,
      );
    },
  };
}
