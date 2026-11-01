// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// JS-0455 checks DOM attributes; these are Three.js objects whose properties
// are checked by React Three Fiber's TypeScript types. Annotate only those props.

// Surface-to-point couplings: the surface each coupling grips, its spider from
// the reference point to every gripped node, and the coupling being placed.

import { useMemo } from "react";
import { useModelStore } from "../../store/modelStore";
import { useReferencePointPick } from "./useFacePick";
import { buildFacePositions } from "./useMeshTopology";
import type { MeshTopology } from "./useMeshTopology";
import { FaceOverlay } from "./FaceOverlay";
import { SELECTION_COLOR } from "./bcOverlayShared";

// Couplings: emerald, matching the panel's coupling dot. A coupling still being
// placed gets its own blue rather than the pick session's orange or the
// committed emerald: it sits ON the orange picked surface, and when a point is
// being MOVED it has to be told apart from the committed spider still drawn at
// the old position — which is the whole comparison the edit is about.
const COUPLING_COLOR = "#059669";
const COUPLING_DRAFT_COLOR = "#2563eb";

interface CouplingOverlayProps {
  topology: MeshTopology;
  showResult: boolean;
}

export function CouplingOverlay({
  topology,
  showResult,
}: CouplingOverlayProps) {
  const selectedFace = useModelStore((s) => s.selectedFace);
  const pendingFaces = useModelStore((s) => s.pendingFaces);
  const couplingGroups = useModelStore((s) => s.couplingGroups);
  const couplingDraft = useModelStore((s) => s.couplingDraft);
  // Set only while a BC or load is being picked in point mode — see
  // useReferencePointPick. When it is, the markers are click targets and are
  // drawn larger to say so.
  const pickReferencePoint = useReferencePointPick();
  // Nodes in the live pick session, so a selected reference point is shown
  // selected rather than the user having to read it off the panel.
  const pickedNodeIds = useMemo(() => {
    const ids = new Set<number>();
    for (const face of pendingFaces) for (const id of face.nodeIds) ids.add(id);
    if (selectedFace) for (const id of selectedFace.nodeIds) ids.add(id);
    return ids;
  }, [pendingFaces, selectedFace]);

  const { nodeMap, modelSize, boundaryMeshTopo } = topology;

  // Coupling surface highlights — the surface each coupling grips.
  const couplingFaceHighlights = useMemo(() => {
    if (!boundaryMeshTopo) return null;
    const highlights: { key: string; positions: Float32Array }[] = [];
    for (const group of couplingGroups)
      group.faces.forEach((face, i) => {
        const positions = buildFacePositions(
          face.nodeIds,
          boundaryMeshTopo.triangles,
          nodeMap,
        );
        if (positions)
          highlights.push({ key: `coupling-${group.id}-${i}`, positions });
      });
    return highlights;
  }, [couplingGroups, boundaryMeshTopo, nodeMap]);

  // Coupling spiders — a line from every gripped node to its reference point,
  // plus a marker at the point. This is the constraint's actual reach: which
  // nodes the point governs (kinematic) or averages (distributing), rather than
  // just the surface it was declared on. The reference point is a node of the
  // model, so its position comes from the same nodeMap as everything else.
  const couplingSpiders = useMemo(() => {
    const spiders: {
      id: number;
      refNodeId: number;
      positions: Float32Array;
      point: [number, number, number];
    }[] = [];
    for (const group of couplingGroups) {
      const ref = nodeMap.get(group.refNodeId);
      if (!ref) continue;
      const gripped = new Set(group.faces.flatMap((face) => face.nodeIds));
      gripped.delete(group.refNodeId);
      const positions = new Float32Array(6 * gripped.size);
      let written = 0;
      for (const nodeId of gripped) {
        const node = nodeMap.get(nodeId);
        if (!node) continue;
        positions.set(
          [ref.n.x, ref.n.y, ref.n.z, node.n.x, node.n.y, node.n.z],
          6 * written,
        );
        written++;
      }
      spiders.push({
        id: group.id,
        refNodeId: group.refNodeId,
        positions: positions.subarray(0, 6 * written),
        point: [ref.n.x, ref.n.y, ref.n.z],
      });
    }
    return spiders;
  }, [couplingGroups, nodeMap]);

  // The coupling being placed: the same spider, at the position the form
  // currently holds. Drawn from `couplingDraft` rather than re-derived here, so
  // the marker is exactly where the coordinates say and cannot drift from them.
  const draftSpider = useMemo(() => {
    if (!couplingDraft) return null;
    const positions = new Float32Array(6 * couplingDraft.nodeIds.length);
    let written = 0;
    for (const nodeId of new Set(couplingDraft.nodeIds)) {
      const node = nodeMap.get(nodeId);
      if (!node) continue;
      positions.set(
        [...couplingDraft.point, node.n.x, node.n.y, node.n.z],
        6 * written,
      );
      written++;
    }
    return { positions: positions.subarray(0, 6 * written) };
  }, [couplingDraft, nodeMap]);

  if (showResult) return null;
  return (
    <>
      {/* Coupling surface highlights — the surface each coupling grips */}
      {couplingFaceHighlights?.map((highlight) => (
        <FaceOverlay
          key={highlight.key}
          positions={highlight.positions}
          color={COUPLING_COLOR}
          opacity={0.3}
          renderOrder={1}
        />
      ))}

      {/* Coupling spiders — a line from the reference point to every node it
          couples, and a sphere at the point itself */}
      {couplingSpiders.map((spider) => (
        <group key={`coupling-spider-${spider.id}`}>
          {spider.positions.length > 0 && (
            <lineSegments
              // skipcq: JS-0455 -- typed React Three Fiber property
              renderOrder={4}
            >
              <bufferGeometry>
                <bufferAttribute
                  // skipcq: JS-0455 -- typed React Three Fiber property
                  attach="attributes-position"
                  // skipcq: JS-0455 -- typed React Three Fiber property
                  args={[spider.positions, 3]}
                />
              </bufferGeometry>
              <lineBasicMaterial
                color={COUPLING_COLOR}
                // skipcq: JS-0455 -- typed React Three Fiber property
                depthTest={false}
              />
            </lineSegments>
          )}
          {/* `transparent` with full opacity, not a translucency: three.js
              draws the opaque pass before the transparent one, so an opaque
              marker is painted UNDER the surface highlights however high its
              renderOrder. Joining the transparent pass is what lets the order
              put the point on top of the surface it belongs to. */}
          <mesh
            // skipcq: JS-0455 -- typed React Three Fiber property
            position={spider.point}
            // skipcq: JS-0455 -- typed React Three Fiber property
            renderOrder={5}
            onClick={
              pickReferencePoint &&
              ((event) => {
                event.stopPropagation();
                pickReferencePoint(spider.refNodeId);
              })
            }
          >
            <sphereGeometry
              // skipcq: JS-0455 -- typed React Three Fiber property
              args={[modelSize * (pickReferencePoint ? 0.03 : 0.018), 12, 10]}
            />
            <meshBasicMaterial
              color={
                pickedNodeIds.has(spider.refNodeId)
                  ? SELECTION_COLOR
                  : COUPLING_COLOR
              }
              // skipcq: JS-0455 -- typed React Three Fiber property
              depthTest={false}
              // skipcq: JS-0455 -- typed React Three Fiber property
              transparent
              opacity={1}
            />
          </mesh>
        </group>
      ))}

      {/* The coupling being placed — its point and the nodes it would grip,
          so the position can be judged against the model before it is applied */}
      {couplingDraft && draftSpider && (
        <group>
          {draftSpider.positions.length > 0 && (
            <lineSegments
              // skipcq: JS-0455 -- typed React Three Fiber property
              renderOrder={5}
            >
              <bufferGeometry>
                <bufferAttribute
                  // skipcq: JS-0455 -- typed React Three Fiber property
                  attach="attributes-position"
                  // skipcq: JS-0455 -- typed React Three Fiber property
                  args={[draftSpider.positions, 3]}
                />
              </bufferGeometry>
              <lineBasicMaterial
                color={COUPLING_DRAFT_COLOR}
                // skipcq: JS-0455 -- typed React Three Fiber property
                depthTest={false}
                // skipcq: JS-0455 -- typed React Three Fiber property
                transparent
                opacity={1}
              />
            </lineSegments>
          )}
          <mesh
            // skipcq: JS-0455 -- typed React Three Fiber property
            position={couplingDraft.point}
            // skipcq: JS-0455 -- typed React Three Fiber property
            renderOrder={6}
          >
            <sphereGeometry
              // skipcq: JS-0455 -- typed React Three Fiber property
              args={[modelSize * 0.022, 16, 12]}
            />
            <meshBasicMaterial
              color={COUPLING_DRAFT_COLOR}
              // skipcq: JS-0455 -- typed React Three Fiber property
              depthTest={false}
              // skipcq: JS-0455 -- typed React Three Fiber property
              transparent
              opacity={1}
            />
          </mesh>
        </group>
      )}
    </>
  );
}
