// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useState } from "react";
import { useModelStore } from "../store/modelStore";
import type { SplitMode, StepTessellation } from "../store/modelStore";
import { resetWorker, sendToWorker } from "../workers/sharedWorker";
import { isCadBody } from "../store/geometrySlice";
import { booleanBodySources } from "../lib/booleanBodies";
import type { RepairHingesOptions } from "../wasm/pkg/kofem_wasm";

export type SplitAxis = "x" | "y" | "z";

export type BooleanOp = "union" | "subtract" | "intersect";

type EditReply = Required<StepTessellation> & {
  bytes: Uint8Array;
  bodyCount: number;
};

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

// Geometry editing (the split tool, Booleans): sends the current file and the
// edit to the worker and swaps the edited file in. Owns the in-flight flag; the
// error of the last attempt is store state (splitError), so it outlives the
// panel that started the edit.
export function useGeometryEdit() {
  const stepBytes = useModelStore((s) => s.stepBytes);
  const geometryFormat = useModelStore((s) => s.geometryFormat);
  const properties = useModelStore((s) => s.properties);
  const applyGeometryEdit = useModelStore((s) => s.applyGeometryEdit);
  const undoGeometryEdit = useModelStore((s) => s.undoGeometryEdit);
  const setRunning = useModelStore((s) => s.setRunning);
  const splitError = useModelStore((s) => s.splitError);
  const setSplitError = useModelStore((s) => s.setSplitError);
  const [isSplitting, setIsSplitting] = useState(false);

  async function split(
    mode: SplitMode,
    axis: SplitAxis,
    position: number,
    faceIds: number[],
    // Bodies mode: the bodies to cut; empty cuts every body the plane crosses.
    bodyIds: number[] = [],
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
    return run("split_geometry", {
      split: {
        mode,
        ...splitPlane(axis, position),
        ...(mode === "faces" ? { faceIds } : {}),
        ...(mode === "bodies" && bodyIds.length > 0 ? { bodyIds } : {}),
      },
    });
  }

  // Combine `target` with `tools`; the result replaces the target body.
  async function combine(
    op: BooleanOp,
    target: number,
    tools: number[],
    keepTools: boolean,
  ): Promise<boolean> {
    if (!stepBytes) {
      setSplitError(
        "Cannot combine bodies: the geometry file is not available (a saved analysis carries none). Re-import the STEP file to edit its geometry.",
      );
      return false;
    }
    if (tools.length === 0) {
      setSplitError("Pick at least one tool body.");
      return false;
    }
    const bodyIds = properties
      .filter(isCadBody)
      .map((p) => p.id)
      .sort((a, b) => a - b);
    return run(
      "boolean_geometry",
      { boolean: { op, target, tools, keepTools } },
      (reply) =>
        booleanBodySources(
          bodyIds,
          op,
          target,
          tools,
          keepTools,
          reply.bodyCount,
        ),
    );
  }

  // Remove the hinges a failed mesh reported. Separating can leave a body in
  // pieces, which the user then has to decide about.
  async function repairHinges(repair: RepairHingesOptions): Promise<boolean> {
    if (!stepBytes) {
      setSplitError(
        "Cannot repair: the geometry file is not available (a saved analysis carries none). Re-import the STEP file to edit its geometry.",
      );
      return false;
    }
    if (!Number.isFinite(repair.width) || repair.width <= 0) {
      setSplitError("The repair width must be a positive number of mm.");
      return false;
    }
    const bodiesBefore = properties.filter(isCadBody).length;
    const ok = await run<EditReply & { bodySources: number[] }>(
      "repair_hinges",
      { repair },
      (reply) => reply.bodySources,
    );
    if (ok) {
      const state = useModelStore.getState();
      const bodies = state.properties.filter(isCadBody).length;
      if (bodies > bodiesBefore)
        state.setRemeshNotice(
          `The model is now ${bodies} separate bodies. Suppress any you don't need, or tie them together.`,
        );
    }
    return ok;
  }

  // Divide the cone tips a failed mesh reported.
  function splitConeTips(faceIds: number[]): Promise<boolean> {
    if (!stepBytes) {
      setSplitError(
        "Cannot split the cone tips: the geometry file is not available (a saved analysis carries none). Re-import the STEP file to edit its geometry.",
      );
      return Promise.resolve(false);
    }
    return run("split_cone_tips", { faceIds });
  }

  // Remove the faces a failed mesh could not mesh, closing the gap with the
  // faces around them. Changes the shape slightly: the card says so.
  function removeFaces(faceIds: number[]): Promise<boolean> {
    if (!stepBytes) {
      setSplitError(
        "Cannot remove the faces: the geometry file is not available (a saved analysis carries none). Re-import the STEP file to edit its geometry.",
      );
      return Promise.resolve(false);
    }
    return run("remove_faces", { faceIds });
  }

  // `bodySources` maps the edited model's bodies back to the old ones when the
  // edit knows it (a Boolean, a hinge repair), so their settings survive the
  // renumbering.
  async function run<Reply extends EditReply = EditReply>(
    type:
      | "split_geometry"
      | "boolean_geometry"
      | "repair_hinges"
      | "split_cone_tips"
      | "remove_faces",
    edit: Record<string, unknown>,
    bodySources?: (reply: Reply) => number[],
  ): Promise<boolean> {
    setSplitError(null);
    setIsSplitting(true);
    setRunning(true);
    try {
      const reply = await sendToWorker<Reply>(type, {
        bytes: stepBytes,
        format: geometryFormat,
        ...edit,
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
        bodySources?.(reply),
      );
      return true;
    } catch (err) {
      // The worker may already hold the edited shape the store did not take;
      // replace it so the next mesh reloads the file the store has.
      resetWorker();
      // The engine's message names the face or body and the fix; the C++ type
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

  return {
    split,
    combine,
    repairHinges,
    splitConeTips,
    removeFaces,
    undo,
    isSplitting,
    splitError,
    setSplitError,
  };
}
