// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Topology optimization through the Rust module
// (crates/kofem-fem/src/topology, ADR-0002). SIMP runs on all three design
// domains: all-solid models (the engine's optimize_topology, multigrid CG),
// pure shells and coupled shell/solid models (optimize_topology_shell and
// optimize_topology_coupled, IC(0) CG). The reaction–diffusion level-set
// method runs on all-solid models (optimize_topology with method
// "level_set", KOF-358). Both go step for step as the engine. The optimizer
// runs one iteration per TopologyRun.step(), so the "[topopt] it N: …"
// progress lines and the live density stream (KOF-240) come from here with
// the same wording and cadence as from the engine.
//
// The model reaches Rust through the same helpers as the Rust static solves
// (createRustSolidModel, createShellModel, createMixedModel), and the settings keep
// the TopOptSettings wire contract and the engine's defaults.

import type { TopOptHistoryEntry, TopOptSettings } from "./contracts.js";
import type {
  ElasticModel,
  TopologyRun,
  TopologySettings,
} from "../../wasm/fem/kofem_wasm.js";
import type { ShellMesh } from "./contracts.js";
import type { TopOptPayload } from "../../workers/solverTypes.js";
import { buildVertexIndexer } from "../solveMeshPacking.js";
import {
  createRustSolidModel,
  describeSolidElements,
  rustSolidBoundaryConditions,
} from "./amg.js";
import {
  createMixedModel,
  type CoupledEngineArgs,
  type MixedFemModule,
} from "./coupledRust.js";
import { createShellModel, type ShellFemModule } from "./shellRust.js";
import { release } from "./rustFailure.js";

// The classes of the Rust module the optimizer needs, passed in so the worker
// and the node-side tests can each load the module their own way.
export interface TopologyFemModule {
  ElasticModel: typeof ElasticModel;
  TopologySettings: typeof TopologySettings;
  TopologyRun: typeof TopologyRun;
}

// The classes the shell and coupled optimizers need.
export interface ShellTopologyFemModule extends ShellFemModule {
  TopologySettings: typeof TopologySettings;
  TopologyRun: typeof TopologyRun;
}
export interface CoupledTopologyFemModule extends MixedFemModule {
  TopologySettings: typeof TopologySettings;
  TopologyRun: typeof TopologyRun;
}

// The engine's shell SIMP solves stop at ‖f − K·u‖/‖f‖ ≤ 1e-5
// (ShellTopOptConfig::cg_rtol): as void regions form, a thin-wall system's
// conditioning worsens until a tighter target runs the CG budget out
// mid-run (KOF-245); the sensitivities stay accurate to about this.
const SHELL_CG_TOLERANCE = 1e-5;

// The engine's defaults for the optional settings (topology_simp.cpp).
const DEFAULT_PENALTY = 3;
const DEFAULT_MOVE_LIMIT = 0.2;
const DEFAULT_STREAM_EVERY = 1;
const DEFAULT_PNORM_P = 8;
const DEFAULT_KS_P = 40;
// A stress limit needs ρ > 0: the qp-relaxed stress ρ^(p−q)·σ has an
// unbounded derivative at ρ = 0 (Le et al. 2010 use 1e-3).
const STRESS_RHO_MIN = 1e-3;

const present = <T>(value: T | null | undefined): value is T =>
  value !== undefined && value !== null;

// %g with `digits` significant digits, as the engine's log lines print them.
function general(value: number, digits: number): string {
  return String(Number(value.toPrecision(digits)));
}

function requirePositiveInteger(value: number, name: string): number {
  if (!Number.isInteger(value) || value <= 0)
    throw new Error(`${name} must be a positive integer`);
  return value;
}

// The optimization method, with the engine's message for an unknown one.
// SIMP is the default.
function methodOf(settings: TopOptSettings): "simp" | "level_set" {
  const { method } = settings;
  if (method === undefined || method === "simp") return "simp";
  if (method === "level_set") return method;
  throw new Error(
    `unknown topology-optimization method "${String(method)}" — expected "simp" or "level_set"`,
  );
}

// The objective's bound, with the engine's messages for an unknown
// objective and a missing bound. Shared by both methods, so a level-set run
// is refused in the engine's order: objective, bound, then method rules.
function objectiveBound(settings: TopOptSettings): number | undefined {
  const { objective, constraints } = settings;
  if (objective !== "min_compliance" && objective !== "min_volume")
    throw new Error(
      `unknown topology-optimization objective "${String(objective)}" — expected "min_compliance" or "min_volume"`,
    );
  const minVolume = objective === "min_volume";
  const bound = minVolume
    ? constraints.complianceLimit
    : constraints.volumeFraction;
  if (!present(bound) && !(minVolume && present(constraints.maxStress)))
    throw new Error(
      minVolume
        ? "the min_volume objective requires constraints.complianceLimit (the compliance ceiling c_allow, > 0), constraints.maxStress (the von Mises limit sigma_allow, > 0), or both"
        : "the min_compliance objective requires constraints.volumeFraction (the target material fraction, in (0, 1])",
    );
  return present(bound) ? bound : undefined;
}

// What a run returns: the element densities, and for the level-set method
// φ per vertex in store node order (buildVertexIndexer), which the viewport
// contours at φ = 0. `converged` is false when the run stopped at its
// iteration limit (KOF-412): its design is not an optimum. `iterations` is
// how many it ran; a capped run that fell back to an earlier feasible design
// ran more than its history keeps.
export interface TopOptRunResult {
  density: Float64Array;
  levelSet?: Float64Array;
  history: TopOptHistoryEntry[];
  converged: boolean;
  iterations: number;
}

// The level-set run's arguments from the wire settings, refused with the
// engine's messages: the method takes minimum compliance only, without a
// stress limit (topology_simp.cpp).
function levelSetArguments(settings: TopOptSettings): {
  volumeFraction: number;
  maxIterations: number;
  streamEvery: number;
  passiveSolid: Uint32Array;
  passiveVoid: Uint32Array;
} {
  const bound = objectiveBound(settings);
  if (present(settings.constraints.maxStress) || present(settings.stress))
    throw new Error(
      "the level-set method does not support the maximum-stress constraint (constraints.maxStress) — remove the stress limit, or use SIMP for a stress-constrained run",
    );
  if (settings.objective !== "min_compliance" || bound === undefined)
    throw new Error(
      "the level-set method supports the min_compliance objective only — switch the objective to minimum compliance, or use SIMP for min_volume",
    );
  const { passive } = settings;
  return {
    volumeFraction: bound,
    maxIterations: requirePositiveInteger(
      settings.maxIterations,
      "maxIterations",
    ),
    streamEvery: streamEveryOf(settings),
    passiveSolid: Uint32Array.from(passive?.solid ?? []),
    passiveVoid: Uint32Array.from(passive?.void ?? []),
  };
}

function streamEveryOf(settings: TopOptSettings): number {
  return requirePositiveInteger(
    // eslint-disable-next-line kofem/no-silent-fallback -- streamEvery is optional in TopOptSettings; the documented default streams every iteration
    settings.streamEvery ?? DEFAULT_STREAM_EVERY,
    "streamEvery",
  );
}

// The second header line of a level-set run, as the engine prints it.
function describeLevelSetUpdate(run: TopologyRun): string {
  const update = run.levelSetUpdate;
  if (update === undefined)
    throw new Error("The run is not a level-set optimization.");
  const [timeStep, volumeStep, eminRel] = update;
  const ell = run.filterRadius;
  return (
    `[topopt] level set: l=${general(ell, 4)} (tau=${general(ell * ell, 4)}), ` +
    `dt=${general(timeStep, 3)}, volume step=${general(volumeStep, 3)}, ` +
    `E_min/E0=${eminRel.toExponential(1)}`
  );
}

// Translate the wire settings into the Rust settings, with the engine's
// rules and messages for missing or contradictory fields. Returns the
// settings and the run header the engine logs.
function buildSettings(
  fem: { TopologySettings: typeof TopologySettings },
  settings: TopOptSettings,
): {
  rust: TopologySettings;
  header: string;
  penalty: number;
  moveLimit: number;
} {
  const { objective, constraints } = settings;
  const bound = objectiveBound(settings);
  if (methodOf(settings) !== "simp")
    throw new Error(
      "The level-set method runs on solid models only (optimizeSolidInRust).",
    );
  const minVolume = objective === "min_volume";
  const { maxStress } = constraints;
  if (!present(maxStress) && present(settings.stress))
    throw new Error(
      "the stress block (aggregation settings) needs constraints.maxStress — there is no stress limit to tune",
    );

  // eslint-disable-next-line kofem/no-silent-fallback -- penalty is optional in TopOptSettings; the documented default is p = 3
  const penalty = settings.penalty ?? DEFAULT_PENALTY;
  // eslint-disable-next-line kofem/no-silent-fallback -- moveLimit is optional in TopOptSettings; the documented default is 0.2
  const moveLimit = settings.moveLimit ?? DEFAULT_MOVE_LIMIT;
  const maxIterations = requirePositiveInteger(
    settings.maxIterations,
    "maxIterations",
  );
  const streamEvery = streamEveryOf(settings);
  const rust = new fem.TopologySettings(
    objective,
    minVolume ? undefined : bound,
    minVolume ? bound : undefined,
    penalty,
    settings.filterRadius,
    moveLimit,
    maxIterations,
    settings.tolerance,
    present(maxStress) ? STRESS_RHO_MIN : 0,
    streamEvery,
  );
  try {
    let stressNote = "";
    if (present(maxStress)) {
      if (!Number.isFinite(maxStress) || maxStress <= 0)
        throw new Error("constraints.maxStress must be a finite stress > 0");
      const block = settings.stress;
      // eslint-disable-next-line kofem/no-silent-fallback -- the stress block and its fields are optional in TopOptSettings; the documented aggregation is the P-norm
      const aggregation = block?.aggregation ?? "pnorm";
      const parameter =
        block?.p ?? (aggregation === "ks" ? DEFAULT_KS_P : DEFAULT_PNORM_P);
      const relaxation = block?.q ?? penalty - 0.5;
      rust.setStressLimit(maxStress, aggregation, parameter, relaxation);
      stressNote = ` + max_stress sigma_allow=${general(maxStress, 6)} (${aggregation} P=${general(parameter, 3)}, q=${general(relaxation, 3)})`;
    }
    if (present(settings.passive))
      rust.setPassive(
        Uint32Array.from(settings.passive.solid ?? []),
        Uint32Array.from(settings.passive.void ?? []),
      );
    // Without a bound only a stress-limited min_volume run gets this far.
    const formulation = !present(bound)
      ? "min_volume"
      : minVolume
        ? `min_volume c_allow=${general(bound, 6)}`
        : `min_compliance volfrac=${bound.toFixed(3)}`;
    return {
      rust,
      header: `${formulation}${stressNote}`,
      penalty,
      moveLimit,
    };
  } catch (error) {
    release(rust);
    throw error;
  }
}

// The progress line the engine prints per iteration (parseTopOptLogLine).
function iterationLine(entry: TopOptHistoryEntry): string {
  const line = `[topopt] it ${entry.it}: c=${general(entry.compliance, 6)} vol=${entry.volume.toFixed(4)} change=${general(entry.max_change, 4)}`;
  return entry.stress === undefined || entry.max_stress === undefined
    ? line
    : `${line} sigma=${general(entry.stress, 6)} sigma_max=${general(entry.max_stress, 6)}`;
}

// Optimize an all-solid model of linear tetrahedra and hexahedra (one design
// density per element, tets first, then hexes) in Rust, with SIMP or, for
// method "level_set", the level-set method, which also returns φ per store
// node. Ties are not applied to the design domain, as on the engine path.
// `onDensity` receives the design every `streamEvery` iterations and always
// on the last, whose field is the returned density. Throws on an ill-posed
// problem, with the engine's message.
export function optimizeSolidInRust(
  fem: TopologyFemModule,
  payload: TopOptPayload,
  log: (line: string) => void,
  onDensity: (iteration: number, density: Float64Array) => void,
): TopOptRunResult {
  const { settings } = payload;
  const levelSet = methodOf(settings) === "level_set";
  // Refuse the settings before the model is built, as the engine does.
  const levelSetArgs = levelSet ? levelSetArguments(settings) : null;
  if (payload.elements.some((e) => e.type !== "CTETRA" && e.type !== "CHEXA"))
    throw new Error(
      "The Rust optimizer takes solid models of tetrahedra and hexahedra only.",
    );
  const vid = buildVertexIndexer(payload.nodes);
  const { elastic, tetCount, hexCount } = createRustSolidModel(
    fem,
    payload,
    1,
    vid,
  );
  try {
    const { fixedDofs, fixedValues, forces } = rustSolidBoundaryConditions(
      elastic,
      payload,
      vid,
    );
    if (levelSetArgs !== null) {
      const run = fem.TopologyRun.levelSetMethod(
        elastic,
        fixedDofs,
        fixedValues,
        forces,
        levelSetArgs.volumeFraction,
        settings.filterRadius,
        levelSetArgs.maxIterations,
        settings.tolerance,
        levelSetArgs.streamEvery,
        levelSetArgs.passiveSolid,
        levelSetArgs.passiveVoid,
      );
      try {
        log(
          `[topopt] level_set min_compliance volfrac=${levelSetArgs.volumeFraction.toFixed(3)}: ` +
            `${describeSolidElements(tetCount, hexCount)}, ${run.dofCount} dofs, ` +
            `l=${general(run.filterRadius, 4)}, maxit=${levelSetArgs.maxIterations}, ` +
            `tol=${general(settings.tolerance, 4)} — solving with Rust multigrid CG`,
        );
        log(describeLevelSetUpdate(run));
        return runToCompletion(run, settings.objective, log, onDensity);
      } finally {
        release(run);
      }
    }
    return runRust(
      fem,
      settings,
      (rust) =>
        new fem.TopologyRun(elastic, fixedDofs, fixedValues, forces, rust),
      (run, header, penalty, moveLimit) =>
        `[topopt] ${header}: ${describeSolidElements(tetCount, hexCount)}, ${run.dofCount} dofs, ` +
        `${describeLoop(run, settings, penalty, moveLimit)} — solving with Rust multigrid CG`,
      log,
      onDensity,
    );
  } finally {
    release(elastic);
  }
}

// Build the run with `start`, log its header and step it to completion,
// freeing the Rust settings and run on every path.
function runRust(
  fem: { TopologySettings: typeof TopologySettings },
  settings: TopOptSettings,
  start: (rust: TopologySettings) => TopologyRun,
  describe: (
    run: TopologyRun,
    header: string,
    penalty: number,
    moveLimit: number,
  ) => string,
  log: (line: string) => void,
  onDensity: (iteration: number, density: Float64Array) => void,
): TopOptRunResult {
  const { rust, header, penalty, moveLimit } = buildSettings(fem, settings);
  let run: TopologyRun;
  try {
    run = start(rust);
  } finally {
    release(rust);
  }
  try {
    log(describe(run, header, penalty, moveLimit));
    return runToCompletion(run, settings.objective, log, onDensity);
  } finally {
    release(run);
  }
}

// The run header's tail: penalty, filter, move limit, cap and tolerance.
function describeLoop(
  run: TopologyRun,
  settings: TopOptSettings,
  penalty: number,
  moveLimit: number,
): string {
  return (
    `p=${penalty.toFixed(2)}, r_min=${general(run.filterRadius, 4)}, ` +
    `move=${moveLimit.toFixed(3)}, maxit=${settings.maxIterations}, ` +
    `tol=${general(settings.tolerance, 4)}`
  );
}

// Optimize the facets of a pure-shell model (one design density per facet)
// with SIMP in Rust. Takes the payload the engine's solve_shell and
// optimize_topology_shell read (buildShellEngineInputs), so the engine stays
// the test oracle. Several shell materials keep their stiffness ratios.
// Throws on an ill-posed problem, with the engine's message where it has
// one.
export function optimizeShellInRust(
  fem: ShellTopologyFemModule,
  inputs: { mesh: ShellMesh; matJson: string; bcsJson: string },
  settings: TopOptSettings,
  log: (line: string) => void,
  onDensity: (iteration: number, density: Float64Array) => void,
): TopOptRunResult {
  const { model, bcs, forces, nodeCount, triangleCount } = createShellModel(
    fem,
    inputs,
  );
  try {
    return runRust(
      fem,
      settings,
      (rust) =>
        fem.TopologyRun.shell(
          model,
          Uint32Array.from(bcs.fixedDofs),
          Float64Array.from(bcs.fixedValues),
          forces,
          rust,
          SHELL_CG_TOLERANCE,
        ),
      (run, header, penalty, moveLimit) =>
        `[topopt] shell ${header}: ${triangleCount} facets, ${nodeCount} nodes, ` +
        `${run.dofCount} dofs, ${describeLoop(run, settings, penalty, moveLimit)} — ` +
        "solving with Rust IC(0) CG",
      log,
      onDensity,
    );
  } finally {
    release(model);
  }
}

// Optimize a coupled model — tets and shell facets over one node pool,
// joined by couplings that are not design variables — with SIMP in Rust
// (one density per element, tets first, then facets). Takes the arguments
// the engine's solve_coupled and optimize_topology_coupled read
// (buildCoupledEngineInputs). Throws on an ill-posed problem.
export function optimizeCoupledInRust(
  fem: CoupledTopologyFemModule,
  args: CoupledEngineArgs,
  settings: TopOptSettings,
  log: (line: string) => void,
  onDensity: (iteration: number, density: Float64Array) => void,
): TopOptRunResult {
  const { model, couplings, fixedDofs, fixedValues, forces } = createMixedModel(
    fem,
    args,
  );
  try {
    return runRust(
      fem,
      settings,
      (rust) =>
        fem.TopologyRun.coupled(
          model,
          couplings,
          fixedDofs,
          fixedValues,
          forces,
          rust,
          SHELL_CG_TOLERANCE,
          "incomplete-cholesky",
        ),
      (run, header, penalty, moveLimit) =>
        `[topopt] coupled ${header}: ${args.mesh.tets.length / 4} tets + ` +
        `${args.mesh.triangles.length / 3} facets, ${model.vertexCount} nodes, ` +
        `${args.coupling.ref.length} couplings, ${run.dofCount} dofs, ` +
        `${describeLoop(run, settings, penalty, moveLimit)} — solving with Rust IC(0) CG`,
      log,
      onDensity,
    );
  } finally {
    release(couplings);
    release(model);
  }
}

// Step `run` until it finishes, logging every iteration and streaming the
// design when the run asks to.
function runToCompletion(
  run: TopologyRun,
  objective: TopOptSettings["objective"],
  log: (line: string) => void,
  onDensity: (iteration: number, density: Float64Array) => void,
): TopOptRunResult {
  const history: TopOptHistoryEntry[] = [];
  let converged = false;
  let iterations = 0;
  for (;;) {
    const step = run.step();
    try {
      const stress = step.stress;
      const maxStress = step.maxStress;
      const entry: TopOptHistoryEntry = {
        it: step.iteration,
        objective: objective === "min_volume" ? step.volume : step.compliance,
        compliance: step.compliance,
        volume: step.volume,
        max_change: step.maxChange,
        ...(stress === undefined ? {} : { stress }),
        ...(maxStress === undefined ? {} : { max_stress: maxStress }),
      };
      history.push(entry);
      log(iterationLine(entry));
      const note = step.note;
      if (note !== undefined) log(`[topopt] ${note}`);
      if (step.stream) onDensity(step.densityIteration, run.density);
      if (step.finished) {
        converged = step.converged;
        iterations = step.iteration;
        break;
      }
    } finally {
      release(step);
    }
  }
  // A capped run that fell back to its last feasible design drops the steps
  // after it, as the engine's history does.
  history.length = run.historyLength;
  const density = run.density;
  const levelSet = run.levelSet;
  const returning =
    levelSet === undefined
      ? `${density.length} densities`
      : `${density.length} densities and ${levelSet.length} level-set values`;
  log(
    `[topopt] complete: ${history.length} iteration(s), ${converged ? "converged" : "hit max_iterations"}; returning ${returning}`,
  );
  return levelSet === undefined
    ? { density, history, converged, iterations }
    : { density, levelSet, history, converged, iterations };
}
