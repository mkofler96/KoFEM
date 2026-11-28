// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { ThreeEvent } from "@react-three/fiber";
import { useModelStore } from "../../store/modelStore";
import {
  pickFaceNodeIds,
  pickEdgeNodeIds,
  pickEdgeSeed,
  pickPointNodeId,
  nearestReferencePoint,
  toggleFaceSelection,
  snapToAxis,
  SELECTION_NOUN,
} from "../../lib/facePick";
import { cadShellPick } from "../../lib/cadShell";
import type { BoundaryMeshTopo, Vec3 } from "../../lib/facePick";
import { rimEdgeKey, type ShellRim } from "../../lib/shellRim";

// Picking handler for the undeformed boundary surface: clicks are matched
// against undeformed node positions, so the deformed result surface never
// carries it (a pick session ends when the app leaves Supports & Loads,
// KOF-407). Returns undefined outside pick mode so the mesh carries no onClick
// at all.
//
// Face mode selects a surface region: when OCC face IDs are available (STEP mesh
// via Netgen) an instant face-ID lookup (topologically exact on any CAD face),
// otherwise a BFS flood-fill with normal-angle thresholds (parametric box mesh
// or .inp import). Edge mode selects the boundary polyline near the click — the
// only way to grab the rim of a flat shell, whose whole sheet is one region.
// Where the rim came from a CAD face the shell idealisation collapsed (a
// plate's side face, lib/shellRim), it selects that face's whole rim and
// remembers the face, so the selection survives a re-mesh like a face pick.
// Point mode selects the single nearest node of the clicked facet.
export function useFacePick(
  boundaryMeshTopo: BoundaryMeshTopo | null,
  getPos: (id: number) => Vec3,
  shellRim: ShellRim,
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
    // The collapsed CAD face behind the rim edge an edge pick starts from.
    let rimFace: number | undefined;
    if (pickGeometry === "edge") {
      const seed = pickEdgeSeed(clickPoint, startIdx, boundaryMeshTopo, getPos);
      if (seed) rimFace = shellRim.faceOfEdge.get(rimEdgeKey(...seed));
    }
    const rimNodes =
      rimFace !== undefined ? shellRim.nodesByFace.get(rimFace) : undefined;
    const picked =
      pickGeometry === "edge"
        ? rimNodes
          ? new Set(rimNodes)
          : pickEdgeNodeIds(clickPoint, startIdx, boundaryMeshTopo, getPos)
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
    const { axis, isMax } = snapToAxis(e.face.normal);

    // Current selection = accumulated pending faces plus the active one.
    // Re-selecting an already-picked face toggles it off instead of adding a
    // duplicate (#264).
    const current = selectedFace
      ? [...pendingFaces, selectedFace]
      : pendingFaces;
    // A face pick on a triangle with a CAD face behind it selected that whole
    // face (pickFaceNodeIds' CAD face ID mode), and an edge pick on a
    // collapsed face's rim that face's whole rim: remember which, so the entry
    // can be re-resolved on a new mesh.
    const cadFaceId =
      pickGeometry === "face"
        ? boundaryMeshTopo.faceIds?.[startIdx]
        : pickGeometry === "edge" && rimNodes
          ? rimFace
          : undefined;
    const next = toggleFaceSelection(
      current,
      {
        nodeIds: faceNodeIds,
        axis,
        isMax,
        label: "",
        ...(cadFaceId !== undefined ? { cadFaceId } : {}),
      },
      SELECTION_NOUN[pickGeometry],
      // A flood-fill face pick toggles off a selection containing the clicked
      // triangle, even when this seed grew a different region (KOF-211).
      pickGeometry === "face" && cadFaceId === undefined
        ? boundaryMeshTopo.triangles[startIdx]
        : undefined,
    );

    // Re-split into pending faces + the active (last) selection.
    setPendingFaces(next.slice(0, -1));
    setSelectedFace(next.length > 0 ? next[next.length - 1] : null);
  }

  return pickMode ? handleFacePick : undefined;
}

// Picking handler for the CAD faces of a Shell body on the CAD mid-surface
// path (KOF-498), drawn transparent over its mid-surface. The CAD geometry is
// the ground truth: a click selects the whole CAD face under the cursor, and
// the face's links say which nodes it is. Face mode takes a top or bottom
// face (its facets), Edge mode a side face (the rim it collapsed to). A click
// on a face of the other kind is left alone, so it reaches the mesh behind.
// Point mode picks mesh nodes only, so it has no handler here.
export function useCadFacePick():
  ((cadFaceId: number, e: ThreeEvent<MouseEvent>) => void) | undefined {
  const pickMode = useModelStore((s) => s.pickMode);
  const pickGeometry = useModelStore((s) => s.pickGeometry);
  const links = useModelStore((s) => s.midSurfaceLinks);
  const elements = useModelStore((s) => s.elements);
  const selectedFace = useModelStore((s) => s.selectedFace);
  const pendingFaces = useModelStore((s) => s.pendingFaces);
  const setSelectedFace = useModelStore((s) => s.setSelectedFace);
  const setPendingFaces = useModelStore((s) => s.setPendingFaces);
  if (!pickMode || !links || pickGeometry === "point") return undefined;

  return (cadFaceId, e) => {
    const pick = cadShellPick(links, elements, cadFaceId);
    if (pick?.geometry !== pickGeometry || !e.face) return;
    e.stopPropagation();
    const current = selectedFace
      ? [...pendingFaces, selectedFace]
      : pendingFaces;
    const next = toggleFaceSelection(
      current,
      {
        nodeIds: pick.nodeIds,
        ...snapToAxis(e.face.normal),
        label: "",
        cadFaceId,
      },
      SELECTION_NOUN[pickGeometry],
    );
    setPendingFaces(next.slice(0, -1));
    setSelectedFace(next.length > 0 ? next[next.length - 1] : null);
  };
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
