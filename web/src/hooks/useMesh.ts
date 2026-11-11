// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useMemo, useState } from "react";
import { useModelStore } from "../store/modelStore";
import type { Node, Element, Property } from "../store/modelStore";
import type { MeshOverlap } from "../wasm/pkg/kofem_wasm";
import { isCadBody } from "../store/geometrySlice";
import { sendToWorker, resetWorker } from "../workers/sharedWorker";
import { useWorkerLogs } from "./useWorkerLogs";
import { measureTessellation } from "../lib/meshSizing";
import {
  categorizeError,
  currentWorkflow,
  modelType,
  startTimer,
  track,
  type DurationBucket,
  type ErrorCategory,
  type ModelType,
} from "../lib/analytics";

// Volume meshing: the meshing-in-flight and log state, and the worker's
// volume_mesh protocol (including the mandatory worker reset after Netgen
// runs). The element sizes live in the store, so the settings survive leaving
// the Mesh entry and can be compared with the sizes of the current mesh.
export function useMesh() {
  const stepSurface = useModelStore((s) => s.stepSurface);
  const stepBytes = useModelStore((s) => s.stepBytes);
  const geometryFormat = useModelStore((s) => s.geometryFormat);
  const isMeshing = useModelStore((s) => s.isMeshing);
  const setMeshing = useModelStore((s) => s.setMeshing);
  const setMeshOverlaps = useModelStore((s) => s.setMeshOverlaps);
  const applyMeshResult = useModelStore((s) => s.applyMeshResult);
  const properties = useModelStore((s) => s.properties);
  const elementOrder = useModelStore((s) => s.elementOrder);
  const setElementOrder = useModelStore((s) => s.setElementOrder);

  // Typed text (see GeometrySlice.maxElementSize), validated when meshing
  // starts. The min size floors curvature-driven refinement; 0 lets Netgen
  // refine fillets without limit, which can produce >10x more elements than the
  // max size suggests.
  const maxElementSize = useModelStore((s) => s.maxElementSize);
  const setMaxElementSize = useModelStore((s) => s.setMaxElementSize);
  const minElementSize = useModelStore((s) => s.minElementSize);
  const setMinElementSize = useModelStore((s) => s.setMinElementSize);
  const [meshError, setMeshError] = useState<string | null>(null);
  const { logs, clearLogs } = useWorkerLogs("mesh");

  // Size of the imported geometry, for the extent and element-count estimate.
  // stepSurface is replaced wholesale when the geometry changes.
  const geometryMeasure = useMemo(
    () =>
      stepSurface
        ? measureTessellation(stepSurface.points, stepSurface.triangles)
        : null,
    [stepSurface],
  );

  // What the user asked to mesh; the result's element types say the same once
  // there is a result.
  const shellBodies = properties.filter(
    (p) => isCadBody(p) && p.discretization === "shell" && !p.suppressed,
  ).length;
  const activeBodies = properties.filter(
    (p) => isCadBody(p) && !p.suppressed,
  ).length;
  const requestedModelType: ModelType =
    shellBodies === 0
      ? "solid"
      : shellBodies === activeBodies
        ? "shell"
        : "mixed";

  function rejectInput(message: string) {
    setMeshError(message);
    trackMeshFailed("invalid_input", "lt_1s");
  }
  function trackMeshFailed(
    error_category: ErrorCategory,
    duration_bucket: DurationBucket,
  ) {
    track("mesh_failed", {
      workflow: currentWorkflow(),
      model_type: requestedModelType,
      duration_bucket,
      error_category,
    });
  }

  async function meshVolume() {
    if (!stepSurface) return;
    if (!stepBytes) {
      rejectInput(
        "Cannot mesh: the original STEP file is no longer available (e.g. after loading a saved analysis). Re-import the STEP file to mesh.",
      );
      return;
    }

    const maxSize = parseFloat(maxElementSize);
    const minSize = parseFloat(minElementSize);
    if (!Number.isFinite(maxSize) || maxSize <= 0) {
      rejectInput(
        `Max element size must be a positive number of mm — got "${maxElementSize}".`,
      );
      return;
    }
    if (!Number.isFinite(minSize) || minSize < 0) {
      rejectInput(
        `Min element size must be 0 or a positive number of mm — got "${minElementSize}".`,
      );
      return;
    }
    if (minSize > maxSize) {
      rejectInput(
        `Min element size (${minSize} mm) must not exceed max element size (${maxSize} mm).`,
      );
      return;
    }

    setMeshError(null);
    setMeshOverlaps([]);
    setMeshing(true);
    clearLogs();
    const elapsed = startTimer();
    // Captured at request time: the mesh records what it left out, even if the
    // user toggles a body while Netgen runs.
    const suppressedBodyIds = properties
      .filter((p) => isCadBody(p) && p.suppressed)
      .map((p) => p.id);
    try {
      const reply = await sendToWorker<
        | {
            nodes: Node[];
            elements: Element[];
            properties?: Property[];
            surfaceTriangles: [number, number, number][] | null;
            surfaceFaceIds: number[] | null;
          }
        | { overlaps: MeshOverlap[] }
      >("volume_mesh", {
        bytes: stepBytes,
        format: geometryFormat,
        maxElementSize: maxSize,
        minElementSize: minSize,
        // Bodies the user marked Shell, plus the property table: meshing
        // idealises them to a mid-surface
        // shell mesh and returns the mixed CTRIA3 + CTETRA model (#397). Only CAD
        // bodies can be idealised — the PSHELLs a previous mesh derived are
        // shells already, and passing their ids would send the thin-wall
        // extraction hunting for bodies the fresh mesh has never heard of.
        shellBodyIds: properties
          .filter(
            (p) =>
              isCadBody(p) && p.discretization === "shell" && !p.suppressed,
          )
          .map((p) => p.id),
        suppressedBodyIds,
        properties,
      });
      // Same reason for the reset as after a mesh, below.
      if ("overlaps" in reply) {
        resetWorker();
        setMeshOverlaps(reply.overlaps);
        trackMeshFailed("geometry_defect", elapsed());
        return;
      }
      const {
        nodes: meshNodes,
        elements: meshElements,
        properties: meshProperties,
        surfaceTriangles,
        surfaceFaceIds,
      } = reply;
      applyMeshResult(
        meshNodes,
        meshElements,
        "STEP Volume Mesh",
        { max: maxSize, min: minSize },
        surfaceTriangles,
        surfaceFaceIds,
        meshProperties,
        suppressedBodyIds,
      );
      track("mesh_completed", {
        workflow: currentWorkflow(),
        model_type: modelType(meshElements),
        duration_bucket: elapsed(),
      });
      // Netgen's Ng_Init() installs global C++ state that contaminates the WASM
      // runtime for subsequent MFEM solves.  Resetting the worker here gives the
      // solve a clean module instance, preventing an infinite loop on first call.
      resetWorker();
    } catch (err) {
      console.error("[meshing] volume mesh failed:", err);
      const detail = err instanceof Error ? err.message : String(err);
      setMeshError(`Volume meshing failed: ${detail}`);
      trackMeshFailed(categorizeError(err), elapsed());
    } finally {
      setMeshing(false);
    }
  }

  return {
    stepSurface,
    isMeshing,
    elementOrder,
    setElementOrder,
    maxElementSize,
    setMaxElementSize,
    minElementSize,
    setMinElementSize,
    geometryMeasure,
    meshError,
    setMeshError,
    logs,
    meshVolume,
  };
}
