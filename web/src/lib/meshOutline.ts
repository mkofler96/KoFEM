// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// What the viewport draws of a FEM mesh, around the Rust search
// (crates/kofem-fem/src/mesh_outline.rs, KOF-457): the outer faces (a face
// exactly one element uses; the elements inside are never drawn), every edge
// once however many elements share it, and the line segments for a set of
// edges, written straight into the GPU buffer. Elements name nodes by id. The
// Rust module must be loaded first (loadFemModule).

import { outerFaces, uniqueEdges } from "../wasm/fem/kofem_wasm.js";
import type { Element, Node } from "../store/modelStore";

// Node by id, with its index into the node list (the viewport's NodeMap).
type NodeLookup = ReadonlyMap<
  number,
  { n: Pick<Node, "x" | "y" | "z">; i: number }
>;

type Corners = Pick<Element, "id" | "type" | "nodeIds">;

const NO_ELEMENTS = new Uint32Array(0);

// The first `per` node ids of each element (its corners), flat.
function cornerIds(elements: readonly Corners[], per: number): Uint32Array {
  const ids = new Uint32Array(per * elements.length);
  elements.forEach((element, index) => {
    if (element.nodeIds.length < per)
      throw new Error(
        `element ${element.id} has ${element.nodeIds.length} nodes; a ${element.type} needs ${per}`,
      );
    for (let corner = 0; corner < per; corner++) {
      const id = element.nodeIds[corner];
      if (!Number.isInteger(id) || id < 0 || id > 0xffffffff)
        throw new Error(
          `element ${element.id} names node id ${id}, which is not a non-negative 32-bit integer`,
        );
      ids[per * index + corner] = id;
    }
  });
  return ids;
}

function groups<T extends number[]>(flat: Uint32Array, per: number): T[] {
  const out: T[] = new Array<T>(flat.length / per);
  for (let at = 0; at < out.length; at++)
    out[at] = Array.from(flat.subarray(per * at, per * (at + 1))) as T;
  return out;
}

export interface OuterFaces {
  triangles: [number, number, number][];
  quadrilaterals: [number, number, number, number][];
}

/** The faces exactly one tetrahedron or hexahedron uses, as node ids. */
export function meshOuterFaces(
  tets: readonly Corners[],
  hexes: readonly Corners[],
): OuterFaces {
  const faces = outerFaces(cornerIds(tets, 4), cornerIds(hexes, 8));
  try {
    return {
      triangles: groups<[number, number, number]>(faces.triangles, 3),
      quadrilaterals: groups<[number, number, number, number]>(
        faces.quadrilaterals,
        4,
      ),
    };
  } finally {
    faces.free();
  }
}

/** Every element edge once, as node-id pairs: the mesh's wireframe. */
export function meshEdges(
  tets: readonly Corners[],
  hexes: readonly Corners[],
  shellTriangles: readonly Corners[],
): Uint32Array {
  return uniqueEdges(
    cornerIds(tets, 4),
    cornerIds(hexes, 8),
    cornerIds(shellTriangles, 3),
    NO_ELEMENTS,
  );
}

/** Every edge of the given faces once, as node-id pairs: their outline. */
export function outlineEdges(
  triangles: readonly (readonly number[])[],
  quadrilaterals: readonly (readonly number[])[],
): Uint32Array {
  return uniqueEdges(
    NO_ELEMENTS,
    NO_ELEMENTS,
    Uint32Array.from(triangles.flat()),
    Uint32Array.from(quadrilaterals.flat()),
  );
}

/**
 * Segment end points for `edges` (node-id pairs): the nodes as they are, or
 * moved by `displacements` (3 per node, in node order) times `scale`.
 */
export function edgeSegmentPositions(
  edges: Uint32Array,
  nodeMap: NodeLookup,
  displacements: Float64Array | null,
  scale: number,
): Float32Array {
  const positions = new Float32Array(3 * edges.length);
  for (let at = 0; at < edges.length; at++) {
    const entry = nodeMap.get(edges[at]);
    if (!entry)
      throw new Error(
        `an edge names node id ${edges[at]}, which is not in the mesh — mesh/topology desync`,
      );
    const { n, i } = entry;
    const shift = (axis: number) =>
      displacements === null ? 0 : displacements[3 * i + axis] * scale;
    positions[3 * at] = n.x + shift(0);
    positions[3 * at + 1] = n.y + shift(1);
    positions[3 * at + 2] = n.z + shift(2);
  }
  return positions;
}
