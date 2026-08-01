// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useEffect, useState } from "react";
import { useModelStore } from "../store/modelStore";
import { fmt } from "../lib/modelDisplay";
import { sendToWorker } from "../workers/sharedWorker";
import { useWorkerLogs } from "./useWorkerLogs";

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
  const tieGroups = useModelStore((s) => s.tieGroups);
  const couplingGroups = useModelStore((s) => s.couplingGroups);
  // Surface mesh + CAD face ids drive auto-shell idealisation of thin bodies
  // in the worker's coupled solve.
  const surfaceTriangles = useModelStore((s) => s.surfaceTriangles);
  const surfaceFaceIds = useModelStore((s) => s.surfaceFaceIds);
  const [error, setError] = useState<string | null>(null);
  const { logs, clearLogs } = useWorkerLogs("solve");

  const meshOk = nodes.length > 0;
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
  const allOk = meshOk && matOk && bcOk && drivingOk;

  function solve() {
    setRunning(true);
    clearLogs();
    // The worker transfers the solver's Float64Array buffers here zero-copy
    // (issue #166) — store them as-is, no per-element copy.
    sendToWorker<{ displacements: Float64Array; vonMises: Float64Array }>(
      "solve",
      {
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
        surfaceTriangles,
        surfaceFaceIds,
      },
    )
      .then(({ displacements, vonMises }) => {
        setResult({ displacements, vonMises });
        setMode("results");
      })
      .catch((err) => {
        console.error("[solve] solver failed:", err.message);
        setError(`Solver error: ${err.message}`);
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
      `Mesh ready · ${nodes.length} nodes · ${elements.length} elements`,
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
        ? `Loads applied · ${loads.length} load DOFs`
        : prescribedOk
          ? "Prescribed displacement drives the model"
          : "No loads or prescribed displacement",
    ],
  ];

  return {
    solve,
    error,
    setError,
    isRunning,
    allOk,
    checks,
    elementOrder,
    logs,
  };
}
