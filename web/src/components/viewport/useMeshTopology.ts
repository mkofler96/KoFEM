// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Shared FEM-mesh topology derived from the model store: node lookup, model
// extent, boundary face extraction and the pickable boundary-mesh topology.
// Computed once by MeshScene and passed to every viewport layer so the
// (potentially large) boundary extraction runs a single time per mesh.

import { useMemo } from "react";
import { useModelStore } from "../../store/modelStore";
import type { Element, Node } from "../../store/modelStore";
import {
  buildBoundaryMeshTopo,
  mapTrianglesToCadFaces,
} from "../../lib/facePick";
import type { BoundaryMeshTopo, Tri, Vec3 } from "../../lib/facePick";

export type NodeMap = Map<number, { n: Node; i: number }>;

export interface MeshTopology {
  nodeMap: NodeMap;
  modelSize: number;
  hexElements: Element[];
  tetElements: Element[];
  triElements: Element[];
  boundaryQuadFaceIds: [number, number, number, number][];
  boundaryTriFaceIds: [number, number, number][];
  boundaryMeshTopo: BoundaryMeshTopo | null;
}

// ── CHEXA geometry ────────────────────────────────────────────────────────────

export const HEX_EDGES: [number, number][] = [
  [0, 1],
  [1, 2],
  [2, 3],
  [3, 0],
  [4, 5],
  [5, 6],
  [6, 7],
  [7, 4],
  [0, 4],
  [1, 5],
  [2, 6],
  [3, 7],
];

const HEX_FACE_DEFS: [number, number, number, number][] = [
  [0, 1, 2, 3],
  [4, 5, 6, 7],
  [0, 1, 5, 4],
  [2, 3, 7, 6],
  [0, 3, 7, 4],
  [1, 2, 6, 5],
];

function extractBoundaryQuadFaceIds(
  hexElems: { nodeIds: number[] }[],
): [number, number, number, number][] {
  const faceMap = new Map<
    string,
    { face: [number, number, number, number]; count: number }
  >();
  for (const el of hexElems) {
    for (const [a, b, c, d] of HEX_FACE_DEFS) {
      const face: [number, number, number, number] = [
        el.nodeIds[a],
        el.nodeIds[b],
        el.nodeIds[c],
        el.nodeIds[d],
      ];
      const key = [...face].sort((x, y) => x - y).join(",");
      const entry = faceMap.get(key);
      if (entry) {
        entry.count++;
      } else {
        faceMap.set(key, { face, count: 1 });
      }
    }
  }
  return [...faceMap.values()].filter((e) => e.count === 1).map((e) => e.face);
}

// ── CTETRA geometry ───────────────────────────────────────────────────────────

export const TET_EDGES: [number, number][] = [
  [0, 1],
  [0, 2],
  [0, 3],
  [1, 2],
  [1, 3],
  [2, 3],
];

// ── CTRIA3 (shell) geometry ───────────────────────────────────────────────────

export const TRI_EDGES: [number, number][] = [
  [0, 1],
  [1, 2],
  [2, 0],
];

const TET_FACE_DEFS: [number, number, number][] = [
  [0, 1, 2],
  [0, 1, 3],
  [0, 2, 3],
  [1, 2, 3],
];

function extractBoundaryTriFaceIds(
  tetElems: { nodeIds: number[] }[],
): [number, number, number][] {
  const faceMap = new Map<
    string,
    { face: [number, number, number]; count: number }
  >();
  for (const el of tetElems) {
    for (const [a, b, c] of TET_FACE_DEFS) {
      const face: [number, number, number] = [
        el.nodeIds[a],
        el.nodeIds[b],
        el.nodeIds[c],
      ];
      const key = [...face].sort((x, y) => x - y).join(",");
      const entry = faceMap.get(key);
      if (entry) {
        entry.count++;
      } else {
        faceMap.set(key, { face, count: 1 });
      }
    }
  }
  return [...faceMap.values()].filter((e) => e.count === 1).map((e) => e.face);
}

// ── Helpers ───────────────────────────────────────────────────────────────────

export function buildFacePositions(
  nodeIds: number[],
  triangles: [number, number, number][],
  nodeMap: NodeMap,
): Float32Array | null {
  const nodeIdSet = new Set(nodeIds);
  const positions: number[] = [];
  for (const [a, b, c] of triangles) {
    if (!nodeIdSet.has(a) || !nodeIdSet.has(b) || !nodeIdSet.has(c)) continue;
    const na = nodeMap.get(a)?.n,
      nb = nodeMap.get(b)?.n,
      nc = nodeMap.get(c)?.n;
    if (!na || !nb || !nc) continue;
    positions.push(na.x, na.y, na.z, nb.x, nb.y, nb.z, nc.x, nc.y, nc.z);
  }
  return positions.length > 0 ? new Float32Array(positions) : null;
}

// ── Hook ──────────────────────────────────────────────────────────────────────

export function useMeshTopology(): MeshTopology {
  const nodes = useModelStore((s) => s.nodes);
  const elements = useModelStore((s) => s.elements);
  const surfaceTriangles = useModelStore((s) => s.surfaceTriangles);
  const surfaceFaceIds = useModelStore((s) => s.surfaceFaceIds);

  const nodeMap = useMemo(
    () => new Map(nodes.map((n, i) => [n.id, { n, i }])),
    [nodes],
  );

  const modelSize = useMemo(() => {
    if (nodes.length === 0) return 1;
    let minX = Infinity,
      maxX = -Infinity,
      minY = Infinity,
      maxY = -Infinity,
      minZ = Infinity,
      maxZ = -Infinity;
    for (const n of nodes) {
      if (n.x < minX) minX = n.x;
      if (n.x > maxX) maxX = n.x;
      if (n.y < minY) minY = n.y;
      if (n.y > maxY) maxY = n.y;
      if (n.z < minZ) minZ = n.z;
      if (n.z > maxZ) maxZ = n.z;
    }
    return Math.max(maxX - minX, maxY - minY, maxZ - minZ, 1e-9);
  }, [nodes]);

  // Bodies hidden via the Bodies panel eye toggle (#353) are dropped from the
  // mesh here, so the eye hides a body in the FEM surface / volume views just
  // as it does in the geometry tessellation. Nodes and modelSize stay whole
  // (fit-to-view and the deformed-result node count must not change).
  //
  // A shell-idealised body owns no elements of its own — its walls are PSHELLs
  // derived from it — so hiding it has to reach those too, or the eye would
  // leave the body's shell facets floating on screen.
  const hiddenBodyIds = useModelStore((s) => s.hiddenBodyIds);
  const properties = useModelStore((s) => s.properties);
  const hiddenPropertyIds = useMemo(() => {
    if (hiddenBodyIds.length === 0) return null;
    const hidden = new Set(hiddenBodyIds);
    for (const prop of properties)
      if (prop.sourceBodyId !== undefined && hidden.has(prop.sourceBodyId))
        hidden.add(prop.id);
    return hidden;
  }, [hiddenBodyIds, properties]);
  const visibleElements = useMemo(
    () =>
      hiddenPropertyIds === null
        ? elements
        : elements.filter((e) => !hiddenPropertyIds.has(e.propertyId)),
    [elements, hiddenPropertyIds],
  );

  const hexElements = useMemo(
    () => visibleElements.filter((e) => e.type === "CHEXA"),
    [visibleElements],
  );
  const tetElements = useMemo(
    () => visibleElements.filter((e) => e.type === "CTETRA"),
    [visibleElements],
  );
  const triElements = useMemo(
    () => visibleElements.filter((e) => e.type === "CTRIA3"),
    [visibleElements],
  );

  const boundaryQuadFaceIds = useMemo(
    () => extractBoundaryQuadFaceIds(hexElements),
    [hexElements],
  );
  // Solid boundary faces (tet faces used exactly once) plus every shell facet —
  // a shell element IS surface, so its facet always renders and picks.
  const boundaryTriFaceIds = useMemo(
    () => [
      ...extractBoundaryTriFaceIds(tetElements),
      ...triElements.map(
        (el) =>
          [el.nodeIds[0], el.nodeIds[1], el.nodeIds[2]] as [
            number,
            number,
            number,
          ],
      ),
    ],
    [tetElements, triElements],
  );

  // Boundary mesh topology for face picking.
  // Triangle order matches the undeformed-surface BufferGeometry exactly so that
  // e.faceIndex from raycasting maps directly into this triangles array.
  //
  // When surfaceFaceIds from the store is present (STEP mesh via Netgen OCC),
  // a sorted-vertex lookup maps each boundary triangle to its OCC face index.
  // pickFaceNodeIds then does an instant lookup instead of BFS flood-fill.
  const boundaryMeshTopo = useMemo(() => {
    const triangles: Tri[] = [];
    for (const [a, b, c, d] of boundaryQuadFaceIds) {
      triangles.push([a, b, c], [a, c, d]);
    }
    for (const [a, b, c] of boundaryTriFaceIds) {
      triangles.push([a, b, c]);
    }
    if (triangles.length === 0) return null;

    const getPos = (id: number): Vec3 => {
      const n = nodeMap.get(id)?.n;
      if (!n)
        throw new Error(
          `Boundary triangle references node id ${id} missing from nodeMap ` +
            "while building face-picking topology — mesh/topology desync",
        );
      return [n.x, n.y, n.z];
    };

    // Per-triangle CAD face ids, sparse where the mesh has no CAD face behind a
    // triangle (see mapTrianglesToCadFaces).
    const faceIds = mapTrianglesToCadFaces(
      triangles,
      surfaceTriangles,
      surfaceFaceIds,
    );

    return buildBoundaryMeshTopo(triangles, getPos, faceIds);
  }, [
    boundaryQuadFaceIds,
    boundaryTriFaceIds,
    nodeMap,
    surfaceTriangles,
    surfaceFaceIds,
  ]);

  return useMemo(
    () => ({
      nodeMap,
      modelSize,
      hexElements,
      tetElements,
      triElements,
      boundaryQuadFaceIds,
      boundaryTriFaceIds,
      boundaryMeshTopo,
    }),
    [
      nodeMap,
      modelSize,
      hexElements,
      tetElements,
      triElements,
      boundaryQuadFaceIds,
      boundaryTriFaceIds,
      boundaryMeshTopo,
    ],
  );
}
