// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Thin compositor for the viewport scene. Derives the shared mesh topology and
// deformation scale once, then mounts the rendering layers based on the active
// mode / representation:
//   GeometryLayer          — OCCT tessellation of the STEP shape (display only)
//   FemMeshLayer           — FEM boundary surface + edge wireframes (± deformed)
//   ResultsColormap        — result-field vertex colours on the deformed surface
//   BoundaryConditionLayer — BC/load face highlights, markers and load arrows

import { useMemo } from "react";
import { useModelStore } from "../../store/modelStore";
import { resolveHighlightedBody } from "../../lib/bodyHighlight";
import { useMeshTopology } from "./useMeshTopology";
import { useFacePick } from "./useFacePick";
import { GeometryLayer } from "./GeometryLayer";
import { FemMeshLayer } from "./FemMeshLayer";
import { ResultsColormap } from "./ResultsColormap";
import { BoundaryConditionLayer } from "./BoundaryConditionLayer";

const TARGET_DEFORM_FRACTION = 0.2;

export function MeshScene() {
  const nodes = useModelStore((s) => s.nodes);
  const result = useModelStore((s) => s.result);
  const mode = useModelStore((s) => s.mode);
  const stepSurface = useModelStore((s) => s.stepSurface);
  const deformScaleFactor = useModelStore((s) => s.deformScale);
  const viewRepr = useModelStore((s) => s.viewRepr);
  const highlightBodyId = useModelStore((s) => s.highlightBodyId);
  const properties = useModelStore((s) => s.properties);

  const topology = useMeshTopology();
  const { modelSize, nodeMap } = topology;

  // Node position lookup for edge picking (nearest-edge + polyline directions).
  const getPos = useMemo(
    () =>
      (id: number): [number, number, number] => {
        const n = nodeMap.get(id)?.n;
        if (!n)
          throw new Error(
            `Pick referenced node id ${id} missing from nodeMap — mesh/topology desync`,
          );
        return [n.x, n.y, n.z];
      },
    [nodeMap],
  );
  const onFacePick = useFacePick(topology.boundaryMeshTopo, getPos);

  // Automatic fit-to-view scale (max displacement → TARGET_DEFORM_FRACTION of the
  // model size) multiplied by the user-controlled deformScaleFactor. A factor of
  // 0 yields the undeformed shape coloured by the result field.
  const deformScale = useMemo(() => {
    if (!result) return 1;
    let maxDisp = 0;
    for (let i = 0; i < result.displacements.length; i++) {
      const mag = Math.abs(result.displacements[i]);
      if (mag > maxDisp) maxDisp = mag;
    }
    if (maxDisp < 1e-30) return deformScaleFactor;
    return ((TARGET_DEFORM_FRACTION * modelSize) / maxDisp) * deformScaleFactor;
  }, [result, modelSize, deformScaleFactor]);

  const hasStepTessellation = !!stepSurface && stepSurface.triangles.length > 0;
  if (nodes.length === 0 && !hasStepTessellation) {
    return null;
  }

  // Results are only displayed in the Results tab.  Navigating back to an
  // earlier step (e.g. Constraints) must show that step's visualization —
  // the undeformed mesh with BC/load overlays — not the deformed result,
  // even though the solved `result` is still held in the store.
  const showResult = !!result && mode === "results";

  // Hovering a row in the Bodies panel highlights that body, which only the
  // coloured CAD tessellation can show — the FEM surface is one neutral colour.
  // So a live highlight overrides the representation for as long as the pointer
  // rests on the row. The override is derived, never written to the store: the
  // user's chosen representation is still what the status bar shows and what
  // comes back the instant the highlight clears. A body the tessellation cannot
  // draw resolves to null and overrides nothing (issue: hovering a derived
  // PSHELL row dimmed every body and hid the mesh with it).
  const highlightBody = resolveHighlightedBody(
    highlightBodyId,
    properties,
    stepSurface,
  );
  const repr = highlightBody !== null && !showResult ? "geometry" : viewRepr;

  // The CAD tessellation stands in for the geometry representation (and is the
  // only thing to show before a mesh exists). It must never paint over a solved
  // result, so it is suppressed in results mode.
  const showStepSurface =
    !showResult && (repr === "geometry" || nodes.length === 0);

  return (
    <group>
      <FemMeshLayer
        topology={topology}
        repr={repr}
        deformScale={deformScale}
        showResult={showResult}
        onFacePick={onFacePick}
      />
      {showResult && (
        <ResultsColormap
          topology={topology}
          deformScale={deformScale}
          onFacePick={onFacePick}
        />
      )}
      <BoundaryConditionLayer topology={topology} showResult={showResult} />
      {showStepSurface && (
        <GeometryLayer
          wireframe={viewRepr === "wireframe"}
          highlightBodyId={highlightBody}
        />
      )}
    </group>
  );
}
