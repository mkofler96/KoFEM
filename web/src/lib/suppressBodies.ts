// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// The store and the worker each declare their own node/element types; the
// filter only needs ids, connectivity and the body.
interface MeshNode {
  id: number;
}
interface MeshElement {
  id: number;
  nodeIds: number[];
  propertyId?: number;
}

export interface VolumeMeshParts<N extends MeshNode, E extends MeshElement> {
  nodes: N[];
  elements: E[];
  surfaceTriangles: [number, number, number][];
  surfaceFaceIds: number[];
}

const faceKey = (a: number, b: number, c: number) =>
  [a, b, c].sort((x, y) => x - y).join(",");

// The four faces of a tetrahedron, by its first four (corner) nodes.
function tetFaces(n: number[]): [number, number, number][] {
  return [
    [n[0], n[1], n[2]],
    [n[0], n[1], n[3]],
    [n[0], n[2], n[3]],
    [n[1], n[2], n[3]],
  ];
}

// Take suppressed bodies out of a fresh volume mesh. Netgen meshes the whole
// imprinted assembly, so a suppressed body is dropped afterwards: its tets go,
// then every node no remaining tet uses (a free node has no stiffness and would
// make the system singular), and every boundary triangle no remaining tet owns.
// A face a kept body shared with a suppressed one stays — it is now that kept
// body's outer surface. Nodes and elements are renumbered densely, the way the
// mesher numbers them.
export function dropSuppressedBodies<N extends MeshNode, E extends MeshElement>(
  mesh: VolumeMeshParts<N, E>,
  suppressed: ReadonlySet<number>,
): VolumeMeshParts<N, E> {
  if (suppressed.size === 0) return mesh;
  const kept = mesh.elements.filter(
    (el) => el.propertyId === undefined || !suppressed.has(el.propertyId),
  );
  if (kept.length === 0)
    throw new Error(
      `Every body of the mesh is suppressed (bodies ${[...suppressed].join(", ")}) — nothing is left to analyse. Unsuppress at least one body.`,
    );

  const newId = new Map<number, number>();
  const nodes: N[] = [];
  for (const el of kept)
    for (const id of el.nodeIds)
      if (!newId.has(id)) {
        const node = mesh.nodes[id];
        if (!node || node.id !== id)
          throw new Error(
            `dropSuppressedBodies: element ${el.id} references node ${id}, which is not at index ${id} of the mesh`,
          );
        newId.set(id, nodes.length);
        nodes.push({ ...node, id: nodes.length });
      }
  const remap = (id: number) => {
    const mapped = newId.get(id);
    if (mapped === undefined)
      throw new Error(
        `dropSuppressedBodies: node ${id} is used by a kept triangle but by no kept element`,
      );
    return mapped;
  };

  const owned = new Set<string>();
  for (const el of kept)
    for (const [a, b, c] of tetFaces(el.nodeIds)) owned.add(faceKey(a, b, c));
  const surfaceTriangles: [number, number, number][] = [];
  const surfaceFaceIds: number[] = [];
  mesh.surfaceTriangles.forEach(([a, b, c], i) => {
    if (!owned.has(faceKey(a, b, c))) return;
    surfaceTriangles.push([remap(a), remap(b), remap(c)]);
    surfaceFaceIds.push(mesh.surfaceFaceIds[i]);
  });

  const elements = kept.map((el, i): E => ({
    ...el,
    id: i,
    nodeIds: el.nodeIds.map(remap),
  }));
  return { nodes, elements, surfaceTriangles, surfaceFaceIds };
}
