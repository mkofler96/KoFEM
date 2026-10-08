// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useState } from "react";
import { useModelStore } from "../store/modelStore";
import type { SplitMode, StepTessellation } from "../store/modelStore";
import { resetWorker, sendToWorker } from "../workers/sharedWorker";

export type SplitAxis = "x" | "y" | "z";

const AXIS_NORMAL: Record<SplitAxis, [number, number, number]> = {
  x: [1, 0, 0],
  y: [0, 1, 0],
  z: [0, 0, 1],
};

// The cut as the engine takes it: an axis-aligned plane `axis = position`.
export function splitPlane(
  axis: SplitAxis,
  position: number,
): { origin: [number, number, number]; normal: [number, number, number] } {
  const normal = AXIS_NORMAL[axis];
  return {
    origin: [normal[0] * position, normal[1] * position, normal[2] * position],
    normal,
  };
}

// Geometry editing (the split tool): sends the current file and the cut to the
// worker's split_geometry and swaps the edited file in. Owns the in-flight flag
// and the error of the last attempt.
export function useGeometryEdit() {
  const stepBytes = useModelStore((s) => s.stepBytes);
  const geometryFormat = useModelStore((s) => s.geometryFormat);
  const thinRatio = useModelStore((s) => s.thinRatio);
  const applyGeometryEdit = useModelStore((s) => s.applyGeometryEdit);
  const undoGeometryEdit = useModelStore((s) => s.undoGeometryEdit);
  const setRunning = useModelStore((s) => s.setRunning);
  const [isSplitting, setIsSplitting] = useState(false);
  const [splitError, setSplitError] = useState<string | null>(null);

  async function split(
    mode: SplitMode,
    axis: SplitAxis,
    position: number,
    faceIds: number[],
  ): Promise<boolean> {
    if (!stepBytes) {
      setSplitError(
        "Cannot split: the geometry file is not available (a saved analysis carries none). Re-import the STEP file to edit its geometry.",
      );
      return false;
    }
    if (!Number.isFinite(position)) {
      setSplitError("The plane position must be a number of mm.");
      return false;
    }
    if (mode === "faces" && faceIds.length === 0) {
      setSplitError("Pick at least one face to split.");
      return false;
    }
    setSplitError(null);
    setIsSplitting(true);
    setRunning(true);
    try {
      const reply = await sendToWorker<
        Required<StepTessellation> & {
          bytes: Uint8Array;
          bodyCount: number;
          shellBodyIds: number[];
        }
      >("split_geometry", {
        bytes: stepBytes,
        format: geometryFormat,
        thinRatio,
        split: {
          mode,
          ...splitPlane(axis, position),
          ...(mode === "faces" ? { faceIds } : {}),
        },
      });
      applyGeometryEdit(
        reply.bytes,
        {
          points: reply.points,
          triangles: reply.triangles,
          bodyIds: reply.bodyIds,
          faceIds: reply.faceIds,
        },
        reply.bodyCount,
        reply.shellBodyIds,
      );
      return true;
    } catch (err) {
      // The engine's message names the face and the fix; the C++ exception type
      // the worker prefixes it with says nothing to the user.
      const message = err instanceof Error ? err.message : String(err);
      setSplitError(message.replace(/^std::\w+: /, ""));
      return false;
    } finally {
      setIsSplitting(false);
      setRunning(false);
    }
  }

  // Step back to the geometry before the last edit. The worker still holds the
  // edited shape and would mesh it — volume_mesh only reloads into a fresh
  // module — so replace the worker; the next mesh reloads the restored file.
  function undo() {
    setSplitError(null);
    undoGeometryEdit();
    resetWorker();
  }

  return { split, undo, isSplitting, splitError, setSplitError };
}
