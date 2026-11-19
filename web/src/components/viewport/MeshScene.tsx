// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Thin compositor for the viewport scene. Derives the shared mesh topology and
// deformation scale once, then mounts the rendering layers based on the active
// mode / representation:
//   GeometryLayer          — OCCT tessellation of the STEP shape (display only)
//   FemMeshLayer           — FEM boundary surface + edge wireframes (± deformed)
//   ResultsColormap        — result-field vertex colours on the deformed surface
//   BoundaryConditionLayer — BC/load face highlights, markers and load arrows
//   SampleGuideTargets     — the faces the sample guide asks to pick
//   MeshOverlapLayer       — where the last mesh attempt found an overlap
//   ProbeLayer             — result probes: markers and value labels
//   FitCamera              — Fit view, framing the scene as drawn

import { useMemo } from "react";
import type { ThreeEvent } from "@react-three/fiber";
import { useModelStore } from "../../store/modelStore";
import { resolveHighlightedBody } from "../../lib/bodyHighlight";
import { isInterfaceActive } from "../../lib/interfaces";
import { useMeshTopology } from "./useMeshTopology";
import { useFacePick } from "./useFacePick";
import { GeometryLayer } from "./GeometryLayer";
import { FitCamera } from "./FitCamera";
import { FemMeshLayer } from "./FemMeshLayer";
import { ResultsColormap } from "./ResultsColormap";
import { DensityField } from "./DensityField";
import { BoundaryConditionLayer } from "./BoundaryConditionLayer";
import { SampleGuideTargets } from "./SampleGuideTargets";
import { MeshOverlapLayer } from "./MeshOverlapLayer";
import { useDisplayedDensity } from "./useDisplayedDensity";
import { ProbeLayer } from "./ProbeLayer";
import { undeformedPoint } from "../../lib/resultProbe";
import { useDeformFactor } from "../../hooks/useDeformFactor";

export function MeshScene() {
  const nodes = useModelStore((s) => s.nodes);
  const result = useModelStore((s) => s.result);
  const mode = useModelStore((s) => s.mode);
  const stepSurface = useModelStore((s) => s.stepSurface);
  const viewRepr = useModelStore((s) => s.viewRepr);
  const highlightBodyId = useModelStore((s) => s.highlightBodyId);
  const properties = useModelStore((s) => s.properties);
  const probing = useModelStore((s) => s.probing);
  const addProbe = useModelStore((s) => s.addProbe);
  // The interface to show: the hovered row, else the one open in the panel —
  // unless one of its bodies is suppressed: its faces are then out of the
  // model, and drawing them would show geometry the analysis excludes.
  const highlightInterface = useModelStore((s) => {
    const sel = s.treeSelection.target;
    const id =
      s.highlightInterfaceId ??
      (sel.type === "item" && sel.kind === "interface" ? sel.id : null);
    if (id === null || !s.interfaces) return null;
    const found = s.interfaces.find((i) => i.id === id);
    return found === undefined || !isInterfaceActive(found, s.properties)
      ? null
      : found;
  });

  const density = useDisplayedDensity();
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
  const onFacePick = useFacePick(
    topology.boundaryMeshTopo,
    getPos,
    topology.shellRim,
  );

  // The factor the displacements are drawn at (KOF-383): the automatic one or
  // the user's, the same number the Results panel shows. 0 yields the
  // undeformed shape coloured by the result field.
  const deformScale = useDeformFactor().factor;

  // A click on the deformed result places a probe (KOF-389): at the point of
  // the undeformed triangle the click stands for, on that triangle's CAD face
  // when the mesh has one behind it, else on the triangle itself. The result
  // surface draws the pickable boundary triangles in the same order, so the
  // face index maps into them.
  const onProbePick = (e: ThreeEvent<MouseEvent>) => {
    const topo = topology.boundaryMeshTopo;
    if (!result || e.faceIndex == null || !topo) return;
    const tri = topo.triangles[e.faceIndex];
    if (!tri)
      throw new Error(
        `Probe pick hit triangle ${e.faceIndex} of a surface with ${topo.triangles.length}`,
      );
    e.stopPropagation();
    const disp = result.displacements;
    const corner = (id: number) => {
      const entry = nodeMap.get(id);
      if (!entry)
        throw new Error(
          `Probe pick referenced node id ${id} missing from nodeMap — mesh/topology desync`,
        );
      const { n, i } = entry;
      return {
        undeformed: [n.x, n.y, n.z] as [number, number, number],
        deformed: [
          n.x + disp[3 * i] * deformScale,
          n.y + disp[3 * i + 1] * deformScale,
          n.z + disp[3 * i + 2] * deformScale,
        ] as [number, number, number],
      };
    };
    const [a, b, c] = tri.map(corner);
    const point = undeformedPoint(
      [a.deformed, b.deformed, c.deformed],
      [a.undeformed, b.undeformed, c.undeformed],
      [e.point.x, e.point.y, e.point.z],
    );
    const cadFaceId = topo.faceIds?.[e.faceIndex];
    addProbe(
      point,
      cadFaceId !== undefined ? { cadFaceId } : { triangle: [...tri] },
    );
  };

  const hasStepTessellation = !!stepSurface && stepSurface.triangles.length > 0;
  if (nodes.length === 0 && !hasStepTessellation) {
    return null;
  }

  // A density field replaces the deformed static result: the final run when it
  // is the active result in Results (KOF-233), or the live iteration while an
  // optimization runs on the Optimize step (KOF-240).
  const showDensity = density !== null;

  // Results are only displayed in the Results tab.  Navigating back to an
  // earlier step (e.g. Constraints) must show that step's visualization —
  // the undeformed mesh with BC/load overlays — not the deformed result,
  // even though the solved `result` is still held in the store. A density run
  // takes precedence over a static result when it is the active one.
  const showResult = !!result && mode === "results" && !showDensity;

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
  const repr =
    (highlightBody !== null || highlightInterface !== null) && !showResult
      ? "geometry"
      : viewRepr;

  // The CAD tessellation stands in for the geometry representation (and is the
  // only thing to show before a mesh exists). It must never paint over a solved
  // result, so it is suppressed in results mode (static or density).
  const showStepSurface =
    !showResult && !showDensity && (repr === "geometry" || nodes.length === 0);

  // The density view stands alone: its own boundary surface replaces the neutral
  // FEM surface, the deformed colormap and the BC/load overlays, so the emerged
  // structure reads without the undeformed mesh drawn behind it.
  // Fit view frames the shape as drawn: the deformed result at deformScale.
  // First in both groups below, so switching views keeps it mounted.
  const fitCamera = (
    <FitCamera
      result={
        showResult
          ? { displacements: result.displacements, scale: deformScale }
          : null
      }
    />
  );

  if (density !== null) {
    return (
      <group>
        {fitCamera}
        <DensityField density={density} />
      </group>
    );
  }

  return (
    <group>
      {fitCamera}
      <FemMeshLayer
        topology={topology}
        repr={repr}
        deformScale={deformScale}
        showResult={showResult}
        onFacePick={onFacePick}
      />
      {/* The deformed surface only places probes: face picks match clicks
          against undeformed nodes and live on Supports & Loads (KOF-407). */}
      {showResult && (
        <ResultsColormap
          topology={topology}
          deformScale={deformScale}
          onFacePick={probing ? onProbePick : undefined}
        />
      )}
      {showResult && (
        <ProbeLayer deformScale={deformScale} modelSize={modelSize} />
      )}
      <BoundaryConditionLayer topology={topology} showResult={showResult} />
      {!showResult && repr !== "geometry" && (
        <SampleGuideTargets topology={topology} />
      )}
      {showStepSurface && (
        <GeometryLayer
          wireframe={viewRepr === "wireframe"}
          highlightBodyId={highlightBody}
          highlightInterface={highlightInterface}
        />
      )}
      <MeshOverlapLayer />
    </group>
  );
}
