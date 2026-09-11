// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useEffect, useRef, useState } from "react";
import { useModelStore } from "../store/modelStore";
import type { TopOptNumericField } from "../store/modelStore";
import type {
  TopOptHistoryEntry,
  TopOptSettings,
} from "../wasm/pkg/kofem_wasm.js";
import { fmt } from "../lib/modelDisplay";
import { resetWorker, sendToWorker } from "../workers/sharedWorker";
import { useWorkerLogs } from "./useWorkerLogs";

export type FieldErrors = Partial<Record<TopOptNumericField, string>>;

// Parse and validate the raw setting strings into the engine's TopOptSettings
// block. Only the fields relevant to the chosen objective are checked — the
// constraint field switches with the objective — and the ranges match the
// engine's own validation (topology_optimize.cpp) so a run never reaches the
// solver only to be rejected there. Returns the engine settings when every
// relevant field is valid, plus a per-field error map for inline messages.
// House rule (no silent fallbacks): an unparseable or out-of-range field is an
// explicit error and blocks the run, never a quietly substituted default.
function parseSettings(state: {
  objective: TopOptSettings["objective"];
  volumeFraction: string;
  complianceLimit: string;
  penalty: string;
  filterRadius: string;
  moveLimit: string;
  maxIterations: string;
  tolerance: string;
}): { settings: TopOptSettings | null; errors: FieldErrors } {
  const errors: FieldErrors = {};

  // Validate one numeric field: parse it, apply the predicate, and record a
  // clear message on failure. Returns the parsed value regardless so callers
  // can build the settings object once `errors` is known to be empty.
  const num = (
    field: TopOptNumericField,
    raw: string,
    ok: (value: number) => boolean,
    requirement: string,
  ): number => {
    const parsed = Number(raw.trim());
    if (raw.trim() === "" || !Number.isFinite(parsed) || !ok(parsed))
      errors[field] = `${requirement} — got "${raw}"`;
    return parsed;
  };

  const penalty = num(
    "penalty",
    state.penalty,
    (value) => value >= 1,
    "penalty p ≥ 1",
  );
  const filterRadius = num(
    "filterRadius",
    state.filterRadius,
    (value) => value > 0,
    "filter radius r_min > 0",
  );
  const moveLimit = num(
    "moveLimit",
    state.moveLimit,
    (value) => value > 0 && value <= 1,
    "move limit in (0, 1]",
  );
  const maxIterations = num(
    "maxIterations",
    state.maxIterations,
    (value) => Number.isInteger(value) && value > 0,
    "max iterations must be a whole number > 0",
  );
  const tolerance = num(
    "tolerance",
    state.tolerance,
    (value) => value > 0,
    "tolerance > 0",
  );

  const constraints: TopOptSettings["constraints"] = {};
  if (state.objective === "min_compliance") {
    const volfrac = num(
      "volumeFraction",
      state.volumeFraction,
      (value) => value > 0 && value < 1,
      "volume fraction in (0, 1)",
    );
    constraints.volumeFraction = volfrac;
  } else {
    const limit = num(
      "complianceLimit",
      state.complianceLimit,
      (value) => value > 0,
      "compliance limit > 0",
    );
    constraints.complianceLimit = limit;
  }

  if (Object.keys(errors).length > 0) return { settings: null, errors };
  return {
    settings: {
      objective: state.objective,
      constraints,
      penalty,
      filterRadius,
      moveLimit,
      maxIterations,
      tolerance,
    },
    errors,
  };
}

// Topology optimization: the run hook mirroring useSolver (KOF-232). Owns the
// pre-flight readiness checks, the setting validation, the worker's
// optimize_topology protocol (KOF-231) and its live iteration log stream, and
// the hand-off to Results with the density field. Cancellation, like meshing's,
// is owned by the worker lifecycle: optimize_topology is one blocking WASM call,
// so a running optimization is cancelled by terminating the worker (resetWorker),
// which discards the in-flight run (ADR-0002 — no best-so-far density is streamed).
export function useTopOpt() {
  const nodes = useModelStore((s) => s.nodes);
  const elements = useModelStore((s) => s.elements);
  const materials = useModelStore((s) => s.materials);
  const properties = useModelStore((s) => s.properties);
  const constraints = useModelStore((s) => s.constraints);
  const loads = useModelStore((s) => s.loads);
  const surfaceLoads = useModelStore((s) => s.surfaceLoads);
  const topOpt = useModelStore((s) => s.topOpt);
  // Ties/couplings join solid bodies and idealised shells in the coupled TO path
  // (KOF-237), exactly as the static solve consumes them.
  const tieGroups = useModelStore((s) => s.tieGroups);
  const couplingGroups = useModelStore((s) => s.couplingGroups);
  const isOptimizing = useModelStore((s) => s.isOptimizing);
  const setOptimizing = useModelStore((s) => s.setOptimizing);
  const setDensityResult = useModelStore((s) => s.setDensityResult);
  const setMode = useModelStore((s) => s.setMode);
  const [error, setError] = useState<string | null>(null);
  const { logs, clearLogs } = useWorkerLogs("optimize");
  // Distinguishes a user cancel (terminate the worker) from a genuine failure:
  // the terminate rejects the in-flight promise, and that rejection must not
  // surface as an error banner.
  const cancelledRef = useRef(false);

  const meshOk = nodes.length > 0;
  // Every body must resolve to an existing material — same rule as the solve.
  const matOk =
    materials.length > 0 &&
    properties.every((p) => materials.some((m) => m.id === p.materialId));
  const bcOk = constraints.length > 0;
  // Minimum-compliance TO needs external work to minimize, so an applied load
  // is required (a prescribed-displacement-only model is degenerate here) —
  // unlike the static solve, which a non-zero prescribed displacement drives.
  const loadOk = loads.length > 0 || surfaceLoads.length > 0;

  // TO optimizes ONE design material per sub-domain: the engine reads a single
  // (E, ν) for the solid tets and a single (E, ν) for the shell facets
  // (topology_simp.cpp / topology_shell_entry.cpp), so each sub-domain must
  // resolve to one material — otherwise the per-body assignments would be
  // silently discarded. Count the solid and shell domains separately, the way
  // the shell/coupled solvers do (a coupled model legitimately carries one solid
  // material and one shell material).
  const propById = new Map(properties.map((p) => [p.id, p]));
  const materialIdsOf = (els: typeof elements) =>
    new Set(
      els
        .map((e) => propById.get(e.propertyId)?.materialId)
        .filter((id): id is number => id !== undefined),
    );
  const solidElements = elements.filter((e) => e.type !== "CTRIA3");
  const shellElements = elements.filter((e) => e.type === "CTRIA3");
  const solidMaterialIds = materialIdsOf(solidElements);
  const shellMaterialIds = materialIdsOf(shellElements);
  const singleMaterialOk =
    solidMaterialIds.size <= 1 && shellMaterialIds.size <= 1;

  // The engine's compliance sensitivity assumes homogeneous supports, so it
  // rejects any non-zero prescribed displacement (topology_simp.cpp). Catch it
  // in pre-flight and explain, rather than enable a run that predictably fails.
  // eslint-disable-next-line kofem/no-silent-fallback -- a constraint without prescribedValue is a homogeneous fixed BC, i.e. u = 0 by definition
  const hasPrescribed = constraints.some((c) => (c.prescribedValue ?? 0) !== 0);

  const { settings, errors } = parseSettings(topOpt);
  const settingsOk = settings !== null;
  const allOk =
    meshOk &&
    matOk &&
    singleMaterialOk &&
    bcOk &&
    loadOk &&
    !hasPrescribed &&
    settingsOk;

  function optimize() {
    // __kofemTriggerOptimize (E2E) can reach this without the button's gate, so
    // re-check the settings here rather than trust the caller.
    if (!settings) {
      setError(
        `Optimization settings are invalid: ${Object.values(errors).join("; ")}`,
      );
      return;
    }
    setError(null);
    cancelledRef.current = false;
    setOptimizing(true);
    clearLogs();
    sendToWorker<{ density: Float64Array; history: TopOptHistoryEntry[] }>(
      "optimize_topology",
      {
        nodes,
        elements,
        materials,
        properties,
        constraints,
        loads,
        surfaceLoads,
        tieGroups,
        couplings: couplingGroups,
        settings,
      },
    )
      .then(({ density, history }) => {
        setDensityResult({ density, history });
        setMode("results");
      })
      .catch((err) => {
        // A cancel terminated the worker; the resulting rejection is expected.
        if (cancelledRef.current) return;
        console.error("[topopt] optimization failed:", err.message);
        setError(`Optimization error: ${err.message}`);
      })
      .finally(() => setOptimizing(false));
  }

  function cancel() {
    cancelledRef.current = true;
    // Terminate the worker to abort the blocking optimize_topology call; the
    // next run recreates it (the mesh travels in the payload, so nothing needs
    // reloading into the fresh module).
    resetWorker();
    setOptimizing(false);
  }

  // Expose for Playwright E2E — bypass the button's disabled-state timing.
  useEffect(() => {
    (
      window as Window & { __kofemTriggerOptimize?: () => void }
    ).__kofemTriggerOptimize = optimize;
  });

  const settingsSummary =
    topOpt.objective === "min_compliance"
      ? `Minimize compliance · volfrac ${topOpt.volumeFraction} · p=${topOpt.penalty} · r_min=${topOpt.filterRadius}`
      : `Minimize volume · compliance ≤ ${topOpt.complianceLimit} · p=${topOpt.penalty} · r_min=${topOpt.filterRadius}`;

  // What the optimizer treats as design variables (KOF-237): every solid tet and
  // shell facet carries a density; the RBE3/coupling DOFs of a coupled model do
  // not. The panel shows this so the design domain is never a surprise.
  const nSolid = solidElements.length;
  const nShell = shellElements.length;
  const plural = (n: number, word: string) =>
    `${n} ${word}${n === 1 ? "" : "s"}`;
  const designDomain =
    nShell === 0
      ? plural(nSolid, "solid element")
      : nSolid === 0
        ? plural(nShell, "shell facet")
        : `${plural(nSolid, "solid element")} + ${plural(nShell, "shell facet")}` +
          (couplingGroups.length > 0
            ? ` (${plural(couplingGroups.length, "coupling")} held fixed)`
            : "");

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
          : `Material assigned · ${materials[0].name} · E=${fmt(materials[0].young, 3)} MPa`,
    ],
    [
      bcOk,
      bcOk
        ? `BCs applied · ${new Set(constraints.map((c) => c.nodeId)).size} nodes fixed`
        : "No boundary conditions",
    ],
    [
      loadOk,
      loadOk
        ? `Loads applied · ${loads.length} load DOFs`
        : "No loads — topology optimization needs an applied load",
    ],
    [
      settingsOk,
      settingsOk
        ? settingsSummary
        : `Fix the optimization settings: ${Object.values(errors).join("; ")}`,
    ],
  ];

  // Blocker rows shown only when the condition applies, so the common case keeps
  // the familiar five-row checklist rather than always carrying two green rows
  // for constraints most models never hit.
  if (matOk && !singleMaterialOk) {
    // Pure-solid model: keep the original single-material wording. A shell or
    // coupled model reports which sub-domain is over-assigned instead.
    if (shellElements.length === 0)
      checks.push([
        false,
        `Topology optimization uses one design material, but the model spans ${solidMaterialIds.size} — assign a single material to all bodies`,
      ]);
    else
      checks.push([
        false,
        `Topology optimization uses one material per design domain — the solid domain spans ${solidMaterialIds.size} and the shell domain ${shellMaterialIds.size}; assign a single material to each`,
      ]);
  }
  if (hasPrescribed)
    checks.push([
      false,
      "Remove non-zero prescribed displacements — topology optimization supports fixed (zero) supports only",
    ]);

  return {
    optimize,
    cancel,
    error,
    setError,
    isOptimizing,
    allOk,
    checks,
    errors,
    logs,
    designDomain,
  };
}
