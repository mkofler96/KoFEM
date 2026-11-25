// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// FEM mesh display: the undeformed boundary surface (pickable), surface- and
// volume-edge wireframes, and their displacement-deformed counterparts in
// results mode. The vertex-coloured result surface lives in ResultsColormap.

import { useMemo } from "react";
import * as THREE from "three";
import type { ThreeEvent } from "@react-three/fiber";
import { useModelStore } from "../../store/modelStore";
import type { ViewRepr } from "../../store/viewSlice";
import type { MeshTopology } from "./useMeshTopology";
import {
  edgeSegmentPositions,
  meshEdges,
  outlineEdges,
} from "../../lib/meshOutline";

// Line segments for `edges` (node-id pairs), or null when there are none.
function undeformedSegments(
  edges: Uint32Array | null,
  nodeMap: MeshTopology["nodeMap"],
): Float32Array | null {
  return edges && edges.length > 0
    ? edgeSegmentPositions(edges, nodeMap, null, 1)
    : null;
}

// As undeformedSegments, the nodes moved by the scaled displacements; null
// without displacements that fit the mesh.
function deformedSegments(
  edges: Uint32Array | null,
  nodeMap: MeshTopology["nodeMap"],
  displacements: Float64Array | null,
  scale: number,
): Float32Array | null {
  return edges && edges.length > 0 && displacements
    ? edgeSegmentPositions(edges, nodeMap, displacements, scale)
    : null;
}

interface FemMeshLayerProps {
  topology: MeshTopology;
  // Effective representation, as resolved by MeshScene — not necessarily the
  // stored viewRepr: a body highlight overrides it while the pointer rests on
  // a Bodies-panel row.
  repr: ViewRepr;
  deformScale: number;
  showResult: boolean;
  onFacePick?: (e: ThreeEvent<MouseEvent>) => void;
  // The section plane's clipping plane in results mode, or none (KOF-390).
  clippingPlanes: THREE.Plane[];
}

export function FemMeshLayer({
  topology,
  repr,
  deformScale,
  showResult,
  onFacePick,
  clippingPlanes,
}: FemMeshLayerProps) {
  const result = useModelStore((s) => s.result);
  const showUndeformedOverlay = useModelStore((s) => s.showUndeformedOverlay);

  const {
    nodeMap,
    hexElements,
    tetElements,
    triElements,
    boundaryQuadFaceIds,
    boundaryTriFaceIds,
    femReady,
  } = topology;

  // Edge overlays per representation: Geometry → none, Surface → boundary edges,
  // Wireframe → every element edge with no fill.
  const showSolid = repr !== "wireframe";
  const showSurfaceEdges = repr === "surface";
  const showAllEdges = repr === "wireframe";

  // Every element edge once (lib/meshOutline), built only while a
  // representation shows them: on a large mesh it is the biggest buffer here.
  const allEdges = useMemo(
    () =>
      showAllEdges && femReady
        ? meshEdges(tetElements, hexElements, triElements)
        : null,
    [showAllEdges, femReady, tetElements, hexElements, triElements],
  );
  // The outline of the outer faces, for the Surface representation and the
  // undeformed overlay over a result.
  const surfaceEdges = useMemo(
    () =>
      femReady && (showSurfaceEdges || (showResult && showUndeformedOverlay))
        ? outlineEdges(boundaryTriFaceIds, boundaryQuadFaceIds)
        : null,
    [
      femReady,
      showSurfaceEdges,
      showResult,
      showUndeformedOverlay,
      boundaryTriFaceIds,
      boundaryQuadFaceIds,
    ],
  );

  // A remesh can change the node count/ids after a solve completes but before
  // `result` is invalidated. Drawing the displacements against a mismatched
  // nodeMap would draw a plausible-looking but wrong deformed shape — draw no
  // deformed edges instead.
  const displacements =
    result && result.displacements.length === nodeMap.size * 3
      ? result.displacements
      : null;

  const undeformedEdgePositions = useMemo(
    () => (showResult ? null : undeformedSegments(allEdges, nodeMap)),
    [showResult, allEdges, nodeMap],
  );
  const deformedEdgePositions = useMemo(
    () =>
      showResult
        ? deformedSegments(allEdges, nodeMap, displacements, deformScale)
        : null,
    [showResult, allEdges, nodeMap, displacements, deformScale],
  );
  const undeformedSurfaceEdgePositions = useMemo(
    () => undeformedSegments(surfaceEdges, nodeMap),
    [surfaceEdges, nodeMap],
  );
  // Boundary edges of the deformed mesh — the Surface representation in
  // results mode.
  const deformedSurfaceEdgePositions = useMemo(
    () =>
      showResult && showSurfaceEdges
        ? deformedSegments(surfaceEdges, nodeMap, displacements, deformScale)
        : null,
    [
      showResult,
      showSurfaceEdges,
      surfaceEdges,
      nodeMap,
      displacements,
      deformScale,
    ],
  );

  // Undeformed surface for display and face picking
  const undeformedSurface = useMemo(() => {
    const hasQuads = boundaryQuadFaceIds.length > 0;
    const hasTris = boundaryTriFaceIds.length > 0;
    if (!hasQuads && !hasTris) return null;

    const positions: number[] = [];
    const normals: number[] = [];

    const xyz = (n: { x: number; y: number; z: number }) =>
      [n.x, n.y, n.z] as [number, number, number];

    const nodeById = (id: number) => {
      const entry = nodeMap.get(id);
      if (!entry)
        throw new Error(
          `Boundary face references node id ${id} missing from nodeMap ` +
            "while building the undeformed surface — mesh/topology desync",
        );
      return entry.n;
    };

    for (const [a, b, c_, dd] of boundaryQuadFaceIds) {
      const pa = nodeById(a),
        pb = nodeById(b);
      const pc = nodeById(c_),
        pd = nodeById(dd);
      positions.push(
        ...xyz(pa),
        ...xyz(pb),
        ...xyz(pc),
        ...xyz(pa),
        ...xyz(pc),
        ...xyz(pd),
      );
      const AB = new THREE.Vector3(pb.x - pa.x, pb.y - pa.y, pb.z - pa.z);
      const AC = new THREE.Vector3(pc.x - pa.x, pc.y - pa.y, pc.z - pa.z);
      const norm = AB.cross(AC).normalize();
      for (let k = 0; k < 6; k++) normals.push(norm.x, norm.y, norm.z);
    }
    for (const [a, b, c_] of boundaryTriFaceIds) {
      const pa = nodeById(a),
        pb = nodeById(b),
        pc = nodeById(c_);
      positions.push(...xyz(pa), ...xyz(pb), ...xyz(pc));
      const AB = new THREE.Vector3(pb.x - pa.x, pb.y - pa.y, pb.z - pa.z);
      const AC = new THREE.Vector3(pc.x - pa.x, pc.y - pa.y, pc.z - pa.z);
      const norm = AB.cross(AC).normalize();
      for (let k = 0; k < 3; k++) normals.push(norm.x, norm.y, norm.z);
    }

    return {
      positions: new Float32Array(positions),
      normals: new Float32Array(normals),
    };
  }, [boundaryQuadFaceIds, boundaryTriFaceIds, nodeMap]);

  // In the Geometry representation the CAD tessellation (GeometryLayer) stands
  // in for the part, so the FEM boundary surface must not also draw — otherwise
  // the two overlap and z-fight. The edge overlays are already representation-
  // gated below; this gates the solid fill to match.
  const showFemSurface = repr !== "geometry";

  return (
    <group>
      {/* Undeformed solid surface — light blue-grey on light background */}
      {!showResult && showFemSurface && undeformedSurface && (
        <mesh onClick={onFacePick}>
          <bufferGeometry>
            <bufferAttribute
              attach="attributes-position"
              args={[undeformedSurface.positions, 3]}
            />
            <bufferAttribute
              attach="attributes-normal"
              args={[undeformedSurface.normals, 3]}
            />
          </bufferGeometry>
          <meshStandardMaterial
            color="#b8cce4"
            side={THREE.DoubleSide}
            wireframe={!showSolid}
          />
        </mesh>
      )}

      {/* Surface (boundary) edges — Surface representation */}
      {!showResult && showSurfaceEdges && undeformedSurfaceEdgePositions && (
        <lineSegments
          name="fem-surface-edges"
          userData={{ segments: undeformedSurfaceEdgePositions.length / 6 }}
        >
          <bufferGeometry>
            <bufferAttribute
              attach="attributes-position"
              args={[undeformedSurfaceEdgePositions, 3]}
            />
          </bufferGeometry>
          <lineBasicMaterial color="#2d4a6b" />
        </lineSegments>
      )}

      {/* All element edges — Wireframe representation */}
      {!showResult && showAllEdges && undeformedEdgePositions && (
        <lineSegments
          name="fem-element-edges"
          userData={{ segments: undeformedEdgePositions.length / 6 }}
        >
          <bufferGeometry>
            <bufferAttribute
              attach="attributes-position"
              args={[undeformedEdgePositions, 3]}
            />
          </bufferGeometry>
          <lineBasicMaterial color="#2d4a6b" />
        </lineSegments>
      )}

      {/* Deformed surface (boundary) edges — Surface representation */}
      {showResult && showSurfaceEdges && deformedSurfaceEdgePositions && (
        <lineSegments
          name="fem-surface-edges"
          userData={{ segments: deformedSurfaceEdgePositions.length / 6 }}
        >
          <bufferGeometry>
            <bufferAttribute
              attach="attributes-position"
              args={[deformedSurfaceEdgePositions, 3]}
            />
          </bufferGeometry>
          <lineBasicMaterial
            color="#1e3a5f"
            transparent
            opacity={0.4}
            clippingPlanes={clippingPlanes}
          />
        </lineSegments>
      )}

      {/* Deformed element edges — Wireframe representation */}
      {showResult && showAllEdges && deformedEdgePositions && (
        <lineSegments
          name="fem-element-edges"
          userData={{ segments: deformedEdgePositions.length / 6 }}
        >
          <bufferGeometry>
            <bufferAttribute
              attach="attributes-position"
              args={[deformedEdgePositions, 3]}
            />
          </bufferGeometry>
          <lineBasicMaterial
            color="#1e3a5f"
            transparent
            opacity={0.4}
            clippingPlanes={clippingPlanes}
          />
        </lineSegments>
      )}

      {/* Undeformed geometry overlay — shows original surface edges as reference over deformed result */}
      {showResult &&
        showUndeformedOverlay &&
        undeformedSurfaceEdgePositions && (
          <lineSegments>
            <bufferGeometry>
              <bufferAttribute
                attach="attributes-position"
                args={[undeformedSurfaceEdgePositions, 3]}
              />
            </bufferGeometry>
            <lineBasicMaterial
              color="#6b8cad"
              transparent
              opacity={0.5}
              clippingPlanes={clippingPlanes}
            />
          </lineSegments>
        )}
    </group>
  );
}
