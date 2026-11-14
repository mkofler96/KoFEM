// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// SIMP topology optimization through the Rust module
// (crates/kofem-fem/src/topology, ADR-0002), for all three design domains:
// all-solid models (the engine's optimize_topology, multigrid CG), pure
// shells and coupled shell/solid models (optimize_topology_shell and
// optimize_topology_coupled, IC(0) CG), step for step as the engine. The
// optimizer runs one iteration per TopologyRun.step(), so the "[topopt] it
// N: …" progress lines and the live density stream (KOF-240) come from here
// with the same wording and cadence as from the engine.
//
// The model reaches Rust through the same helpers as the Rust static solves
// (createRustSolidModel, createShellModel, createMixedModel), and the settings keep
// the TopOptSettings wire contract and the engine's defaults. The level-set
// method is not ported yet and stays with the engine (usesRustTopOpt).

import type {
  TopOptHistoryEntry,
  TopOptSettings,
} from "../../wasm/pkg/kofem_wasm.js";
import type {
  ElasticModel,
  TopologyRun,
  TopologySettings,
} from "../../wasm/fem/kofem_wasm.js";
import type { ShellMesh } from "../../wasm/pkg/kofem_wasm.js";
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

// Whether an all-solid optimization with these settings runs in Rust. SIMP
// does; the level-set method is still the engine's.
export function usesRustTopOpt(settings: TopOptSettings): boolean {
  return settings.method !== "level_set";
}

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
  if (objective !== "min_compliance" && objective !== "min_volume")
    throw new Error(
      `unknown topology-optimization objective "${String(objective)}" — expected "min_compliance" or "min_volume"`,
    );
  const minVolume = objective === "min_volume";
  const { maxStress } = constraints;
  const bound = minVolume
    ? constraints.complianceLimit
    : constraints.volumeFraction;
  if (!present(bound) && !(minVolume && present(maxStress)))
    throw new Error(
      minVolume
        ? "the min_volume objective requires constraints.complianceLimit (the compliance ceiling c_allow, > 0), constraints.maxStress (the von Mises limit sigma_allow, > 0), or both"
        : "the min_compliance objective requires constraints.volumeFraction (the target material fraction, in (0, 1])",
    );
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
  const streamEvery = requirePositiveInteger(
    // eslint-disable-next-line kofem/no-silent-fallback -- streamEvery is optional in TopOptSettings; the documented default streams every iteration
    settings.streamEvery ?? DEFAULT_STREAM_EVERY,
    "streamEvery",
  );
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
    rust.free();
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
// density per element, tets first, then hexes) with SIMP in Rust. Ties are
// not applied to the design domain, as on the engine path. `onDensity`
// receives the design every `streamEvery` iterations and always on the
// last, whose field is the returned density. Throws on an ill-posed problem,
// with the engine's message.
export function optimizeSolidInRust(
  fem: TopologyFemModule,
  payload: TopOptPayload,
  log: (line: string) => void,
  onDensity: (iteration: number, density: Float64Array) => void,
): { density: Float64Array; history: TopOptHistoryEntry[] } {
  const { settings } = payload;
  if (!usesRustTopOpt(settings))
    throw new Error(
      `The Rust optimizer does not run the "${String(settings.method)}" method.`,
    );
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
      log,
    );
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
    elastic.free();
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
): { density: Float64Array; history: TopOptHistoryEntry[] } {
  const { rust, header, penalty, moveLimit } = buildSettings(fem, settings);
  let run: TopologyRun;
  try {
    run = start(rust);
  } finally {
    rust.free();
  }
  try {
    log(describe(run, header, penalty, moveLimit));
    return runToCompletion(run, settings.objective, log, onDensity);
  } finally {
    run.free();
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
): { density: Float64Array; history: TopOptHistoryEntry[] } {
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
    model.free();
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
): { density: Float64Array; history: TopOptHistoryEntry[] } {
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
    couplings.free();
    model.free();
  }
}

// Step `run` until it finishes, logging every iteration and streaming the
// design when the run asks to.
function runToCompletion(
  run: TopologyRun,
  objective: TopOptSettings["objective"],
  log: (line: string) => void,
  onDensity: (iteration: number, density: Float64Array) => void,
): { density: Float64Array; history: TopOptHistoryEntry[] } {
  const history: TopOptHistoryEntry[] = [];
  let converged = false;
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
        break;
      }
    } finally {
      step.free();
    }
  }
  // A capped run that fell back to its last feasible design drops the steps
  // after it, as the engine's history does.
  history.length = run.historyLength;
  const density = run.density;
  log(
    `[topopt] complete: ${history.length} iteration(s), ${converged ? "converged" : "hit max_iterations"}; returning ${density.length} densities`,
  );
  return { density, history };
}
