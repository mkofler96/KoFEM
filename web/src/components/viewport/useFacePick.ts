// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { ThreeEvent } from "@react-three/fiber";
import { useModelStore } from "../../store/modelStore";
import {
  pickFaceNodeIds,
  pickEdgeNodeIds,
  toggleFaceSelection,
} from "../../lib/facePick";
import type { BoundaryMeshTopo, Vec3 } from "../../lib/facePick";

// Picking handler for the pickable boundary surfaces (undeformed solid and
// deformed result surface). Returns undefined outside pick mode so the meshes
// carry no onClick at all.
//
// Face mode selects a surface region: when OCC face IDs are available (STEP mesh
// via Netgen) an instant face-ID lookup (topologically exact on any CAD face),
// otherwise a BFS flood-fill with normal-angle thresholds (parametric box mesh
// or .inp import). Edge mode selects the boundary polyline near the click — the
// only way to grab the rim of a flat shell, whose whole sheet is one region.
export function useFacePick(
  boundaryMeshTopo: BoundaryMeshTopo | null,
  getPos: (id: number) => Vec3,
): ((e: ThreeEvent<MouseEvent>) => void) | undefined {
  const pickMode = useModelStore((s) => s.pickMode);
  const pickGeometry = useModelStore((s) => s.pickGeometry);
  const selectedFace = useModelStore((s) => s.selectedFace);
  const pendingFaces = useModelStore((s) => s.pendingFaces);
  const setSelectedFace = useModelStore((s) => s.setSelectedFace);
  const setPendingFaces = useModelStore((s) => s.setPendingFaces);

  function handleFacePick(e: ThreeEvent<MouseEvent>) {
    if (!pickMode || e.faceIndex == null || !boundaryMeshTopo) return;
    e.stopPropagation();

    const startIdx = e.faceIndex;
    if (startIdx >= boundaryMeshTopo.triangles.length) return;

    const faceNodeIds =
      pickGeometry === "edge"
        ? [
            ...pickEdgeNodeIds(
              [e.point.x, e.point.y, e.point.z],
              startIdx,
              boundaryMeshTopo,
              getPos,
            ),
          ]
        : [...pickFaceNodeIds(startIdx, boundaryMeshTopo)];
    if (faceNodeIds.length === 0) return;
    // The normal decides which axis/extreme the picked face is snapped to, and
    // that selection becomes solver input. Substituting +Y for a missing normal
    // would silently snap the pick to the wrong face — drop the pick instead.
    if (!e.face) return;
    const normal = e.face.normal.clone().normalize();
    const ax = Math.abs(normal.x),
      ay = Math.abs(normal.y),
      az = Math.abs(normal.z);
    let axis: "X" | "Y" | "Z";
    let isMax: boolean;
    if (ax >= ay && ax >= az) {
      axis = "X";
      isMax = normal.x > 0;
    } else if (ay >= ax && ay >= az) {
      axis = "Y";
      isMax = normal.y > 0;
    } else {
      axis = "Z";
      isMax = normal.z > 0;
    }

    // Current selection = accumulated pending faces plus the active one.
    // Re-selecting an already-picked face toggles it off instead of adding a
    // duplicate (#264).
    const current = selectedFace
      ? [...pendingFaces, selectedFace]
      : pendingFaces;
    const next = toggleFaceSelection(
      current,
      {
        nodeIds: faceNodeIds,
        axis,
        isMax,
        label: "",
      },
      pickGeometry === "edge" ? "Edge" : "Face",
    );

    // Re-split into pending faces + the active (last) selection.
    setPendingFaces(next.slice(0, -1));
    setSelectedFace(next.length > 0 ? next[next.length - 1] : null);
  }

  return pickMode ? handleFacePick : undefined;
}
