// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useMemo, useState } from "react";
import { useModelStore } from "../store/modelStore";
import { isCadBody, type MeshSizes } from "../store/geometrySlice";
import {
  applyVolumeMesh,
  parseMeshSizes,
  runVolumeMesh,
} from "../lib/volumeMesh";
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
    if (!stepSurface) {
      rejectInput(
        "Cannot mesh: this model has no geometry to mesh on. Import a STEP file to mesh it.",
      );
      return;
    }
    if (!stepBytes) {
      rejectInput(
        "Cannot mesh: the original STEP file is no longer available (e.g. after loading a saved analysis). Re-import the STEP file to mesh.",
      );
      return;
    }

    let sizes: MeshSizes;
    try {
      sizes = parseMeshSizes(maxElementSize, minElementSize, properties);
    } catch (err) {
      rejectInput(err instanceof Error ? err.message : String(err));
      return;
    }

    setMeshError(null);
    setMeshOverlaps([]);
    setMeshing(true);
    clearLogs();
    const elapsed = startTimer();
    try {
      const reply = await runVolumeMesh({
        stepBytes,
        geometryFormat,
        properties,
        sizes,
      });
      if (reply.kind === "overlaps") {
        setMeshOverlaps(reply.overlaps);
        trackMeshFailed("geometry_defect", elapsed());
        return;
      }
      const { mesh } = reply;
      applyVolumeMesh(applyMeshResult, mesh, sizes);
      track("mesh_completed", {
        workflow: currentWorkflow(),
        model_type: modelType(mesh.elements),
        duration_bucket: elapsed(),
      });
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
