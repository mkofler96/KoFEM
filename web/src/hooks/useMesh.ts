// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useEffect, useMemo, useState } from "react";
import { useModelStore } from "../store/modelStore";
import type { Node, Element, Property } from "../store/modelStore";
import { isCadBody } from "../store/geometrySlice";
import { sendToWorker, resetWorker } from "../workers/sharedWorker";
import { useWorkerLogs } from "./useWorkerLogs";
import { suggestElementSizes } from "../lib/meshSizing";

// Sizes shown before any geometry is imported. The mesh controls only render
// once a part is loaded, at which point the import's own suggestion (sized to
// TARGET_ELEMENT_COUNT, see lib/meshSizing) replaces both.
export const DEFAULT_MAX_ELEMENT_SIZE = 20;
export const DEFAULT_MIN_ELEMENT_SIZE = 2;

// Volume meshing: owns the mesh sizing parameters, the meshing-in-flight and
// log state, and the worker's volume_mesh protocol (including the mandatory
// worker reset after Netgen runs).
export function useMesh() {
  const stepSurface = useModelStore((s) => s.stepSurface);
  const stepBytes = useModelStore((s) => s.stepBytes);
  const geometryFormat = useModelStore((s) => s.geometryFormat);
  const isMeshing = useModelStore((s) => s.isMeshing);
  const setMeshing = useModelStore((s) => s.setMeshing);
  const applyMeshResult = useModelStore((s) => s.applyMeshResult);
  const properties = useModelStore((s) => s.properties);
  const elementOrder = useModelStore((s) => s.elementOrder);
  const setElementOrder = useModelStore((s) => s.setElementOrder);

  // Both sizes are held as text, not numbers: a 1 mm part needs 0.1 mm elements
  // and a 2 m weldment needs 80 mm ones, so there is no meaningful range to clamp
  // typing to (KOF-222). They are parsed and validated when meshing starts.
  const [maxElementSize, setMaxElementSize] = useState(
    String(DEFAULT_MAX_ELEMENT_SIZE),
  );
  // Floor for curvature-driven refinement; 0 lets Netgen refine fillets without
  // limit, which can produce >10x more elements than the max size suggests.
  const [minElementSize, setMinElementSize] = useState(
    String(DEFAULT_MIN_ELEMENT_SIZE),
  );
  const [meshError, setMeshError] = useState<string | null>(null);
  const { logs, clearLogs } = useWorkerLogs("mesh");

  // Element sizes suggested by the imported geometry itself, aimed at
  // TARGET_ELEMENT_COUNT elements. Recomputed per import — stepSurface is
  // replaced wholesale when a part is loaded — and applied by the effect below.
  const suggestion = useMemo(
    () =>
      stepSurface
        ? suggestElementSizes(stepSurface.points, stepSurface.triangles)
        : null,
    [stepSurface],
  );

  // A new import re-sizes both fields: a 1 mm cube and a 2 m weldment need
  // element sizes three orders of magnitude apart, so carrying the previous
  // part's numbers over (or a fixed 20 mm) is never right (KOF-222). Typed
  // values survive until the next import — this runs on stepSurface identity,
  // which only changes when geometry is loaded.
  useEffect(() => {
    if (!suggestion) return;
    setMaxElementSize(suggestion.max);
    setMinElementSize(suggestion.min);
  }, [suggestion]);

  async function meshVolume() {
    if (!stepSurface) return;
    if (!stepBytes) {
      setMeshError(
        "Cannot mesh: the original STEP file is no longer available (e.g. after loading a saved analysis). Re-import the STEP file to mesh.",
      );
      return;
    }

    const maxSize = parseFloat(maxElementSize);
    const minSize = parseFloat(minElementSize);
    if (!Number.isFinite(maxSize) || maxSize <= 0) {
      setMeshError(
        `Max element size must be a positive number of mm — got "${maxElementSize}".`,
      );
      return;
    }
    if (!Number.isFinite(minSize) || minSize < 0) {
      setMeshError(
        `Min element size must be 0 or a positive number of mm — got "${minElementSize}".`,
      );
      return;
    }
    if (minSize > maxSize) {
      setMeshError(
        `Min element size (${minSize} mm) must not exceed max element size (${maxSize} mm).`,
      );
      return;
    }

    setMeshError(null);
    setMeshing(true);
    clearLogs();
    try {
      const {
        nodes: meshNodes,
        elements: meshElements,
        properties: meshProperties,
        surfaceTriangles,
        surfaceFaceIds,
      } = await sendToWorker<{
        nodes: Node[];
        elements: Element[];
        properties?: Property[];
        surfaceTriangles: [number, number, number][] | null;
        surfaceFaceIds: number[] | null;
      }>("volume_mesh", {
        bytes: stepBytes,
        format: geometryFormat,
        maxElementSize: maxSize,
        minElementSize: minSize,
        // Bodies the user (or detectShellBodies at import) marked Shell, plus the
        // property table: meshing idealises their thin walls to a mid-surface
        // shell mesh and returns the mixed CTRIA3 + CTETRA model (#397). Only CAD
        // bodies can be idealised — the PSHELLs a previous mesh derived are
        // shells already, and passing their ids would send the thin-wall
        // extraction hunting for bodies the fresh mesh has never heard of.
        shellBodyIds: properties
          .filter((p) => isCadBody(p) && p.discretization === "shell")
          .map((p) => p.id),
        properties,
      });
      applyMeshResult(
        meshNodes,
        meshElements,
        "STEP Volume Mesh",
        surfaceTriangles,
        surfaceFaceIds,
        meshProperties,
      );
      // Netgen's Ng_Init() installs global C++ state that contaminates the WASM
      // runtime for subsequent MFEM solves.  Resetting the worker here gives the
      // solve a clean module instance, preventing an infinite loop on first call.
      resetWorker();
    } catch (err) {
      console.error("[meshing] volume mesh failed:", err);
      const detail = err instanceof Error ? err.message : String(err);
      setMeshError(`Volume meshing failed: ${detail}`);
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
    geometryMeasure: suggestion?.measure ?? null,
    meshError,
    setMeshError,
    logs,
    meshVolume,
  };
}
