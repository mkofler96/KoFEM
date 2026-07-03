// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

import * as THREE from "three";
import type { ThreeEvent } from "@react-three/fiber";
import { useModelStore } from "../../store/modelStore";
import { pickFaceNodeIds, toggleFaceSelection } from "../../lib/facePick";
import type { BoundaryMeshTopo } from "../../lib/facePick";

// Face picking handler for the pickable boundary surfaces (undeformed solid
// and deformed result surface). Returns undefined outside pick mode so the
// meshes carry no onClick at all.
//
// When OCC face IDs are available (STEP mesh via Netgen), uses instant face ID
// lookup — topologically exact, works on any curved or flat CAD face.
// Falls back to BFS flood-fill with normal-angle thresholds when no face IDs
// are present (parametric box mesh or .inp import).
export function useFacePick(
  boundaryMeshTopo: BoundaryMeshTopo | null,
): ((e: ThreeEvent<MouseEvent>) => void) | undefined {
  const pickMode = useModelStore((s) => s.pickMode);
  const selectedFace = useModelStore((s) => s.selectedFace);
  const pendingFaces = useModelStore((s) => s.pendingFaces);
  const setSelectedFace = useModelStore((s) => s.setSelectedFace);
  const setPendingFaces = useModelStore((s) => s.setPendingFaces);

  function handleFacePick(e: ThreeEvent<MouseEvent>) {
    if (!pickMode || e.faceIndex == null || !boundaryMeshTopo) return;
    e.stopPropagation();

    const startIdx = e.faceIndex;
    if (startIdx >= boundaryMeshTopo.triangles.length) return;

    const faceNodeIds = [...pickFaceNodeIds(startIdx, boundaryMeshTopo)];
    const normal =
      e.face?.normal.clone().normalize() ?? new THREE.Vector3(0, 1, 0);
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
    const next = toggleFaceSelection(current, {
      nodeIds: faceNodeIds,
      axis,
      isMax,
      label: "",
    });

    // Re-split into pending faces + the active (last) selection.
    setPendingFaces(next.slice(0, -1));
    setSelectedFace(next.length > 0 ? next[next.length - 1] : null);
  }

  return pickMode ? handleFacePick : undefined;
}
