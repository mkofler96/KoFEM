// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Static solve through the Rust finite-element module (crates/kofem-wasm) with
// the smoothed-aggregation multigrid (AMG) preconditioner, and the rule for
// which models it covers. The Rust module handles linear and quadratic
// tetrahedra with per-body materials, supports (fixed, roller, prescribed),
// nodal loads and surface loads, and surface-to-point couplings on linear
// tetrahedra; anything else (hex elements, shells) still solves with the MFEM
// engine's Gauss–Seidel CG, and the solve says so.
//
// The inputs are built by the same helpers as the MFEM payload
// (packSolveMesh, resolveMaterials, groupDirichlet, groupPointLoads,
// surfaceLoadsToVertices for the solid solve; buildCoupledEngineInputs for a
// model with couplings), so both solvers see an identical model.

import type {
  Constraint,
  Element,
  Load,
  Material,
  Node,
  Property,
  SurfaceLoad,
} from "../../workers/solverTypes.js";
import type {
  Couplings,
  ElasticModel,
  ElasticSolution,
  SolveOptions,
  SolveRun,
} from "../../wasm/fem/kofem_wasm.js";
import type { CgLimitProgress } from "../../wasm/pkg/kofem_wasm.js";
import {
  groupDirichlet,
  groupPointLoads,
  packSolveMesh,
  resolveMaterials,
  type VertexIndexer,
} from "../solveMeshPacking.js";
import { surfaceLoadsToVertices } from "./bcs.js";
import { shellMarkedBodies } from "./autoShell.js";
import type { EngineCoupledBcs, EngineCoupling } from "./coupled.js";

export type SolverMethod = "amg" | "gauss-seidel";

// The options the Solve panel offers, AMG first as the recommended default.
export const SOLVER_METHODS: readonly {
  value: SolverMethod;
  label: string;
}[] = [
  { value: "amg", label: "AMG multigrid (recommended)" },
  { value: "gauss-seidel", label: "Gauss–Seidel" },
];

export const DEFAULT_SOLVER_METHOD: SolverMethod = "amg";

export function isSolverMethod(value: unknown): value is SolverMethod {
  return value === "amg" || value === "gauss-seidel";
}

// Why the AMG solver cannot take this model, in words for the user, or null
// when it can. Shared by the Solve panel (to say so before the solve) and the
// worker (to route the solve), so the two cannot disagree.
export function amgUnavailableReason(model: {
  elements: Element[];
  properties: Property[];
  elementOrder: number;
  couplingCount: number;
}): string | null {
  if (model.elementOrder !== 1 && model.elementOrder !== 2)
    return "it supports linear and quadratic elements only";
  if (model.elements.some((element) => element.type === "CTRIA3"))
    return "it does not support shell elements";
  if (model.elements.some((element) => element.type !== "CTETRA"))
    return "it supports tetrahedral meshes only";
  // A coupling ties the corner nodes of the picked faces; the edge nodes of
  // quadratic elements would not follow (the MFEM coupled path solves such a
  // model with linear elements).
  if (model.couplingCount > 0 && model.elementOrder !== 1)
    return "it supports surface-to-point couplings on linear elements only";
  if (shellMarkedBodies(model.properties).length > 0)
    return "it does not support bodies solved as shells";
  return null;
}

// The two classes of the Rust module the solve needs, passed in so the worker
// and the node-side tests can each load the module their own way.
export interface FemModule {
  ElasticModel: typeof ElasticModel;
  SolveOptions: typeof SolveOptions;
}

// The coupled solve needs the coupling set too.
export interface CoupledFemModule extends FemModule {
  Couplings: typeof Couplings;
}

export interface AmgSolidModel {
  nodes: Node[];
  elements: Element[];
  materials: Material[];
  properties: Property[];
  constraints: Constraint[];
  loads: Load[];
  surfaceLoads?: SurfaceLoad[];
}

// The CG budget when the solve request names none — the MFEM path's cap. AMG
// converges in tens to a few hundred iterations, so reaching it is rare; when
// it happens the user is asked whether to go on, as on the MFEM path.
const DEFAULT_ITERATION_LIMIT = 5000;
// Progress is logged every this many iterations, as the MFEM path does.
const LOG_EVERY = 10;
// How long the solve may run without handing control back to the worker's
// event loop, so messages (a continuation answer) are never starved.
const YIELD_AFTER_MS = 200;
// Stop on the force residual ‖f − K·u‖ / ‖f‖, which means the same accuracy
// whatever the preconditioner (see StoppingRule in crates/kofem-fem/src/cg.rs).
const RELATIVE_TOLERANCE = 1e-6;

// Asked when the iteration budget runs out while the residual is still
// falling: resolves to the number of extra iterations, or 0 to stop. The
// worker routes it to the same "continue solving?" dialog as the MFEM path.
export type ContinuationPrompt = (progress: CgLimitProgress) => Promise<number>;

// Solve one all-solid tet model with AMG, with elements of `elementOrder`
// (1 linear, 2 quadratic). `vid` indexes element connectivity; `refVid`
// resolves constraint, load and surface-face node references (a tie maps them
// to their representative first). Returns one displacement triple per node of
// `model.nodes` and one von Mises stress per element, in element order — the
// same layout as the MFEM solve. Quadratic elements add edge nodes inside the
// Rust module, as MFEM's order-2 space does; their displacements stay there.
export async function solveSolidWithAmg(
  fem: FemModule,
  model: AmgSolidModel,
  elementOrder: number,
  vid: VertexIndexer,
  refVid: VertexIndexer,
  iterationLimit: number | undefined,
  askToContinue: ContinuationPrompt,
  log: (line: string) => void,
): Promise<{ displacements: Float64Array; vonMises: Float64Array }> {
  const reason = amgUnavailableReason({
    elements: model.elements,
    properties: model.properties,
    elementOrder,
    couplingCount: 0,
  });
  if (reason !== null)
    throw new Error(`The AMG solver cannot solve this model: ${reason}.`);

  const mesh = packSolveMesh(model.nodes, model.elements, [], vid);
  const { materials, attributes } = resolveMaterials(
    model.elements,
    model.materials,
    model.properties,
  );
  // resolveMaterials numbers materials from 1 (the MFEM attribute contract);
  // the Rust module indexes them from 0.
  const materialOfTet = Uint32Array.from(attributes, (index) => index - 1);
  const elastic = new fem.ElasticModel(
    mesh.vertices,
    Uint32Array.from(mesh.tetrahedra),
    materialOfTet,
    Float64Array.from(
      materials.flatMap((material) => [
        material.young_modulus,
        material.poisson_ratio,
      ]),
    ),
    elementOrder,
  );
  try {
    if (elastic.vertexCount !== model.nodes.length)
      throw new Error(
        `The AMG solver received ${elastic.vertexCount} vertices for ${model.nodes.length} nodes`,
      );
    const started = performance.now();
    const nonzeros = elastic.assemble();
    log(
      `AMG solve: ${model.nodes.length} nodes, ${model.elements.length} tetrahedra ` +
        `(order ${elementOrder}), ${elastic.dofCount} unknowns, ` +
        `${nonzeros} stiffness entries assembled`,
    );

    const { fixed_vertices, fixed_dofs, prescribed_dofs } = groupDirichlet(
      model.constraints,
      refVid,
    );
    const fixedDofList: number[] = [];
    const fixedValueList: number[] = [];
    for (const vertex of fixed_vertices)
      for (let component = 0; component < 3; component++) {
        fixedDofList.push(3 * vertex + component);
        fixedValueList.push(0);
      }
    for (const { vertex, dofs } of fixed_dofs)
      for (const component of dofs) {
        fixedDofList.push(3 * vertex + component);
        fixedValueList.push(0);
      }
    for (const { vertex, dof, value } of prescribed_dofs) {
      fixedDofList.push(3 * vertex + dof);
      fixedValueList.push(value);
    }

    const forces = new Float64Array(elastic.dofCount);
    for (const { vertex, force } of groupPointLoads(model.loads, refVid))
      for (let component = 0; component < 3; component++)
        forces[3 * vertex + component] += force[component];
    surfaceLoadsToVertices(model.surfaceLoads, refVid).forEach(
      (surfaceLoad, index) => {
        const faces = new Uint32Array(3 * surfaceLoad.faces.length);
        surfaceLoad.faces.forEach((face, faceIndex) => {
          if (face.length !== 3)
            throw new Error(
              `Surface load ${index}: face ${faceIndex} has ${face.length} nodes — ` +
                "a tetrahedral mesh has triangular faces only",
            );
          faces.set(face, 3 * faceIndex);
        });
        const unmatched = elastic.addSurfaceLoad(
          forces,
          index,
          faces,
          surfaceLoad.type,
          surfaceLoadValues(surfaceLoad, index),
        );
        if (unmatched > 0)
          log(
            `WARNING: surface load ${index}: ${unmatched} of ${surfaceLoad.faces.length} ` +
              "selected face(s) are not on the mesh boundary and carry no load — " +
              "check for stale or interior face selections",
          );
      },
    );

    return await runAmgSolve(
      fem,
      iterationLimit,
      (options) =>
        elastic.startSolve(
          Uint32Array.from(fixedDofList),
          Float64Array.from(fixedValueList),
          forces,
          options,
        ),
      started,
      askToContinue,
      log,
      (solution) => {
        // One triple per node: the vertices first, then any edge nodes.
        const nodal = solution.displacements;
        return {
          displacements: nodal.slice(0, 3 * elastic.vertexCount),
          vonMises: elastic.vonMises(nodal),
        };
      },
    );
  } finally {
    elastic.free();
  }
}

// What the Rust coupled solve reads: the coupled assembler's inputs
// (CoupledEngineInputs, from buildCoupledEngineInputs) without the shell
// fields, so the MFEM and the Rust solve take the identical model.
export interface AmgCoupledInputs {
  mesh: {
    vertices: Float64Array;
    tets: Int32Array;
    triangles: Int32Array;
    attributes: Int32Array;
  };
  coupling: EngineCoupling;
  bcs: EngineCoupledBcs;
  // One material per 1-based `mesh.attributes` value.
  solidMaterials: { young_modulus: number; poisson_ratio: number }[];
}

// Solve an all-solid model with surface-to-point couplings with AMG — what
// the engine's solve_coupled does for it. Returns the same fields: three
// translations per pool node and one von Mises stress per tet (no shell
// facets).
export async function solveCoupledSolidWithAmg(
  fem: CoupledFemModule,
  input: AmgCoupledInputs,
  iterationLimit: number | undefined,
  askToContinue: ContinuationPrompt,
  log: (line: string) => void,
): Promise<{
  displacements: Float64Array;
  von_mises_tets: Float64Array;
  von_mises_tris: Float64Array;
}> {
  const { mesh, coupling, bcs, solidMaterials } = input;
  if (mesh.triangles.length > 0)
    throw new Error(
      "The AMG solver cannot solve this model: it does not support shell elements.",
    );
  const elastic = new fem.ElasticModel(
    mesh.vertices,
    Uint32Array.from(mesh.tets),
    // The coupled assembler numbers materials from 1; Rust from 0.
    Uint32Array.from(mesh.attributes, (attribute) => attribute - 1),
    Float64Array.from(
      solidMaterials.flatMap((material) => [
        material.young_modulus,
        material.poisson_ratio,
      ]),
    ),
    1,
  );
  try {
    const started = performance.now();
    const nonzeros = elastic.assemble();
    const pointCount = elastic.vertexCount;
    log(
      `AMG solve: ${pointCount} nodes, ${mesh.tets.length / 4} tetrahedra, ` +
        `${coupling.ref.length} couplings, ${nonzeros} stiffness entries assembled`,
    );
    const couplings = new fem.Couplings(
      Uint32Array.from(coupling.ref),
      Uint32Array.from(coupling.offsets),
      Uint32Array.from(coupling.solid),
      Int32Array.from(coupling.mpc),
      Uint32Array.from(coupling.dof_mask),
      // eslint-disable-next-line kofem/no-silent-fallback -- weights are optional in the coupling set; absent means equal weights, as for solve_coupled
      coupling.weights ?? new Float64Array(0),
    );
    try {
      const perVertex = couplings.dofsPerVertex;
      const fixedDofs = Uint32Array.from([
        ...bcs.fixed_dofs,
        ...bcs.prescribed_dofs,
      ]);
      const fixedValues = Float64Array.from([
        ...Array.from(bcs.fixed_dofs, () => 0),
        ...bcs.prescribed_vals,
      ]);
      const forces = new Float64Array(perVertex * pointCount);
      bcs.load_dofs.forEach((dof, index) => {
        if (dof < 0 || dof >= forces.length)
          throw new Error(
            `Load DOF ${dof} is out of range (the model has ${forces.length})`,
          );
        forces[dof] += bcs.load_vals[index];
      });
      return await runAmgSolve(
        fem,
        iterationLimit,
        (options) =>
          elastic.startCoupledSolve(
            couplings,
            fixedDofs,
            fixedValues,
            forces,
            options,
          ),
        started,
        askToContinue,
        log,
        (solution) => {
          const displacements = solution.displacements;
          return {
            displacements,
            von_mises_tets: elastic.vonMises(displacements),
            von_mises_tris: new Float64Array(0),
          };
        },
      );
    } finally {
      couplings.free();
    }
  } finally {
    elastic.free();
  }
}

// Set up the AMG run with `start`, advance it to convergence (asking to go on
// past the iteration budget) and read the result with `read`. Frees the
// options, the run and the solution whatever happens.
async function runAmgSolve<T>(
  fem: FemModule,
  iterationLimit: number | undefined,
  start: (options: SolveOptions) => SolveRun,
  started: number,
  askToContinue: ContinuationPrompt,
  log: (line: string) => void,
  read: (solution: ElasticSolution) => T,
): Promise<T> {
  // eslint-disable-next-line kofem/no-silent-fallback -- cgIterationLimit is optional in the solve message; absent means the solver's own budget, as for the MFEM path
  const budget = iterationLimit ?? DEFAULT_ITERATION_LIMIT;
  const options = new fem.SolveOptions(
    RELATIVE_TOLERANCE,
    budget,
    "amg",
    "residual",
  );
  // The hierarchy is built in one call; on large models that takes seconds,
  // so say what is happening before it starts.
  log("Building the AMG preconditioner…");
  let run: SolveRun;
  try {
    run = start(options);
  } finally {
    options.free();
  }
  log(
    `AMG preconditioner ready: multigrid levels [${Array.from(run.levelSizes).join(", ")}] unknowns`,
  );
  let finished = false;
  try {
    await iterate(run, budget, started, askToContinue, log);
    finished = true;
    const solution = run.finish();
    try {
      const result = read(solution);
      const seconds = (performance.now() - started) / 1000;
      log(
        `AMG CG converged: ${solution.iterations} iterations, force residual ` +
          `${solution.relativeResidual.toExponential(2)}, ${seconds.toFixed(2)} s`,
      );
      return result;
    } finally {
      solution.free();
    }
  } finally {
    // finish() consumes the run; free it only when it was not reached.
    if (!finished) run.free();
  }
}

// Advance the run to convergence: log progress every LOG_EVERY iterations,
// hand control back to the event loop now and then, and when the budget runs
// out either ask to continue (residual still falling) or fail (stalled) — the
// MFEM path's continuation policy (engine/cpp/cg_continuation.h).
async function iterate(
  run: SolveRun,
  initialBudget: number,
  started: number,
  askToContinue: ContinuationPrompt,
  log: (line: string) => void,
): Promise<void> {
  if (!Number.isSafeInteger(initialBudget) || initialBudget <= 0)
    throw new Error(
      `The CG iteration limit must be a positive integer, got ${initialBudget}`,
    );
  // The C++ engine's window: half the first budget, between 2 and 100.
  const window = Math.min(100, Math.max(2, Math.floor(initialBudget / 2)));
  let limit = initialBudget;
  let budget = initialBudget;
  let waitedMs = 0;
  let lastYield = performance.now();
  for (;;) {
    // Stop at the next multiple of LOG_EVERY (or the budget), so progress
    // lines keep their cadence after a pause at an arbitrary budget.
    const steps = Math.min(
      LOG_EVERY - (run.iterations % LOG_EVERY),
      limit - run.iterations,
    );
    const converged = run.advance(steps);
    if (converged) return;
    if (run.iterations % LOG_EVERY === 0)
      log(
        `[amg] CG iteration ${String(run.iterations).padStart(4)}: relative residual ${run.relativeResidual.toExponential(3)}`,
      );
    if (run.iterations >= limit) {
      if (!run.stillDescending(window))
        throw new Error(
          `CG did not converge: relative residual ${run.relativeResidual.toExponential(3)} ` +
            `after ${run.iterations} iterations (target ${run.tolerance.toExponential(0)}) ` +
            "and is no longer improving. The partial result was discarded — check that the " +
            "model is fully constrained, or refine the mesh.",
        );
      const asked = performance.now();
      const extra = await askToContinue({
        iterations: run.iterations,
        relativeResidual: run.relativeResidual,
        target: run.tolerance,
        elapsedSeconds: (asked - started - waitedMs) / 1000,
        suggestedIterations: budget,
      });
      waitedMs += performance.now() - asked;
      lastYield = performance.now();
      if (extra === 0)
        throw new Error(
          "Solve stopped by user. The partial result was discarded.",
        );
      if (!Number.isSafeInteger(extra) || extra < 0 || extra > 1_000_000)
        throw new Error(
          "Extra CG iterations must be an integer from 1 to 1000000",
        );
      log(`Continuing the solve for ${extra} more iterations…`);
      budget = extra;
      limit += extra;
    } else if (performance.now() - lastYield >= YIELD_AFTER_MS) {
      await new Promise((resolve) => setTimeout(resolve, 0));
      lastYield = performance.now();
    }
  }
}

function surfaceLoadValues(
  surfaceLoad: SurfaceLoad,
  index: number,
): Float64Array {
  if (surfaceLoad.type === "pressure") {
    if (surfaceLoad.pressure === undefined)
      throw new Error(`Surface load ${index} (pressure) has no pressure value`);
    return Float64Array.of(surfaceLoad.pressure);
  }
  if (surfaceLoad.force === undefined)
    throw new Error(
      `Surface load ${index} (${surfaceLoad.type}) has no force vector`,
    );
  return Float64Array.from(surfaceLoad.force);
}
