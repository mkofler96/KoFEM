// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Pure-shell (all-CTRIA3) payload builder for the engine's Kirchhoff shell
// solver (solve_shell) and its shell topology optimizer, which take the same
// { mesh, mat_json, bcs_json } inputs.

import type {
  Element,
  Material,
  Property,
  SolvePayload,
} from "../../workers/solverTypes.js";
import type { ShellMesh } from "../../wasm/pkg/kofem_wasm.js";
import { buildVertexIndexer } from "../solveMeshPacking.js";
import { shellPointLoads } from "../solveLoads.js";
import { shellDirichlet } from "./bcs.js";

// Resolve the shell section: one (E, ν) pair plus the per-facet thickness
// field. The engine's shell solver takes a single material for the whole mesh;
// a model whose shell elements span several materials cannot be honoured, so
// refuse loudly instead of solving part of it with the wrong stiffness
// (mirrors coupledMaterials, issue #376). Thickness lives on each element's
// property (PSHELL semantics) and must be a positive number.
export function resolveShellSection(
  shellElements: Element[],
  materials: Material[],
  properties: Property[],
): { young: number; poisson: number; thicknesses: Float64Array } {
  const propById = new Map(properties.map((p) => [p.id, p]));
  const matById = new Map(materials.map((mat) => [mat.id, mat]));
  const usedMats = new Map<number, Material>();
  const thicknesses = new Float64Array(shellElements.length);
  for (let i = 0; i < shellElements.length; i++) {
    const el = shellElements[i];
    const prop = propById.get(el.propertyId);
    if (!prop)
      throw new Error(
        `shell solve: element ${el.id} belongs to body ${el.propertyId}, ` +
          "which has no property — the model is inconsistent",
      );
    if (typeof prop.thickness !== "number" || prop.thickness <= 0)
      throw new Error(
        `shell solve: property ${prop.id} has no positive shell thickness — ` +
          "shell (CTRIA3) elements require a thickness on their property",
      );
    thicknesses[i] = prop.thickness;
    const mat = matById.get(prop.materialId);
    if (!mat)
      throw new Error(
        `shell solve: property ${prop.id} references material ${prop.materialId}, ` +
          "which does not exist",
      );
    usedMats.set(mat.id, mat);
  }
  if (usedMats.size > 1) {
    const names = [...usedMats.values()].map((mat) => mat.name).join(", ");
    throw new Error(
      `shell solve: the shell solver supports one material, but the shell elements span ` +
        `${usedMats.size} distinct materials (${names}) — assign a single material to the shell body`,
    );
  }
  const mat = [...usedMats.values()][0];
  return { young: mat.young, poisson: mat.poisson, thicknesses };
}

// Pack a pure-shell (all-CTRIA3) model into the { mesh, mat_json, bcs_json }
// payload the engine's shell solver AND its shell topology optimizer both take —
// so the two paths share one packing. `elements` are all shell facets, in store
// order (density[i] from the optimizer maps back to elements[i]).
export interface ShellEngineInputs {
  mesh: Required<ShellMesh>;
  matJson: string;
  bcsJson: string;
}

export function buildShellEngineInputs(
  payload: SolvePayload,
): ShellEngineInputs {
  const {
    nodes,
    elements,
    materials,
    properties,
    constraints,
    loads,
    surfaceLoads,
  } = payload;

  const vid = buildVertexIndexer(nodes);
  const vertices = new Float64Array(3 * nodes.length);
  for (let i = 0; i < nodes.length; i++) {
    vertices[3 * i] = nodes[i].x;
    vertices[3 * i + 1] = nodes[i].y;
    vertices[3 * i + 2] = nodes[i].z;
  }
  const triangles = new Int32Array(3 * elements.length);
  for (let i = 0; i < elements.length; i++) {
    const { nodeIds } = elements[i];
    if (nodeIds.length !== 3)
      throw new Error(
        `CTRIA3 element ${elements[i].id} has ${nodeIds.length} nodes — expected 3`,
      );
    for (let k = 0; k < 3; k++)
      triangles[3 * i + k] = vid(nodeIds[k], "CTRIA3 element");
  }

  const { young, poisson, thicknesses } = resolveShellSection(
    elements,
    materials,
    properties,
  );
  const { fixed_vertices, fixed_dofs, prescribed_dofs } = shellDirichlet(
    constraints,
    vid,
  );
  const posOf = (nodeId: number): [number, number, number] => {
    const vi = vid(nodeId, "surface load face");
    return [vertices[3 * vi], vertices[3 * vi + 1], vertices[3 * vi + 2]];
  };
  const point_loads = shellPointLoads(loads, surfaceLoads, posOf, vid);

  return {
    mesh: { vertices, triangles, thicknesses },
    matJson: JSON.stringify({ young_modulus: young, poisson_ratio: poisson }),
    bcsJson: JSON.stringify({
      fixed_vertices,
      fixed_dofs,
      prescribed_dofs,
      point_loads,
    }),
  };
}
