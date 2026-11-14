// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useEffect, useState } from "react";
import { useModelStore } from "../store/modelStore";
import { fmt, loadsSummary } from "../lib/modelDisplay";
import { sendToWorker } from "../workers/sharedWorker";
import type { SolvePayload } from "../workers/solverTypes";
import {
  amgFallbackPreconditioner,
  amgUnavailableReason,
  FALLBACK_PRECONDITIONER_LABEL,
} from "../lib/solve/amg";
import { routeSolve, type SolveRoute } from "../lib/solve/route";
import { thinWallMessage, type ThinWallFinding } from "../lib/solve/thinWall";
import { useWorkerLogs } from "./useWorkerLogs";
import {
  categorizeError,
  currentWorkflow,
  startTimer,
  track,
} from "../lib/analytics";
import {
  suppressionMismatch,
  suppressionMismatchMessage,
} from "../store/geometrySlice";

// Static solve: owns the pre-flight readiness checks, the worker's solve
// protocol and result storage (displacements + von Mises), the solver log
// stream (issue #278 — same live progress feed as the mesher, including the
// CG residual minimization), and the hand-off to results mode.
export function useSolver() {
  const nodes = useModelStore((s) => s.nodes);
  const elements = useModelStore((s) => s.elements);
  const materials = useModelStore((s) => s.materials);
  const properties = useModelStore((s) => s.properties);
  const constraints = useModelStore((s) => s.constraints);
  const loads = useModelStore((s) => s.loads);
  const surfaceLoads = useModelStore((s) => s.surfaceLoads);
  const isRunning = useModelStore((s) => s.isRunning);
  const setRunning = useModelStore((s) => s.setRunning);
  const setResult = useModelStore((s) => s.setResult);
  const setMode = useModelStore((s) => s.setMode);
  const elementOrder = useModelStore((s) => s.elementOrder);
  const solverMethod = useModelStore((s) => s.solverMethod);
  const setSolverMethod = useModelStore((s) => s.setSolverMethod);
  const tieGroups = useModelStore((s) => s.tieGroups);
  const couplingGroups = useModelStore((s) => s.couplingGroups);
  // Surface mesh + CAD face ids drive auto-shell idealisation of thin bodies
  // in the worker's coupled solve.
  const surfaceTriangles = useModelStore((s) => s.surfaceTriangles);
  const surfaceFaceIds = useModelStore((s) => s.surfaceFaceIds);
  const [error, setError] = useState<string | null>(null);
  const { logs, clearLogs } = useWorkerLogs("solve");
  const [thinWalls, setThinWalls] = useState<ThinWallFinding[]>([]);

  // A body suppressed or restored after meshing makes the mesh a different
  // assembly from the model — solving it would analyse the wrong one.
  const meshSuppressedIds = useModelStore((s) => s.meshSuppressedIds);
  const suppressionStale = suppressionMismatchMessage(
    suppressionMismatch(properties, meshSuppressedIds, nodes.length > 0),
    properties,
  );
  const meshOk = nodes.length > 0 && suppressionStale === null;
  // Every body must resolve to an existing material — a body left pointing at
  // a deleted material would fail in the solver with the same message.
  const matOk =
    materials.length > 0 &&
    properties.every((p) => materials.some((m) => m.id === p.materialId));
  const bcOk = constraints.length > 0;
  // Force/pressure loads now reach the solver as surface tractions, moments as
  // nodal forces — either kind makes the model loaded.
  const loadOk = loads.length > 0 || surfaceLoads.length > 0;
  // A non-zero prescribed displacement drives the deformation on its own, so the
  // model is solvable without an applied load. Without either, the solve returns
  // the trivial zero field, so at least one driving action is still required.
  // eslint-disable-next-line kofem/no-silent-fallback -- a constraint without prescribedValue is a homogeneous fixed BC, i.e. u = 0 by definition
  const prescribedOk = constraints.some((c) => (c.prescribedValue ?? 0) !== 0);
  const drivingOk = loadOk || prescribedOk;
  // The route the solve will take, or why no path takes this model (a tie or
  // element order the path cannot apply, KOF-353) — the worker refuses it with
  // the same words, so say so before the solve. Only with a mesh: before one
  // there is no model.
  const { route, routeRefusal } = solveRoute(
    nodes.length > 0
      ? {
          nodes,
          elements,
          materials,
          properties,
          constraints,
          loads,
          surfaceLoads,
          elementOrder,
          tieGroups,
          couplings: couplingGroups,
        }
      : null,
  );
  const allOk = meshOk && matOk && bcOk && drivingOk && routeRefusal === null;

  // Linear tets on a thin wall give too-stiff results (KOF-274): check the
  // meshed model for walls spanned by too few elements.
  useEffect(() => {
    let current = true;
    if (nodes.length === 0 || elementOrder !== 1) {
      setThinWalls([]);
      return;
    }
    sendToWorker<{ findings: ThinWallFinding[] }>("thin_wall_check", {
      nodes,
      elements,
      properties,
      surfaceTriangles,
      surfaceFaceIds,
      elementOrder,
    })
      .then(({ findings }) => {
        if (current) setThinWalls(findings);
      })
      .catch((err: Error) => {
        console.error("[thin-wall check] failed:", err.message);
        if (current) setThinWalls([]);
      });
    return () => {
      current = false;
    };
  }, [
    nodes,
    elements,
    properties,
    surfaceTriangles,
    surfaceFaceIds,
    elementOrder,
  ]);

  function solve() {
    setRunning(true);
    clearLogs();
    const workflow = currentWorkflow();
    const elapsed = startTimer();
    track("solve_started", { workflow, analysis_type: "static" });
    const payload: SolvePayload = {
      nodes,
      elements,
      materials,
      properties,
      constraints,
      loads,
      surfaceLoads,
      elementOrder,
      solverMethod,
      tieGroups,
      couplings: couplingGroups,
      surfaceTriangles,
      surfaceFaceIds,
    };
    // The worker transfers the solver's Float64Array buffers here zero-copy
    // (issue #166) — store them as-is, no per-element copy.
    sendToWorker<{ displacements: Float64Array; vonMises: Float64Array }>(
      "solve",
      payload,
    )
      .then(({ displacements, vonMises }) => {
        setResult({ displacements, vonMises });
        track("solve_completed", {
          workflow,
          analysis_type: "static",
          duration_bucket: elapsed(),
        });
        setMode("results");
      })
      .catch((err) => {
        console.error("[solve] solver failed:", err.message);
        setError(`Solver error: ${err.message}`);
        track("solve_failed", {
          workflow,
          analysis_type: "static",
          duration_bucket: elapsed(),
          error_category: categorizeError(err),
        });
      })
      .finally(() => setRunning(false));
  }

  // Expose for Playwright E2E tests — allows bypassing the button's disabled-state
  // timing uncertainty in CI without requiring UI interaction.
  useEffect(() => {
    (
      window as Window & { __kofemTriggerSolve?: () => void }
    ).__kofemTriggerSolve = solve;
  });

  const checks: [boolean, string][] = [
    [
      meshOk,
      suppressionStale !== null
        ? suppressionStale
        : `Mesh ready · ${nodes.length} nodes · ${elements.length} elements`,
    ],
    [
      matOk,
      materials.length === 0
        ? "No material assigned"
        : !matOk
          ? "A body references a deleted material — reassign body materials"
          : properties.length > 1
            ? `Materials assigned · ${properties.length} bodies · ${materials.length} material${materials.length > 1 ? "s" : ""}`
            : `Material assigned · ${materials[0].name} · E=${fmt(materials[0].young, 3)} MPa`,
    ],
    [
      bcOk,
      bcOk
        ? `BCs applied · ${new Set(constraints.map((c) => c.nodeId)).size} nodes fixed`
        : "No boundary conditions",
    ],
    [
      drivingOk,
      loadOk
        ? loadsSummary(loads.length, surfaceLoads.length)
        : prescribedOk
          ? "Prescribed displacement drives the model"
          : "No loads or prescribed displacement",
    ],
    ...thinWalls.map((f): [boolean, string] => [false, thinWallMessage(f)]),
    ...(routeRefusal === null
      ? []
      : [[false, routeRefusal] satisfies [boolean, string]]),
  ];

  // Why the chosen AMG solver will not take this model and what the solve uses
  // instead (shown under the solver choice), or null. Only computed with a
  // mesh: before one there is no model.
  const amgModel = {
    elements,
    properties,
    elementOrder,
    couplingCount: couplingGroups.length,
  };
  const amgReason = route !== null ? amgUnavailableReason(amgModel) : null;
  const amgUnavailable =
    amgReason === null || route === null
      ? null
      : {
          reason: amgReason,
          fallback:
            FALLBACK_PRECONDITIONER_LABEL[amgFallbackPreconditioner(route)],
        };

  return {
    solve,
    error,
    setError,
    isRunning,
    allOk,
    checks,
    elementOrder,
    solverMethod,
    setSolverMethod,
    amgUnavailable,
    logs,
  };
}

// routeSolve on the panel's model: the route it takes, or the reason it is
// refused. Null model (no mesh yet): neither.
function solveRoute(model: Parameters<typeof routeSolve>[0] | null): {
  route: SolveRoute | null;
  routeRefusal: string | null;
} {
  if (model === null) return { route: null, routeRefusal: null };
  try {
    return { route: routeSolve(model), routeRefusal: null };
  } catch (err) {
    if (!(err instanceof Error)) throw err;
    return { route: null, routeRefusal: err.message };
  }
}
