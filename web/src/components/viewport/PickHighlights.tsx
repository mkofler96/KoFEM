// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// The live pick session: the faces accumulated with shift-click (pending) and
// the latest picked face (selected). Shown in results mode too, unlike the
// committed BC/load overlays. An edge pick is drawn as a line along the rim it
// selected, since its nodes span no triangle for the face overlay to fill.

import { useMemo } from "react";
import { useModelStore } from "../../store/modelStore";
import { buildEdgePositions, buildFacePositions } from "./useMeshTopology";
import type { MeshTopology } from "./useMeshTopology";
import { FaceOverlay } from "./FaceOverlay";
import { EdgeOverlay } from "./EdgeOverlay";
import { SELECTION_COLOR } from "./bcOverlayShared";

interface PickHighlightsProps {
  topology: MeshTopology;
}

export function PickHighlights({ topology }: PickHighlightsProps) {
  const selectedFace = useModelStore((s) => s.selectedFace);
  const pendingFaces = useModelStore((s) => s.pendingFaces);
  const pickGeometry = useModelStore((s) => s.pickGeometry);
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

  // Edge picks — every selection of the session shares its pick geometry.
  const selectedEdgePositions = useMemo(() => {
    if (pickGeometry !== "edge" || !selectedFace || !boundaryMeshTopo)
      return null;
    return buildEdgePositions(selectedFace.nodeIds, boundaryMeshTopo, nodeMap);
  }, [pickGeometry, selectedFace, boundaryMeshTopo, nodeMap]);

  const pendingEdgePositions = useMemo(() => {
    if (
      pickGeometry !== "edge" ||
      pendingFaces.length === 0 ||
      !boundaryMeshTopo
    )
      return null;
    return buildEdgePositions(
      pendingFaces.flatMap((f) => f.nodeIds),
      boundaryMeshTopo,
      nodeMap,
    );
  }, [pickGeometry, pendingFaces, boundaryMeshTopo, nodeMap]);

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

      {pendingEdgePositions && (
        <EdgeOverlay
          name="pick-edge-highlight"
          points={pendingEdgePositions}
          color={SELECTION_COLOR}
          opacity={0.55}
          renderOrder={2}
        />
      )}

      {selectedEdgePositions && (
        <EdgeOverlay
          name="pick-edge-highlight"
          points={selectedEdgePositions}
          color={SELECTION_COLOR}
          opacity={0.75}
          renderOrder={3}
        />
      )}
    </>
  );
}
