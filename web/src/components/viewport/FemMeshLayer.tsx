// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// FEM mesh display: the undeformed boundary surface (pickable), surface- and
// volume-edge wireframes, and their displacement-deformed counterparts in
// results mode. The vertex-coloured result surface lives in ResultsColormap.

import { useMemo } from "react";
import * as THREE from "three";
import type { ThreeEvent } from "@react-three/fiber";
import { useModelStore } from "../../store/modelStore";
import { HEX_EDGES, TET_EDGES } from "./useMeshTopology";
import type { MeshTopology } from "./useMeshTopology";

interface FemMeshLayerProps {
  topology: MeshTopology;
  deformScale: number;
  showResult: boolean;
  onFacePick?: (e: ThreeEvent<MouseEvent>) => void;
}

export function FemMeshLayer({
  topology,
  deformScale,
  showResult,
  onFacePick,
}: FemMeshLayerProps) {
  const result = useModelStore((s) => s.result);
  const viewRepr = useModelStore((s) => s.viewRepr);
  const showUndeformedOverlay = useModelStore((s) => s.showUndeformedOverlay);

  const {
    nodeMap,
    hexElements,
    tetElements,
    boundaryQuadFaceIds,
    boundaryTriFaceIds,
  } = topology;

  const undeformedEdgePositions = useMemo(() => {
    const segs: number[] = [];
    const coord = (id: number) => {
      const entry = nodeMap.get(id)!;
      return [entry.n.x, entry.n.y, entry.n.z];
    };
    for (const el of hexElements) {
      for (const [a, b] of HEX_EDGES) {
        segs.push(...coord(el.nodeIds[a]), ...coord(el.nodeIds[b]));
      }
    }
    for (const el of tetElements) {
      for (const [a, b] of TET_EDGES) {
        segs.push(...coord(el.nodeIds[a]), ...coord(el.nodeIds[b]));
      }
    }
    return segs.length > 0 ? new Float32Array(segs) : null;
  }, [hexElements, tetElements, nodeMap]);

  const undeformedSurfaceEdgePositions = useMemo(() => {
    const seen = new Set<string>();
    const segs: number[] = [];
    const addEdge = (a: number, b: number) => {
      const key = a < b ? `${a},${b}` : `${b},${a}`;
      if (seen.has(key)) return;
      seen.add(key);
      const na = nodeMap.get(a)?.n,
        nb = nodeMap.get(b)?.n;
      if (!na || !nb) return;
      segs.push(na.x, na.y, na.z, nb.x, nb.y, nb.z);
    };
    for (const [a, b, c, d] of boundaryQuadFaceIds) {
      addEdge(a, b);
      addEdge(b, c);
      addEdge(c, d);
      addEdge(d, a);
    }
    for (const [a, b, c] of boundaryTriFaceIds) {
      addEdge(a, b);
      addEdge(b, c);
      addEdge(c, a);
    }
    return segs.length > 0 ? new Float32Array(segs) : null;
  }, [boundaryQuadFaceIds, boundaryTriFaceIds, nodeMap]);

  const deformedEdgePositions = useMemo(() => {
    if (!result) return null;
    const disp = result.displacements;
    // A remesh can change the node count/ids after a solve completes but
    // before `result` is invalidated. Rendering `disp` against a mismatched
    // nodeMap would silently zero-fill out-of-range nodes and draw a
    // plausible-looking but wrong deformed shape — bail instead.
    if (disp.length !== nodeMap.size * 3) return null;
    const coord = (id: number) => {
      const { n, i } = nodeMap.get(id)!;
      return [
        n.x + disp[i * 3] * deformScale,
        n.y + disp[i * 3 + 1] * deformScale,
        n.z + disp[i * 3 + 2] * deformScale,
      ];
    };
    const segs: number[] = [];
    for (const el of hexElements) {
      for (const [a, b] of HEX_EDGES) {
        segs.push(...coord(el.nodeIds[a]), ...coord(el.nodeIds[b]));
      }
    }
    for (const el of tetElements) {
      for (const [a, b] of TET_EDGES) {
        segs.push(...coord(el.nodeIds[a]), ...coord(el.nodeIds[b]));
      }
    }
    return segs.length > 0 ? new Float32Array(segs) : null;
  }, [result, hexElements, tetElements, nodeMap, deformScale]);

  // Boundary (surface) edges of the deformed mesh — the Surface representation in
  // results mode. Mirrors undeformedSurfaceEdgePositions but on deformed coords.
  const deformedSurfaceEdgePositions = useMemo(() => {
    if (!result) return null;
    const disp = result.displacements;
    if (disp.length !== nodeMap.size * 3) return null;
    const seen = new Set<string>();
    const segs: number[] = [];
    const addEdge = (a: number, b: number) => {
      const key = a < b ? `${a},${b}` : `${b},${a}`;
      if (seen.has(key)) return;
      seen.add(key);
      const na = nodeMap.get(a),
        nb = nodeMap.get(b);
      if (!na || !nb) return;
      segs.push(
        na.n.x + disp[na.i * 3] * deformScale,
        na.n.y + disp[na.i * 3 + 1] * deformScale,
        na.n.z + disp[na.i * 3 + 2] * deformScale,
        nb.n.x + disp[nb.i * 3] * deformScale,
        nb.n.y + disp[nb.i * 3 + 1] * deformScale,
        nb.n.z + disp[nb.i * 3 + 2] * deformScale,
      );
    };
    for (const [a, b, c, dd] of boundaryQuadFaceIds) {
      addEdge(a, b);
      addEdge(b, c);
      addEdge(c, dd);
      addEdge(dd, a);
    }
    for (const [a, b, c] of boundaryTriFaceIds) {
      addEdge(a, b);
      addEdge(b, c);
      addEdge(c, a);
    }
    return segs.length > 0 ? new Float32Array(segs) : null;
  }, [result, boundaryQuadFaceIds, boundaryTriFaceIds, nodeMap, deformScale]);

  // Undeformed surface for display and face picking
  const undeformedSurface = useMemo(() => {
    const hasQuads = boundaryQuadFaceIds.length > 0;
    const hasTris = boundaryTriFaceIds.length > 0;
    if (!hasQuads && !hasTris) return null;

    const positions: number[] = [];
    const normals: number[] = [];

    const xyz = (n: { x: number; y: number; z: number }) =>
      [n.x, n.y, n.z] as [number, number, number];

    for (const [a, b, c_, dd] of boundaryQuadFaceIds) {
      const pa = nodeMap.get(a)!.n,
        pb = nodeMap.get(b)!.n;
      const pc = nodeMap.get(c_)!.n,
        pd = nodeMap.get(dd)!.n;
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
      const pa = nodeMap.get(a)!.n,
        pb = nodeMap.get(b)!.n,
        pc = nodeMap.get(c_)!.n;
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

  // Edge overlays per representation: Geometry → none, Surface → boundary edges,
  // Volume → every element edge, Wireframe → every element edge with no fill.
  const showSolid = viewRepr !== "wireframe";
  const showSurfaceEdges = viewRepr === "surface";
  const showAllEdges = viewRepr === "volume" || viewRepr === "wireframe";

  return (
    <group>
      {/* Undeformed solid surface — light blue-grey on light background */}
      {!showResult && undeformedSurface && (
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
        <lineSegments>
          <bufferGeometry>
            <bufferAttribute
              attach="attributes-position"
              args={[undeformedSurfaceEdgePositions, 3]}
            />
          </bufferGeometry>
          <lineBasicMaterial color="#2d4a6b" />
        </lineSegments>
      )}

      {/* All element edges — Volume and Wireframe representations */}
      {!showResult && showAllEdges && undeformedEdgePositions && (
        <lineSegments>
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
        <lineSegments>
          <bufferGeometry>
            <bufferAttribute
              attach="attributes-position"
              args={[deformedSurfaceEdgePositions, 3]}
            />
          </bufferGeometry>
          <lineBasicMaterial color="#1e3a5f" transparent opacity={0.4} />
        </lineSegments>
      )}

      {/* Deformed element edges — Volume and Wireframe representations */}
      {showResult && showAllEdges && deformedEdgePositions && (
        <lineSegments>
          <bufferGeometry>
            <bufferAttribute
              attach="attributes-position"
              args={[deformedEdgePositions, 3]}
            />
          </bufferGeometry>
          <lineBasicMaterial color="#1e3a5f" transparent opacity={0.4} />
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
            <lineBasicMaterial color="#6b8cad" transparent opacity={0.5} />
          </lineSegments>
        )}
    </group>
  );
}
