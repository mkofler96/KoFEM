// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { ThreeEvent } from "@react-three/fiber";
import { useModelStore } from "../../store/modelStore";
import {
  pickFaceNodeIds,
  pickEdgeNodeIds,
  pickPointNodeId,
  nearestReferencePoint,
  toggleFaceSelection,
  SELECTION_NOUN,
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
// Point mode selects the single nearest node of the clicked facet.
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
  const couplingGroups = useModelStore((s) => s.couplingGroups);

  function handleFacePick(e: ThreeEvent<MouseEvent>) {
    if (!pickMode || e.faceIndex == null || !boundaryMeshTopo) return;
    e.stopPropagation();

    const startIdx = e.faceIndex;
    if (startIdx >= boundaryMeshTopo.triangles.length) return;

    const clickPoint: Vec3 = [e.point.x, e.point.y, e.point.z];
    const picked =
      pickGeometry === "edge"
        ? pickEdgeNodeIds(clickPoint, startIdx, boundaryMeshTopo, getPos)
        : pickGeometry === "point"
          ? pickPointNodeId(clickPoint, startIdx, boundaryMeshTopo, getPos)
          : pickFaceNodeIds(startIdx, boundaryMeshTopo);
    let faceNodeIds = [...picked];
    if (faceNodeIds.length === 0) return;

    // In point mode a coupling's REFERENCE POINT competes with the mesh node.
    // It belongs to no surface, so the ray can only ever report the mesh behind
    // it — which on a marker drawn over the face it couples is always the mesh.
    // Whether the point or the node was meant is decided by which is nearer to
    // where the click landed, the same rule pickPointNodeId uses to choose
    // between the corners of a facet.
    if (pickGeometry === "point" && couplingGroups.length > 0) {
      const nearestNode = getPos(faceNodeIds[0]);
      const nodeDistSq =
        (clickPoint[0] - nearestNode[0]) ** 2 +
        (clickPoint[1] - nearestNode[1]) ** 2 +
        (clickPoint[2] - nearestNode[2]) ** 2;
      const nearestRef = nearestReferencePoint(
        clickPoint,
        couplingGroups.map((group) => ({
          nodeId: group.refNodeId,
          point: group.point,
        })),
      );
      if (nearestRef && nearestRef.distSq < nodeDistSq)
        faceNodeIds = [nearestRef.nodeId];
    }
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
      SELECTION_NOUN[pickGeometry],
    );

    // Re-split into pending faces + the active (last) selection.
    setPendingFaces(next.slice(0, -1));
    setSelectedFace(next.length > 0 ? next[next.length - 1] : null);
  }

  return pickMode ? handleFacePick : undefined;
}

// Picking handler for a coupling's REFERENCE POINT marker — the second of the
// two routes by which a reference point is selected.
//
// The first is the distance test inside handleFacePick above, which covers the
// usual case: the marker is drawn on or near the surface it couples, so the ray
// reports that surface and the point is chosen by being nearer to the click.
// This one covers the case that test cannot reach — a point placed clear of the
// model, where the ray hits nothing at all and no surface event is raised.
//
// Only in POINT mode: in face or edge mode the marker would sit in front of the
// surface being picked and swallow clicks meant for it. Returns undefined
// otherwise, so the marker carries no onClick at all and stays inert.
export function useReferencePointPick():
  ((nodeId: number) => void) | undefined {
  const pickMode = useModelStore((s) => s.pickMode);
  const pickGeometry = useModelStore((s) => s.pickGeometry);
  const selectedFace = useModelStore((s) => s.selectedFace);
  const pendingFaces = useModelStore((s) => s.pendingFaces);
  const setSelectedFace = useModelStore((s) => s.setSelectedFace);
  const setPendingFaces = useModelStore((s) => s.setPendingFaces);

  function pickReferencePoint(nodeId: number) {
    const current = selectedFace
      ? [...pendingFaces, selectedFace]
      : pendingFaces;
    // A reference point has no surface and so no normal; the axis/isMax fields
    // exist to snap a FACE pick to an extreme and mean nothing here.
    const next = toggleFaceSelection(
      current,
      { nodeIds: [nodeId], axis: "X", isMax: true, label: "" },
      SELECTION_NOUN.point,
    );
    setPendingFaces(next.slice(0, -1));
    setSelectedFace(next.length > 0 ? next[next.length - 1] : null);
  }

  return (pickMode === "bc" || pickMode === "load") && pickGeometry === "point"
    ? pickReferencePoint
    : undefined;
}
