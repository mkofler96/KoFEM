// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Tie connections: the two tied surfaces of every connection (and of the tie
// being picked), and the links between the node pairs each connection welds.

import { useMemo } from "react";
import { useModelStore } from "../../store/modelStore";
import { useTiePairs } from "../../hooks/useTiePairs";
import { buildFacePositions } from "./useMeshTopology";
import type { MeshTopology } from "./useMeshTopology";
import { FaceOverlay } from "./FaceOverlay";

// Tie colours: surface A violet, surface B teal, so which face is tied to which
// is readable at a glance; the links between welded nodes take the A colour.
const TIE_COLOR_A = "#7c3aed";
const TIE_COLOR_B = "#0891b2";

interface TieOverlayProps {
  topology: MeshTopology;
  showResult: boolean;
}

export function TieOverlay({ topology, showResult }: TieOverlayProps) {
  const tieGroups = useModelStore((s) => s.tieGroups);
  const pickMode = useModelStore((s) => s.pickMode);
  const tieDraft = useModelStore((s) => s.tieDraft);
  const { pairs: tiePairs } = useTiePairs();
  const { nodeMap, modelSize, boundaryMeshTopo } = topology;

  // Tie face highlights — the two surfaces of every committed connection, side
  // A and side B in different colours so the pairing is legible. The parked
  // side of a tie pick session (tieDraft) is drawn the same way, because during
  // the pick only ONE side is in the live face-pick session and the other would
  // otherwise vanish from the viewport.
  const tieFaceHighlights = useMemo(() => {
    if (!boundaryMeshTopo) return null;
    const highlights: {
      key: string;
      positions: Float32Array;
      side: "a" | "b";
    }[] = [];
    const add = (
      key: string,
      faces: { nodeIds: number[] }[],
      side: "a" | "b",
    ) => {
      faces.forEach((face, i) => {
        const positions = buildFacePositions(
          face.nodeIds,
          boundaryMeshTopo.triangles,
          nodeMap,
        );
        if (positions) highlights.push({ key: `${key}-${i}`, positions, side });
      });
    };
    for (const group of tieGroups) {
      add(`tie-${group.id}-a`, group.facesA, "a");
      add(`tie-${group.id}-b`, group.facesB, "b");
    }
    if (pickMode === "tie") {
      add("tie-draft-a", tieDraft.a, "a");
      add("tie-draft-b", tieDraft.b, "b");
    }
    return highlights;
  }, [tieGroups, pickMode, tieDraft, boundaryMeshTopo, nodeMap]);

  // Tie links — one line segment per welded node pair, plus a marker at each
  // tied node. This is the connection's actual effect: the nodes it fuses and
  // which node each is fused to, not just the surfaces it was defined on.
  const tieLinks = useMemo(() => {
    if (tiePairs.length === 0) return null;
    const positions = new Float32Array(6 * tiePairs.length);
    const markers: { key: string; pos: [number, number, number] }[] = [];
    let written = 0;
    for (const pair of tiePairs) {
      const from = nodeMap.get(pair.aId);
      const to = nodeMap.get(pair.bId);
      if (!from || !to) continue;
      positions[6 * written] = from.n.x;
      positions[6 * written + 1] = from.n.y;
      positions[6 * written + 2] = from.n.z;
      positions[6 * written + 3] = to.n.x;
      positions[6 * written + 4] = to.n.y;
      positions[6 * written + 5] = to.n.z;
      written++;
      markers.push({
        key: `a${pair.aId}`,
        pos: [from.n.x, from.n.y, from.n.z],
      });
      markers.push({ key: `b${pair.bId}`, pos: [to.n.x, to.n.y, to.n.z] });
    }
    if (written === 0) return null;
    return { positions: positions.subarray(0, 6 * written), markers };
  }, [tiePairs, nodeMap]);

  if (showResult) return null;
  return (
    <>
      {/* Tie face highlights — the two tied surfaces of every connection */}
      {tieFaceHighlights?.map((highlight) => (
        <FaceOverlay
          key={highlight.key}
          positions={highlight.positions}
          color={highlight.side === "a" ? TIE_COLOR_A : TIE_COLOR_B}
          opacity={0.3}
          renderOrder={1}
        />
      ))}

      {/* Tie links — a line between every welded node pair and a dot at each
          tied node, so the contact patch a connection produced is visible */}
      {tieLinks && (
        <group>
          <lineSegments renderOrder={4}>
            <bufferGeometry>
              <bufferAttribute
                attach="attributes-position"
                args={[tieLinks.positions, 3]}
              />
            </bufferGeometry>
            <lineBasicMaterial color={TIE_COLOR_A} depthTest={false} />
          </lineSegments>
          {tieLinks.markers.map((marker) => (
            <mesh
              key={`tie-node-${marker.key}`}
              position={marker.pos}
              renderOrder={4}
            >
              <sphereGeometry args={[modelSize * 0.008, 8, 6]} />
              <meshBasicMaterial color={TIE_COLOR_A} depthTest={false} />
            </mesh>
          ))}
        </group>
      )}
    </>
  );
}
