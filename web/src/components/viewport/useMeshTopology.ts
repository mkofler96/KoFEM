// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Shared FEM-mesh topology derived from the model store: node lookup, model
// extent, boundary face extraction and the pickable boundary-mesh topology.
// Computed once by MeshScene and passed to every viewport layer so the
// (potentially large) boundary extraction runs a single time per mesh.

import { useMemo } from "react";
import { useModelStore } from "../../store/modelStore";
import type { Element, Node } from "../../store/modelStore";
import { isCadBody } from "../../store/geometrySlice";
import {
  boundaryEdgesWithin,
  buildBoundaryMeshTopo,
  mapTrianglesToCadFaces,
} from "../../lib/facePick";
import type { BoundaryMeshTopo, Tri, Vec3 } from "../../lib/facePick";
import { modelShellRim, type ShellRim } from "../../lib/shellRim";
import { modelExtent } from "../../lib/deformScale";
import { meshOuterFaces, type OuterFaces } from "../../lib/meshOutline";
import { useFemModule } from "../../hooks/useFemModule";

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
  // Whether the Rust module that finds the outer faces and edges is loaded;
  // until it is, the mesh has none to draw.
  femReady: boolean;
  // The CAD faces a shell idealisation collapsed onto the mesh's rim, for edge
  // picking (lib/shellRim).
  shellRim: ShellRim;
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

// Segment endpoints (in pairs) of the boundary edges an edge selection covers,
// for EdgeOverlay; null when the node set covers no boundary edge.
export function buildEdgePositions(
  nodeIds: readonly number[],
  topo: BoundaryMeshTopo,
  nodeMap: NodeMap,
): Vec3[] | null {
  const points: Vec3[] = [];
  for (const [a, b] of boundaryEdgesWithin(nodeIds, topo)) {
    const na = nodeMap.get(a)?.n,
      nb = nodeMap.get(b)?.n;
    if (!na || !nb) continue;
    points.push([na.x, na.y, na.z], [nb.x, nb.y, nb.z]);
  }
  return points.length > 0 ? points : null;
}

// ── Hook ──────────────────────────────────────────────────────────────────────

export function useMeshTopology(): MeshTopology {
  const nodes = useModelStore((s) => s.nodes);
  const elements = useModelStore((s) => s.elements);
  const surfaceTriangles = useModelStore((s) => s.surfaceTriangles);
  const surfaceFaceIds = useModelStore((s) => s.surfaceFaceIds);
  const stepSurface = useModelStore((s) => s.stepSurface);

  const nodeMap = useMemo(
    () => new Map(nodes.map((n, i) => [n.id, { n, i }])),
    [nodes],
  );

  const modelSize = useMemo(() => modelExtent(nodes), [nodes]);

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
    // A suppressed body is gone until it is re-meshed away — never drawn, even
    // from a mesh made before it was suppressed.
    const hidden = new Set(hiddenBodyIds);
    for (const prop of properties)
      if (isCadBody(prop) && prop.suppressed) hidden.add(prop.id);
    if (hidden.size === 0) return null;
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

  // Only the outer faces are drawn (a face exactly one solid element uses),
  // found in Rust; the elements inside never reach the GPU.
  const { ready: femReady } = useFemModule();
  const outerFaces = useMemo<OuterFaces>(
    () =>
      femReady
        ? meshOuterFaces(tetElements, hexElements)
        : { triangles: [], quadrilaterals: [] },
    [femReady, tetElements, hexElements],
  );
  const boundaryQuadFaceIds = outerFaces.quadrilaterals;
  // Solid boundary faces plus every shell facet — a shell element IS surface,
  // so its facet always renders and picks.
  const boundaryTriFaceIds = useMemo(
    () => [
      ...outerFaces.triangles,
      ...triElements.map(
        (el) =>
          [el.nodeIds[0], el.nodeIds[1], el.nodeIds[2]] as [
            number,
            number,
            number,
          ],
      ),
    ],
    [outerFaces, triElements],
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

  // Over the whole mesh, like the groups it serves: a support on a collapsed
  // face holds its rim nodes whether or not the body is shown.
  const shellRim = useMemo(
    () =>
      modelShellRim(
        { nodes, elements, surfaceTriangles, surfaceFaceIds },
        stepSurface,
      ),
    [nodes, elements, surfaceTriangles, surfaceFaceIds, stepSurface],
  );

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
      femReady,
      shellRim,
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
      femReady,
      shellRim,
    ],
  );
}
