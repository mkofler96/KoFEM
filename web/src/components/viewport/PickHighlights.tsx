// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// The live pick session: the faces accumulated with shift-click (pending) and
// the latest picked face (selected). Shown in results mode too, unlike the
// committed BC/load overlays.

import { useMemo } from "react";
import { useModelStore } from "../../store/modelStore";
import { buildFacePositions } from "./useMeshTopology";
import type { MeshTopology } from "./useMeshTopology";
import { FaceOverlay } from "./FaceOverlay";
import { SELECTION_COLOR } from "./bcOverlayShared";

interface PickHighlightsProps {
  topology: MeshTopology;
}

export function PickHighlights({ topology }: PickHighlightsProps) {
  const selectedFace = useModelStore((s) => s.selectedFace);
  const pendingFaces = useModelStore((s) => s.pendingFaces);
  const { nodeMap, boundaryMeshTopo } = topology;

  // Selected face highlight — the current (latest) picked face in the active pick session.
  const selectedFacePositions = useMemo(() => {
    if (!selectedFace || !boundaryMeshTopo) return null;
    return buildFacePositions(
      selectedFace.nodeIds,
      boundaryMeshTopo.triangles,
      nodeMap,
    );
  }, [selectedFace, boundaryMeshTopo, nodeMap]);

  // Pending faces — accumulated via shift-click during this pick session.
  const pendingFacePositions = useMemo(() => {
    if (pendingFaces.length === 0 || !boundaryMeshTopo) return null;
    const allNodeIds = pendingFaces.flatMap((f) => f.nodeIds);
    return buildFacePositions(allNodeIds, boundaryMeshTopo.triangles, nodeMap);
  }, [pendingFaces, boundaryMeshTopo, nodeMap]);

  return (
    <>
      {/* Pending faces — accumulated via shift-click, same colour as selection but slightly dimmer */}
      {pendingFacePositions && (
        <FaceOverlay
          positions={pendingFacePositions}
          color={SELECTION_COLOR}
          opacity={0.45}
          renderOrder={2}
        />
      )}

      {/* Selected face highlight — the latest picked face (brightest) */}
      {selectedFacePositions && (
        <FaceOverlay
          positions={selectedFacePositions}
          color={SELECTION_COLOR}
          opacity={0.65}
          renderOrder={3}
        />
      )}
    </>
  );
}
