// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// solve() and solveShell() for the closed-form checks and studies that build a
// mesh by hand (the solver tests, the axial-bar study): the app's own Rust
// solve paths (web/src/lib/solve), fed the engine-style inputs those checks
// author. The C++ engine's solvers are gone (KOF-309); these wrappers keep the
// input contract they took.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { solveSolidInRust } from "../../../web/src/lib/solve/amg.ts";
import { solveShellInRust } from "../../../web/src/lib/solve/shellRust.ts";
import { buildVertexIndexer } from "../../../web/src/lib/solveMeshPacking.ts";

const here = dirname(fileURLToPath(import.meta.url));
const FEM = join(here, "../../../web/src/wasm/fem");

let femModule = null;

/** The Rust finite-element module (web/src/wasm/fem), loaded once. */
export async function rustFem() {
  if (femModule) return femModule;
  const fem = await import(join(FEM, "kofem_wasm.js"));
  await fem.default({
    module_or_path: readFileSync(join(FEM, "kofem_wasm_bg.wasm")),
  });
  femModule = fem;
  return fem;
}

/**
 * The store's solve payload (nodes, elements, one material, constraints,
 * loads, surface loads) for a mesh, material and BCs in the engine-style
 * shapes loadSolver documents: what the app's solve paths take.
 */
export function storeModel(mesh, material, bcs) {
  const nodes = mesh.vertices.map(([x, y, z], id) => ({ id, x, y, z }));
  let elementId = 0;
  const elements = [
    ...(mesh.tetrahedra ?? []).map((nodeIds) => ({
      id: elementId++,
      type: "CTETRA",
      nodeIds,
      propertyId: 1,
    })),
    ...(mesh.hexahedra ?? []).map((nodeIds) => ({
      id: elementId++,
      type: "CHEXA",
      nodeIds,
      propertyId: 1,
    })),
  ];
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
    materials: [
      {
        id: 1,
        name: "material",
        young: material.young_modulus,
        poisson: material.poisson_ratio,
        density: material.density,
      },
    ],
    properties: [{ id: 1, materialId: 1 }],
    constraints,
    loads,
    surfaceLoads: bcs.surface_loads ?? [],
  };
}

const neverAsk = () => {
  throw new Error("the CG iteration budget ran out");
};

/**
 * solve(mesh, material, bcs, order?) — a linear-elastic solve of a solid mesh
 * through the app's Rust path (solveSolidInRust, multigrid CG):
 *   mesh:     { vertices:[[x,y,z]...], tetrahedra:[[..4]...], hexahedra:[[..8]...] }
 *   material: { young_modulus, poisson_ratio, density? }
 *   bcs:      { fixed_vertices:[v...],
 *               fixed_dofs:[{vertex,dofs:[0|1|2,...]}...],
 *               prescribed_dofs:[{vertex,dof:0|1|2,value}...],
 *               point_loads:[{vertex, force:[fx,fy,fz]}...],
 *               surface_loads:[{ type:"force"|"pressure"|"traction",
 *                                faces:[[a,b,c(,d)]...],
 *                                force?:[fx,fy,fz], pressure?:p }...] }
 *   order:    element order, 1 (linear) or 2 (quadratic).
 * Resolves to { displacements:number[] (3/node), von_mises:number[] (1/elem) }.
 */
export async function loadSolver() {
  const fem = await rustFem();

  return async function solve(mesh, material, bcs, order = 1) {
    const model = storeModel(mesh, material, bcs);
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
      () => {},
    );
    return {
      displacements: Array.from(result.displacements),
      von_mises: Array.from(result.vonMises),
    };
  };
}

/**
 * solveShell(mesh, material, bcs) — a Kirchhoff (DKT) shell solve through the
 * app's Rust shell path (solveShellInRust), on the inputs the C++ solve_shell
 * took:
 *   mesh:     { vertices:[[x,y,z]...], triangles:[[a,b,c]...],
 *               thicknesses?:[t...] }   (per-facet thickness)
 *   material: { young_modulus, poisson_ratio, thickness }
 *   bcs:      { fixed_vertices:[v...],
 *               fixed_dofs:[{vertex, dofs:[0..5,...]}...],       // u = 0
 *               prescribed_dofs:[{vertex, dof:0..5, value}...],  // u = value
 *               point_loads:[{vertex, force:[fx,fy,fz], moment?:[mx,my,mz]}...] }
 * Shell DOF components are 0..5 = (u,v,w,θx,θy,θz).
 * Resolves to { displacements:number[] (3/node), von_mises:number[] (1/triangle) }.
 */
export async function loadShellSolver() {
  const fem = await rustFem();

  return async function solveShell(mesh, material, bcs) {
    const result = await solveShellInRust(
      { ShellModel: fem.ShellModel },
      {
        mesh: {
          vertices: Float64Array.from(mesh.vertices.flat()),
          triangles: Int32Array.from(mesh.triangles.flat()),
          ...(mesh.thicknesses
            ? { thicknesses: Float64Array.from(mesh.thicknesses) }
            : {}),
        },
        matJson: JSON.stringify(material),
        bcsJson: JSON.stringify({
          fixed_vertices: bcs.fixed_vertices ?? [],
          fixed_dofs: bcs.fixed_dofs ?? [],
          prescribed_dofs: bcs.prescribed_dofs ?? [],
          point_loads: bcs.point_loads ?? [],
        }),
      },
      undefined,
      neverAsk,
      () => {},
    );
    return {
      displacements: Array.from(result.displacements),
      von_mises: Array.from(result.von_mises),
    };
  };
}
