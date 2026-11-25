// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useEffect } from "react";
import { useModelStore } from "../store/modelStore";
import type {
  TopOptNumericField,
  TopOptSettingsState,
} from "../store/modelStore";
import type {
  TopOptHistoryEntry,
  TopOptSettings,
} from "../lib/solve/contracts.js";
import {
  loadsSummary,
  materialCheckLabel,
  meshCheckLabel,
} from "../lib/modelDisplay";
import { resultUnit } from "../lib/resultField";
import {
  resetWorker,
  sendToWorker,
  setProgressCallback,
} from "../workers/sharedWorker";
import { useWorkerLogs } from "./useWorkerLogs";
import {
  categorizeError,
  startTimer,
  track,
  workflowParams,
} from "../lib/analytics";
import {
  isCadBody,
  suppressionMismatch,
  suppressionMismatchMessage,
  unconfirmedMaterialBodies,
  unconfirmedMaterialMessage,
} from "../store/geometrySlice";
import { passiveElements, roleOf } from "../lib/regions";
import { topOptTieRefusal } from "../lib/solve/refusals";
import { prescribedValueOf } from "../lib/solve/messageDefaults";

export type FieldErrors = Partial<Record<TopOptNumericField, string>>;

// Parse and validate the raw setting strings into the engine's TopOptSettings
// block. Only the fields relevant to the chosen objective are checked — the
// constraint field switches with the objective — and the ranges match the
// engine's own validation (topology_optimize.cpp) so a run never reaches the
// solver only to be rejected there. Returns the engine settings when every
// relevant field is valid, plus a per-field error map for inline messages.
// House rule (no silent fallbacks): an unparseable or out-of-range field is an
// explicit error and blocks the run, never a quietly substituted default.
function parseSettings(state: TopOptSettingsState): {
  settings: TopOptSettings | null;
  errors: FieldErrors;
} {
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

  // The level set has no SIMP penalty and no MMA move limit; those fields are
  // hidden in its panel, so they are neither validated nor sent.
  const simp = state.method === "simp";
  // The max-stress constraint is SIMP-only too (KOF-236): hidden in the
  // level-set panel, so neither validated nor sent there.
  const stressOn = simp && state.stressConstraint;
  const penalty = simp
    ? num("penalty", state.penalty, (value) => value >= 1, "penalty p ≥ 1")
    : undefined;
  const filterRadius = num(
    "filterRadius",
    state.filterRadius,
    (value) => value > 0,
    simp ? "filter radius r_min > 0" : "length scale ℓ > 0",
  );
  const moveLimit = simp
    ? num(
        "moveLimit",
        state.moveLimit,
        (value) => value > 0 && value <= 1,
        "move limit in (0, 1]",
      )
    : undefined;
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
  } else if (stressOn && state.complianceLimit.trim() === "") {
    // A stress-bounded min_volume run needs no compliance limit (KOF-236): a
    // blank field means "none", which the engine accepts with maxStress present.
  } else {
    const limit = num(
      "complianceLimit",
      state.complianceLimit,
      (value) => value > 0,
      stressOn
        ? "compliance limit > 0, or blank for none"
        : "compliance limit > 0",
    );
    constraints.complianceLimit = limit;
  }

  let stress: TopOptSettings["stress"];
  if (stressOn) {
    constraints.maxStress = num(
      "maxStress",
      state.maxStress,
      (value) => value > 0,
      "max stress σ_allow > 0",
    );
    const aggregationP = num(
      "stressP",
      state.stressP,
      (value) => value >= 1,
      "aggregation P ≥ 1",
    );
    stress = { aggregation: state.stressAggregation, p: aggregationP };
  }

  if (Object.keys(errors).length > 0) return { settings: null, errors };
  return {
    settings: {
      method: state.method,
      objective: state.objective,
      constraints,
      ...(stress ? { stress } : {}),
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
// the hand-off to Results with the density field. While the run is active each
// streamed iteration density lands in `liveDensity` for the viewport (KOF-240).
// Cancellation, like meshing's, is owned by the worker lifecycle:
// optimize_topology is one blocking WASM call, so a running optimization is
// cancelled by terminating the worker (resetWorker), which discards the
// in-flight run and its live density — no best-so-far is kept.
// Set by cancel, read when the cancelled run's promise rejects: the terminated
// worker rejects it, and that rejection is no failure to report. Module-level,
// as one run is in flight at a time and any panel may cancel it.
let cancelled = false;

export function useTopOpt() {
  const nodes = useModelStore((s) => s.nodes);
  const elements = useModelStore((s) => s.elements);
  const materials = useModelStore((s) => s.materials);
  const properties = useModelStore((s) => s.properties);
  const constraints = useModelStore((s) => s.constraints);
  const loads = useModelStore((s) => s.loads);
  const surfaceLoads = useModelStore((s) => s.surfaceLoads);
  const temperature = useModelStore((s) => s.temperature);
  const topOpt = useModelStore((s) => s.topOpt);
  // Couplings join solid bodies and idealised shells in the coupled TO path
  // (KOF-237), exactly as the static solve consumes them. No optimizer applies
  // a tie yet, so a tied model is refused (KOF-353).
  const tieGroups = useModelStore((s) => s.tieGroups);
  const couplingGroups = useModelStore((s) => s.couplingGroups);
  const isOptimizing = useModelStore((s) => s.isOptimizing);
  const setOptimizing = useModelStore((s) => s.setOptimizing);
  const setDensityResult = useModelStore((s) => s.setDensityResult);
  const setLiveDensity = useModelStore((s) => s.setLiveDensity);
  const showTopOptResult = useModelStore((s) => s.showTopOptResult);
  // In the store, not the component: the run hands off to Results as it
  // starts, so the panel that started it is gone by the time it fails.
  const error = useModelStore((s) => s.topOptError);
  const setError = useModelStore((s) => s.setTopOptError);
  const { logs, clearLogs } = useWorkerLogs("optimize");

  // A body suppressed or restored after meshing makes the mesh a different
  // assembly from the model — solving it would analyse the wrong one.
  const meshSuppressedIds = useModelStore((s) => s.meshSuppressedIds);
  const suppressionStale = suppressionMismatchMessage(
    suppressionMismatch(properties, meshSuppressedIds, nodes.length > 0),
    properties,
  );
  const meshOk = nodes.length > 0 && suppressionStale === null;
  // Every body must resolve to an existing material — same rule as the solve.
  const materialsExist =
    materials.length > 0 &&
    properties.every((p) => materials.some((m) => m.id === p.materialId));
  // A body the mesh added was offered a material nobody chose (KOF-413).
  const unconfirmedMaterial = unconfirmedMaterialMessage(
    unconfirmedMaterialBodies(properties),
  );
  const matOk = materialsExist && unconfirmedMaterial === null;
  const bcOk = constraints.length > 0;
  // Minimum-compliance TO needs external work to minimize, so an applied load
  // is required (a prescribed-displacement-only model is degenerate here) —
  // unlike the static solve, which a non-zero prescribed displacement drives.
  const loadOk = loads.length > 0 || surfaceLoads.length > 0;

  const solidElements = elements.filter((e) => e.type !== "CTRIA3");
  const shellElements = elements.filter((e) => e.type === "CTRIA3");

  // The engine's compliance sensitivity assumes homogeneous supports, so it
  // rejects any non-zero prescribed displacement (topology_simp.cpp). Catch it
  // in pre-flight and explain, rather than enable a run that predictably fails.
  const hasPrescribed = constraints.some((c) => prescribedValueOf(c) !== 0);

  // The stress constraint is implemented for the all-solid SIMP path only.
  // Shells, and any coupling (which routes even an all-solid model to the
  // coupled optimizer), reach an optimizer that rejects it (topOptRust.ts),
  // so block the run in pre-flight rather than let it fail in the worker. The
  // level-set panel hides the constraint and does not send it.
  const stressOnShell =
    topOpt.method === "simp" &&
    topOpt.stressConstraint &&
    (shellElements.length > 0 || couplingGroups.length > 0);

  const { settings, errors } = parseSettings(topOpt);
  const settingsOk = settings !== null;
  // The level-set optimizer (engine/cpp/topology_levelset.h) runs on solid
  // meshes and minimizes compliance only; SIMP covers the rest.
  const levelSet = topOpt.method === "level_set";
  const levelSetShellBlock = levelSet && shellElements.length > 0;
  // A coupling routes even an all-solid model to the coupled optimizer, which
  // runs SIMP only (solver.worker.ts handleTopOpt).
  const levelSetCouplingBlock = levelSet && couplingGroups.length > 0;
  const levelSetObjectiveBlock =
    levelSet && topOpt.objective !== "min_compliance";
  // Regions fixed as Keep solid / Keep empty (KOF-257) are left out of the
  // design; with none left to shape there is nothing to optimize.
  const noDesignRegion = properties
    .filter((p) => isCadBody(p) && !p.suppressed)
    .every((p) => roleOf(p) !== "design");
  // No optimizer applies a tie: the worker refuses a tied model (routeTopOpt)
  // with the same words, so say so before the run.
  const tieRefusal = topOptTieRefusal(tieGroups);
  const allOk =
    tieRefusal === null &&
    !noDesignRegion &&
    !levelSetShellBlock &&
    !levelSetCouplingBlock &&
    !levelSetObjectiveBlock &&
    meshOk &&
    matOk &&
    bcOk &&
    loadOk &&
    !hasPrescribed &&
    !stressOnShell &&
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
    cancelled = false;
    setOptimizing(true);
    // Straight to Results → Density, as the mesh refinement study goes to its
    // chart: the density streams there live, and the panel switches to the
    // convergence chart.
    showTopOptResult();
    clearLogs();
    setLiveDensity(null);
    setProgressCallback(({ it, density }) => setLiveDensity({ it, density }));
    const workflow = workflowParams();
    const elapsed = startTimer();
    track("solve_started", { ...workflow, analysis_type: "topology" });
    sendToWorker<{
      density: Float64Array;
      levelSet?: Float64Array;
      history: TopOptHistoryEntry[];
      converged: boolean;
      iterations: number;
    }>("optimize_topology", {
      nodes,
      elements,
      materials,
      properties,
      constraints,
      loads,
      surfaceLoads,
      temperature,
      tieGroups,
      couplings: couplingGroups,
      settings: { ...settings, passive: passiveElements(elements, properties) },
    })
      .then(({ density, levelSet, history, converged, iterations }) => {
        setDensityResult({ density, levelSet, history, converged, iterations });
        track("solve_completed", {
          ...workflow,
          analysis_type: "topology",
          duration_bucket: elapsed(),
        });
      })
      .catch((err) => {
        // A cancel terminated the worker; the resulting rejection is expected.
        if (cancelled) return;
        console.error("[topopt] optimization failed:", err.message);
        setError(`Optimization error: ${err.message}`);
        track("solve_failed", {
          ...workflow,
          analysis_type: "topology",
          duration_bucket: elapsed(),
          error_category: categorizeError(err),
        });
      })
      .finally(() => {
        setProgressCallback(null);
        setLiveDensity(null);
        setOptimizing(false);
      });
  }

  function cancel() {
    cancelled = true;
    // Terminate the worker to abort the blocking optimize_topology call; the
    // next run recreates it (the mesh travels in the payload, so nothing needs
    // reloading into the fresh module).
    resetWorker();
    setProgressCallback(null);
    setLiveDensity(null);
    setOptimizing(false);
  }

  // Expose for Playwright E2E — bypass the button's disabled-state timing.
  useEffect(() => {
    (
      window as Window & { __kofemTriggerOptimize?: () => void }
    ).__kofemTriggerOptimize = optimize;
  });

  // A run asked for from a panel ("Run again with 2N iterations", KOF-412):
  // start it here. The request is taken from the store, not from this render:
  // StrictMode replays the effect with the same closure, and the Optimize
  // panel and Results may both hold this hook — one run, not one per caller.
  const runRequested = useModelStore((s) => s.topOptRunRequested);
  useEffect(() => {
    if (!runRequested) return;
    const state = useModelStore.getState();
    if (!state.topOptRunRequested) return;
    state.clearTopOptRunRequest();
    if (state.isOptimizing) return;
    if (allOk) optimize();
    else
      setError(
        "Could not run the optimization again: resolve the failed pre-flight checks on the Optimize panel first.",
      );
  });

  const stressSummary = topOpt.stressConstraint
    ? ` · σ_vm ≤ ${topOpt.maxStress} ${resultUnit("Von Mises stress")}`
    : "";
  const complianceSummary =
    topOpt.complianceLimit.trim() === ""
      ? ""
      : ` · compliance ≤ ${topOpt.complianceLimit}`;
  const settingsSummary = levelSet
    ? `Level set · minimize compliance · volfrac ${topOpt.volumeFraction} · ℓ=${topOpt.filterRadius}`
    : topOpt.objective === "min_compliance"
      ? `Minimize compliance · volfrac ${topOpt.volumeFraction}${stressSummary} · p=${topOpt.penalty} · r_min=${topOpt.filterRadius}`
      : `Minimize volume${complianceSummary}${stressSummary} · p=${topOpt.penalty} · r_min=${topOpt.filterRadius}`;

  // What the optimizer treats as design variables (KOF-237): every solid tet and
  // shell facet carries a density; the RBE3/coupling DOFs of a coupled model do
  // not. The panel shows this so the design domain is never a surprise.
  const nSolid = solidElements.length;
  const nShell = shellElements.length;
  const plural = (n: number, word: string) =>
    `${n} ${word}${n === 1 ? "" : "s"}`;
  const couplingNote =
    couplingGroups.length > 0
      ? ` (${plural(couplingGroups.length, "coupling")} held fixed)`
      : "";
  const designDomain =
    nShell === 0
      ? plural(nSolid, "solid element")
      : nSolid === 0
        ? plural(nShell, "shell facet")
        : `${plural(nSolid, "solid element")} + ${plural(nShell, "shell facet")}${couplingNote}`;

  const checks: [boolean, string][] = [
    [meshOk, meshCheckLabel(nodes.length, elements.length, suppressionStale)],
    [
      matOk,
      materials.length === 0
        ? "No material assigned"
        : !materialsExist
          ? "A body references a deleted material — reassign body materials"
          : unconfirmedMaterial !== null
            ? unconfirmedMaterial
            : materialCheckLabel(materials, properties.length),
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
        ? loadsSummary(loads.length, surfaceLoads.length)
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
  if (tieRefusal !== null) checks.push([false, tieRefusal]);
  if (noDesignRegion)
    checks.push([
      false,
      "Every region is set to Keep solid or Keep empty — set at least one to Design so the optimizer has material to shape",
    ]);
  if (levelSetShellBlock)
    checks.push([
      false,
      "The level-set method supports solid models only — use SIMP for shell and coupled models",
    ]);
  if (levelSetCouplingBlock)
    checks.push([
      false,
      "The level-set method does not support couplings yet — remove them, or use SIMP",
    ]);
  if (levelSetObjectiveBlock)
    checks.push([
      false,
      "The level-set method minimizes compliance only — switch the objective, or use SIMP",
    ]);
  if (hasPrescribed)
    checks.push([
      false,
      "Remove non-zero prescribed displacements — topology optimization supports fixed (zero) supports only",
    ]);
  if (stressOnShell)
    checks.push([
      false,
      "The max-stress constraint supports all-solid models without couplings only — turn it off to optimize this shell/coupled model",
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
