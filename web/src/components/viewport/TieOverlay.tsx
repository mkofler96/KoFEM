// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// JS-0455 checks DOM attributes; these are Three.js objects whose properties
// are checked by React Three Fiber's TypeScript types. Annotate only those props.

// Tie connections: the two tied surfaces of every connection (and of the tie
// being picked), and the links each connection makes — between the node pairs
// it welds, or from each node it constrains to where that node is tied.

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
  const { pairs: tiePairs, constraints: tieConstraints } = useTiePairs();
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

  // Tie links — one line segment per welded node pair or constrained node, plus
  // a marker at each tied node. This is the connection's actual effect: the
  // nodes it joins and what each is joined to, not just the surfaces it was
  // defined on. A constrained node's link ends at its projection on the
  // opposite surface, which is a point of a face rather than a node.
  const tieLinks = useMemo(() => {
    const count = tiePairs.length + tieConstraints.length;
    if (count === 0) return null;
    const positions = new Float32Array(6 * count);
    const markers: { key: string; pos: [number, number, number] }[] = [];
    let written = 0;
    const link = (
      from: readonly [number, number, number],
      to: readonly [number, number, number],
    ) => {
      positions.set(from, 6 * written);
      positions.set(to, 6 * written + 3);
      written++;
    };
    for (const pair of tiePairs) {
      const from = nodeMap.get(pair.aId);
      const to = nodeMap.get(pair.bId);
      if (!from || !to) continue;
      link([from.n.x, from.n.y, from.n.z], [to.n.x, to.n.y, to.n.z]);
      markers.push({
        key: `a${pair.aId}`,
        pos: [from.n.x, from.n.y, from.n.z],
      });
      markers.push({ key: `b${pair.bId}`, pos: [to.n.x, to.n.y, to.n.z] });
    }
    for (const constraint of tieConstraints) {
      const from = nodeMap.get(constraint.slaveId);
      if (!from) continue;
      link([from.n.x, from.n.y, from.n.z], constraint.point);
      markers.push({
        key: `s${constraint.slaveId}`,
        pos: [from.n.x, from.n.y, from.n.z],
      });
    }
    if (written === 0) return null;
    return { positions: positions.subarray(0, 6 * written), markers };
  }, [tiePairs, tieConstraints, nodeMap]);

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

      {/* Tie links — a line per welded node pair or constrained node and a dot
          at each tied node, so the contact patch a connection produced is
          visible */}
      {tieLinks && (
        <group>
          <lineSegments
            // skipcq: JS-0455 -- typed React Three Fiber property
            renderOrder={4}
          >
            <bufferGeometry>
              <bufferAttribute
                // skipcq: JS-0455 -- typed React Three Fiber property
                attach="attributes-position"
                // skipcq: JS-0455 -- typed React Three Fiber property
                args={[tieLinks.positions, 3]}
              />
            </bufferGeometry>
            <lineBasicMaterial
              color={TIE_COLOR_A}
              // skipcq: JS-0455 -- typed React Three Fiber property
              depthTest={false}
            />
          </lineSegments>
          {tieLinks.markers.map((marker) => (
            <mesh
              key={`tie-node-${marker.key}`}
              // skipcq: JS-0455 -- typed React Three Fiber property
              position={marker.pos}
              // skipcq: JS-0455 -- typed React Three Fiber property
              renderOrder={4}
            >
              <sphereGeometry
                // skipcq: JS-0455 -- typed React Three Fiber property
                args={[modelSize * 0.008, 8, 6]}
              />
              <meshBasicMaterial
                color={TIE_COLOR_A}
                // skipcq: JS-0455 -- typed React Three Fiber property
                depthTest={false}
              />
            </mesh>
          ))}
        </group>
      )}
    </>
  );
}
