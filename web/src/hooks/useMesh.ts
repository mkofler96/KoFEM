// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useState } from "react";
import { useModelStore } from "../store/modelStore";
import type { Node, Element } from "../store/modelStore";
import { sendToWorker, resetWorker } from "../workers/sharedWorker";
import { useWorkerLogs } from "./useWorkerLogs";

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
  const elementOrder = useModelStore((s) => s.elementOrder);
  const setElementOrder = useModelStore((s) => s.setElementOrder);

  const [maxElementSize, setMaxElementSize] = useState(20);
  // Floor for curvature-driven refinement; 0 lets Netgen refine fillets without
  // limit, which can produce >10x more elements than the max size suggests.
  const [minElementSize, setMinElementSize] = useState(2);
  const [meshError, setMeshError] = useState<string | null>(null);
  const { logs, clearLogs } = useWorkerLogs();

  async function meshVolume() {
    if (!stepSurface) return;
    if (!stepBytes) {
      setMeshError(
        "Cannot mesh: the original STEP file is no longer available (e.g. after loading a saved analysis). Re-import the STEP file to mesh.",
      );
      return;
    }
    setMeshing(true);
    clearLogs();
    try {
      const {
        nodes: meshNodes,
        elements: meshElements,
        surfaceTriangles,
        surfaceFaceIds,
      } = await sendToWorker<{
        nodes: Node[];
        elements: Element[];
        surfaceTriangles: [number, number, number][] | null;
        surfaceFaceIds: number[] | null;
      }>("volume_mesh", {
        bytes: stepBytes,
        format: geometryFormat,
        maxElementSize,
        minElementSize,
      });
      applyMeshResult(
        meshNodes,
        meshElements,
        "STEP Volume Mesh",
        surfaceTriangles,
        surfaceFaceIds,
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
    meshError,
    setMeshError,
    logs,
    meshVolume,
  };
}
