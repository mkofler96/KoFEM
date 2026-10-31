// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Fixed-support markers: a small triangular cone at every constrained node.

import { useMemo } from "react";
import { Quaternion, Vector3 } from "three";
import { useModelStore } from "../../store/modelStore";
import type { MeshTopology } from "./useMeshTopology";
import { modelCentroid, nodePosition } from "./bcOverlayShared";

interface BcNodeMarkersProps {
  topology: MeshTopology;
  showResult: boolean;
}

export function BcNodeMarkers({ topology, showResult }: BcNodeMarkersProps) {
  const nodes = useModelStore((s) => s.nodes);
  const constraints = useModelStore((s) => s.constraints);
  const { nodeMap, modelSize, boundaryQuadFaceIds, boundaryTriFaceIds } =
    topology;

  // BC markers — one small triangular cone per constrained node (apex at the
  // node, base outward), replacing the former single centroid marker. Each
  // marker is oriented along the outward normal of the constrained surface,
  // accumulated area-weighted over the boundary faces whose nodes are all
  // constrained (the same membership test the surface loads use) — so markers
  // on a flat fixed face all point along its normal instead of fanning out at
  // edges and corners, while nodes on a curved face get averaged directions.
  const bcNodeMarkers = useMemo(() => {
    if (constraints.length === 0 || nodes.length === 0) return [];
    const ids = new Set(constraints.map((c) => c.nodeId));

    // Model centroid — orients face normals outward, and is the fallback
    // direction for a constrained node on no boundary face.
    const centroid = modelCentroid(nodes);
    const posOf = (id: number) => nodePosition(nodeMap, id);

    const outward = new Map<number, Vector3>();
    const addFace = (faceIds: number[]) => {
      if (!faceIds.every((id) => ids.has(id))) return;
      const pts = faceIds.map(posOf);
      if (pts.some((pt) => pt === null)) return;
      const corners = pts as Vector3[];

      // Area-weighted normal: triangle directly, quad via its diagonals.
      const normal = new Vector3();
      if (corners.length === 3) {
        normal
          .copy(corners[1])
          .sub(corners[0])
          .cross(new Vector3().copy(corners[2]).sub(corners[0]));
      } else {
        normal
          .copy(corners[2])
          .sub(corners[0])
          .cross(new Vector3().copy(corners[3]).sub(corners[1]));
      }
      if (normal.lengthSq() < 1e-30) return;

      const fc = new Vector3();
      for (const v of corners) fc.add(v);
      fc.divideScalar(corners.length);
      if (normal.dot(new Vector3().copy(centroid).sub(fc)) > 0) normal.negate();

      for (const id of faceIds) {
        // eslint-disable-next-line kofem/no-silent-fallback -- accumulating face normals; the zero vector is the identity for a node seen for the first time
        const acc = outward.get(id) ?? new Vector3();
        outward.set(id, acc.add(normal));
      }
    };
    for (const tri of boundaryTriFaceIds) addFace(tri);
    for (const quad of boundaryQuadFaceIds) addFace(quad);

    const down = new Vector3(0, -1, 0);
    const markers: {
      nodeId: number;
      pos: [number, number, number];
      quaternion: Quaternion;
    }[] = [];
    for (const id of ids) {
      const pos = posOf(id);
      if (!pos) continue;
      let dir = outward.get(id);
      if (!dir || dir.lengthSq() < 1e-30)
        dir = new Vector3().copy(pos).sub(centroid);
      if (dir.lengthSq() < 1e-30) continue;
      dir.normalize();
      // Rotate so that -Y (cone base direction) aligns with the outward normal
      const quaternion = new Quaternion().setFromUnitVectors(down, dir);
      markers.push({ nodeId: id, pos: [pos.x, pos.y, pos.z], quaternion });
    }
    return markers;
  }, [constraints, nodeMap, nodes, boundaryTriFaceIds, boundaryQuadFaceIds]);

  if (showResult) return null;
  return (
    <>
      {/* BC markers — a small triangular fixed-support symbol at every
          constrained node (3-sided cone, apex at the node, base outward) */}
      {bcNodeMarkers.map((m) => (
        <group
          key={`bc-node-${m.nodeId}`}
          position={m.pos}
          quaternion={m.quaternion}
        >
          <mesh position={[0, -modelSize * 0.025, 0]}>
            <coneGeometry args={[modelSize * 0.02, modelSize * 0.05, 3]} />
            <meshStandardMaterial color="#dc2626" />
          </mesh>
        </group>
      ))}
    </>
  );
}
