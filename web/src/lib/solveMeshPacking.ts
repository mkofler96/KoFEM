// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

import type {
  Node,
  Element,
  Material,
  Property,
  Constraint,
  Load,
} from "../workers/solverTypes.js";
import type { SolveMesh } from "../wasm/pkg/kofem_wasm.js";

// The engine indexes vertices 0-based in the order they are added (mesh
// vertices are emitted in node-array order). Stored node .id values are NOT
// those indices — saved analyses number nodes 1-based and .inp imports use
// arbitrary ids — so every node reference (element connectivity, constraints,
// loads, surface-load faces) must be remapped to its vertex index before
// reaching the engine. Passing a raw node id where the engine expects a vertex
// index reads past the vertex array and traps with "memory access out of
// bounds" (issue #288).
export type VertexIndexer = (nodeId: number, context: string) => number;

export function buildVertexIndexer(nodes: Node[]): VertexIndexer {
  const vertexIndexById = new Map(nodes.map((n, i) => [n.id, i]));
  return (nodeId, context) => {
    const i = vertexIndexById.get(nodeId);
    if (i === undefined)
      throw new Error(
        `${context} references unknown node id ${nodeId} — the model is inconsistent`,
      );
    return i;
  };
}

// The mesh crosses the WASM boundary as flat typed arrays (issue #166):
// no multi-MB JSON.stringify here and no JSON.parse inside the engine —
// the engine bulk-copies these buffers onto its heap in one call each.
export function packSolveMesh(
  nodes: Node[],
  tetElements: Element[],
  hexElements: Element[],
  vid: VertexIndexer,
): SolveMesh {
  if (tetElements.length === 0 && hexElements.length === 0) {
    throw new Error(
      "No supported elements found. MFEM requires CTETRA or CHEXA elements — " +
        'import a STEP file and click "Mesh STEP volume" first.',
    );
  }
  const vertices = new Float64Array(3 * nodes.length);
  for (let i = 0; i < nodes.length; i++) {
    vertices[3 * i] = nodes[i].x;
    vertices[3 * i + 1] = nodes[i].y;
    vertices[3 * i + 2] = nodes[i].z;
  }
  const packConnectivity = (
    els: Element[],
    nodesPerElement: number,
    context: string,
  ): Int32Array => {
    const out = new Int32Array(nodesPerElement * els.length);
    for (let i = 0; i < els.length; i++) {
      const { nodeIds } = els[i];
      if (nodeIds.length !== nodesPerElement)
        throw new Error(
          `${context} ${els[i].id} has ${nodeIds.length} nodes — expected ${nodesPerElement}`,
        );
      for (let k = 0; k < nodesPerElement; k++)
        out[nodesPerElement * i + k] = vid(nodeIds[k], context);
    }
    return out;
  };
  return {
    vertices,
    tetrahedra: packConnectivity(tetElements, 4, "CTETRA element"),
    hexahedra: packConnectivity(hexElements, 8, "CHEXA element"),
  };
}

// Per-body materials (#317/#353): each element's propertyId is its body, and
// the property maps the body to a material. Returns the materials payload for
// the engine plus one 1-based index into it per element, in the order the
// elements cross the WASM boundary (mesh.attributes contract).
export function resolveMaterials(
  orderedElements: Element[],
  materials: Material[],
  properties: Property[],
) {
  if (materials.length === 0) {
    throw new Error(
      "solve: no material assigned — assign a material before running the solver",
    );
  }
  const matIndexById = new Map(materials.map((mat, i) => [mat.id, i + 1]));
  const matIndexByProperty = new Map<number, number>();
  for (const prop of properties) {
    const idx = matIndexById.get(prop.materialId);
    if (idx === undefined)
      throw new Error(
        `solve: body ${prop.id} is assigned material id ${prop.materialId}, ` +
          "which does not exist — assign an existing material to every body",
      );
    matIndexByProperty.set(prop.id, idx);
  }
  const attributes = new Int32Array(orderedElements.length);
  for (let i = 0; i < orderedElements.length; i++) {
    const idx = matIndexByProperty.get(orderedElements[i].propertyId);
    if (idx === undefined)
      throw new Error(
        `solve: element ${orderedElements[i].id} belongs to body ` +
          `${orderedElements[i].propertyId}, which has no material assignment — ` +
          "the model is inconsistent",
      );
    attributes[i] = idx;
  }
  return {
    materials: materials.map((mat) => ({
      young_modulus: mat.young,
      poisson_ratio: mat.poisson,
      density: mat.density,
    })),
    attributes,
  };
}

// Group translational constraints (DOFs 0–2) per node. A node constrained
// in all three components is a full fix (fixed_vertices); a node constrained
// in only some becomes a per-DOF constraint (fixed_dofs) so the unconstrained
// directions stay free — e.g. a symmetry-plane roller. Rotational DOFs (3–5)
// carry no stiffness for solid (H1 displacement) elements and are ignored.
//
// A non-zero prescribed displacement is also a Dirichlet condition, but it
// must reach the solver as an inhomogeneous essential BC (prescribed_dofs):
// folding it into fixed_vertices/fixed_dofs would silently pin the DOF to
// zero and discard the requested value (issue #216).
// Keyed by vertex index (vid), so the essential-DOF sets the engine
// receives line up with the remapped mesh connectivity.
export function groupDirichlet(constraints: Constraint[], vid: VertexIndexer) {
  const dofsByNode = new Map<number, Set<number>>();
  const prescribed_dofs: { vertex: number; dof: number; value: number }[] = [];
  for (const c of constraints) {
    if (c.dof > 2) continue;
    const vertex = vid(c.nodeId, "constraint");
    // eslint-disable-next-line kofem/no-silent-fallback -- a constraint without prescribedValue is a homogeneous fixed BC, i.e. u = 0 by definition
    const value = c.prescribedValue ?? 0;
    if (value === 0) {
      let dofs = dofsByNode.get(vertex);
      if (!dofs) {
        dofs = new Set();
        dofsByNode.set(vertex, dofs);
      }
      dofs.add(c.dof);
    } else {
      prescribed_dofs.push({ vertex, dof: c.dof, value });
    }
  }
  const fixed_vertices: number[] = [];
  const fixed_dofs: { vertex: number; dofs: number[] }[] = [];
  for (const [vertex, dofSet] of dofsByNode) {
    if (dofSet.size === 3) fixed_vertices.push(vertex);
    else fixed_dofs.push({ vertex, dofs: [...dofSet].sort() });
  }
  return { fixed_vertices, fixed_dofs, prescribed_dofs };
}

// Group translational force loads by vertex index, accumulating [fx,fy,fz]
export function groupPointLoads(loads: Load[], vid: VertexIndexer) {
  const loadMap = new Map<number, [number, number, number]>();
  for (const load of loads) {
    if (load.dof > 2) continue;
    const vertex = vid(load.nodeId, "load");
    let force = loadMap.get(vertex);
    if (!force) {
      force = [0, 0, 0];
      loadMap.set(vertex, force);
    }
    force[load.dof] += load.value;
  }
  return [...loadMap.entries()].map(([vertex, force]) => ({ vertex, force }));
}
