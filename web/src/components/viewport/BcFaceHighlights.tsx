// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Committed BC and load face highlights: a persistent coloured overlay on every
// face of every BC group (red) and load group (amber). The group a pick session
// targets is drawn stronger.

import { useMemo } from "react";
import { useModelStore } from "../../store/modelStore";
import type { BcFaceEntry } from "../../store/modelStore";
import type { BoundaryMeshTopo } from "../../lib/facePick";
import { buildFacePositions } from "./useMeshTopology";
import type { MeshTopology, NodeMap } from "./useMeshTopology";
import { FaceOverlay } from "./FaceOverlay";

interface FaceHighlight {
  groupId: number;
  faceId: number;
  positions: Float32Array;
}

// One highlight per face across all groups; faces with no boundary triangles
// are skipped.
function groupFaceHighlights(
  groups: readonly { id: number; faces: readonly BcFaceEntry[] }[],
  boundaryMeshTopo: BoundaryMeshTopo | null,
  nodeMap: NodeMap,
): FaceHighlight[] | null {
  if (!boundaryMeshTopo) return null;
  return groups
    .flatMap((g) =>
      g.faces.map((f) => ({
        groupId: g.id,
        faceId: f.id,
        positions: buildFacePositions(
          f.nodeIds,
          boundaryMeshTopo.triangles,
          nodeMap,
        ),
      })),
    )
    .filter((h) => h.positions !== null) as FaceHighlight[];
}

interface BcFaceHighlightsProps {
  topology: MeshTopology;
  showResult: boolean;
}

export function BcFaceHighlights({
  topology,
  showResult,
}: BcFaceHighlightsProps) {
  const pickTargetGroupId = useModelStore((s) => s.pickTargetGroupId);
  const bcGroups = useModelStore((s) => s.bcGroups);
  const loadGroups = useModelStore((s) => s.loadGroups);
  const { boundaryMeshTopo, nodeMap } = topology;

  // BC face highlights — all committed faces across all BC groups.
  // When in pick mode targeting a specific group, that group is highlighted stronger.
  const bcFaceHighlights = useMemo(
    () => groupFaceHighlights(bcGroups, boundaryMeshTopo, nodeMap),
    [bcGroups, boundaryMeshTopo, nodeMap],
  );

  // Load face highlights — all committed faces across all load groups.
  const loadFaceHighlights = useMemo(
    () => groupFaceHighlights(loadGroups, boundaryMeshTopo, nodeMap),
    [loadGroups, boundaryMeshTopo, nodeMap],
  );

  if (showResult) return null;
  return (
    <>
      {/* BC face highlights — persistent coloured overlay for all committed BC faces */}
      {bcFaceHighlights?.map((h) => (
        <FaceOverlay
          key={`bc-face-${h.groupId}-${h.faceId}`}
          positions={h.positions}
          color="#dc2626"
          opacity={pickTargetGroupId === h.groupId ? 0.45 : 0.25}
          renderOrder={1}
        />
      ))}

      {/* Load face highlights — persistent coloured overlay for all committed load faces */}
      {loadFaceHighlights?.map((h) => (
        <FaceOverlay
          key={`load-face-${h.groupId}-${h.faceId}`}
          positions={h.positions}
          color="#d97706"
          opacity={pickTargetGroupId === h.groupId ? 0.45 : 0.25}
          renderOrder={1}
        />
      ))}
    </>
  );
}
