// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Static solve through the Rust finite-element module (crates/kofem-wasm) with
// the smoothed-aggregation multigrid (AMG) or the symmetric Gauss–Seidel
// preconditioner, and the rule for which models it covers (the same for both:
// amgUnavailableReason). The Rust module handles linear and quadratic
// tetrahedra and hexahedra (alone or mixed) with per-body materials, supports
// (fixed, roller, prescribed), nodal loads and surface loads on triangular and
// quadrilateral faces, surface-to-point couplings on linear and quadratic
// tetrahedra, and constraint (MPC) ties on all of these (KOF-318; only Rust
// solves them). Shells mixed with tets take the Rust mixed solve
// (coupledRust.ts, linear tets only) with AMG too. Pure-shell models take the
// Rust shell solve (shellRust.ts), and bodies solved as shells and couplings
// AMG cannot take go to the coupled solver, both preconditioned with
// incomplete Cholesky.
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
  Ties,
} from "../../wasm/fem/kofem_wasm.js";
import type { TieConstraint } from "../tieConstraints.js";
import {
  groupDirichlet,
  groupPointLoads,
  packSolveMesh,
  resolveMaterials,
  type VertexIndexer,
} from "../solveMeshPacking.js";
import { surfaceLoadsToVertices } from "./bcs.js";
import { rustTieTables } from "./solid.js";
import { shellMarkedBodies } from "./autoShell.js";
import type { EngineCoupledBcs, EngineCoupling } from "./coupled.js";
import { iterateToConvergence, type ContinuationPrompt } from "./cgRun.js";

export type { ContinuationPrompt } from "./cgRun.js";

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

// The method in words for the solve log.
const METHOD_LABEL: Record<SolverMethod, string> = {
  amg: "AMG",
  "gauss-seidel": "Gauss–Seidel",
};

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
  const shellCount = model.elements.filter(
    (element) => element.type === "CTRIA3",
  ).length;
  if (shellCount > 0 && shellCount === model.elements.length)
    return "it does not support shell-only models";
  if (
    model.elements.some(
      (element) =>
        element.type !== "CTETRA" &&
        element.type !== "CHEXA" &&
        element.type !== "CTRIA3",
    )
  )
    return "it supports tetrahedral and hexahedral meshes only";
  // Shells mixed with tets take the Rust mixed solve (coupledRust.ts), which
  // is linear tets + DKT facets with every coupling, whatever the element
  // order (as the engine's solve_coupled).
  if (shellCount > 0)
    return model.elements.some((element) => element.type === "CHEXA")
      ? "it supports shells mixed with tetrahedra only"
      : null;
  // The coupled model is built by the coupled solver's input builder, which
  // takes tetrahedra only.
  if (
    model.couplingCount > 0 &&
    model.elements.some((element) => element.type === "CHEXA")
  )
    return "it supports surface-to-point couplings on tetrahedral meshes only";
  if (shellMarkedBodies(model.properties).length > 0)
    return "it does not support bodies solved as shells";
  return null;
}

// The preconditioner a solve uses when AMG is not chosen or cannot take the
// model. Shell elements, bodies solved as shells and surface-to-point
// couplings route to the shell or coupled solver, which use incomplete
// Cholesky IC(0) (SSOR only if the factorisation breaks down); every other
// model solves with the MFEM engine's Gauss–Seidel CG. Mirrors routeSolve
// (route.ts).
export type FallbackPreconditioner = "incomplete-cholesky" | "gauss-seidel";

export function amgFallbackPreconditioner(model: {
  elements: Element[];
  properties: Property[];
  couplingCount: number;
}): FallbackPreconditioner {
  if (
    model.elements.some((element) => element.type === "CTRIA3") ||
    model.couplingCount > 0 ||
    shellMarkedBodies(model.properties).length > 0
  )
    return "incomplete-cholesky";
  return "gauss-seidel";
}

// The fallback preconditioner in words for the user.
export const FALLBACK_PRECONDITIONER_LABEL: Record<
  FallbackPreconditioner,
  string
> = {
  "incomplete-cholesky": "an incomplete Cholesky preconditioner",
  "gauss-seidel": "Gauss–Seidel",
};

// The classes of the Rust module the solve needs, passed in so the worker and
// the node-side tests can each load the module their own way.
export interface FemModule {
  ElasticModel: typeof ElasticModel;
  SolveOptions: typeof SolveOptions;
}

// The solid solve needs the tie tables too, for constraint ties.
export interface SolidFemModule extends FemModule {
  Ties: typeof Ties;
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
  // The constraint-tie equations of the model's "mpc" connections
  // (weldTies), in original node ids; absent or empty when it has none.
  constraintTies?: TieConstraint[];
}

// The CG budget when the solve request names none — the MFEM path's cap. AMG
// converges in tens to a few hundred iterations, so reaching it is rare; when
// it happens the user is asked whether to go on, as on the MFEM path.
const DEFAULT_ITERATION_LIMIT = 5000;
// Progress is logged every this many iterations, as the MFEM path does.
const LOG_EVERY = 10;
// Stop on the force residual ‖f − K·u‖ / ‖f‖, which means the same accuracy
// whatever the preconditioner (see StoppingRule in crates/kofem-fem/src/cg.rs).
const RELATIVE_TOLERANCE = 1e-6;

// Solve one all-solid model of tetrahedra and hexahedra in Rust, with
// elements of `elementOrder` (1 linear, 2 quadratic) and CG preconditioned by
// `method`. `vid` indexes element
// connectivity; `refVid` resolves constraint, load and surface-face node
// references (a tie maps them to their representative first). Returns one
// displacement triple per node of `model.nodes` and one von Mises stress per
// element, tets first, then hexes — the same layout as the MFEM solve.
// Quadratic elements add edge (and hex face and centre) nodes inside the Rust
// module, as MFEM's order-2 space does; their displacements stay there.
// Constraint ties (`model.constraintTies`) are eliminated in the same solve;
// on quadratic elements their tied surface's edge and face nodes come along.
export async function solveSolidInRust(
  fem: SolidFemModule,
  model: AmgSolidModel,
  elementOrder: number,
  method: SolverMethod,
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
    throw new Error(`The Rust solver cannot solve this model: ${reason}.`);

  const { elastic, tetCount, hexCount } = createRustSolidModel(
    fem,
    model,
    elementOrder,
    vid,
  );
  try {
    if (elastic.vertexCount !== model.nodes.length)
      throw new Error(
        `The AMG solver received ${elastic.vertexCount} vertices for ${model.nodes.length} nodes`,
      );
    const started = performance.now();
    const nonzeros = elastic.assemble();
    log(
      `${METHOD_LABEL[method]} solve: ${model.nodes.length} nodes, ${describeSolidElements(tetCount, hexCount)} (order ${elementOrder}), ` +
        `${elastic.dofCount} unknowns, ${nonzeros} stiffness entries assembled`,
    );
    const { fixedDofs, fixedValues, forces } = rustSolidBoundaryConditions(
      elastic,
      model,
      refVid,
      log,
    );

    const constraintTies = model.constraintTies ?? [];
    const start =
      constraintTies.length === 0
        ? (options: SolveOptions) =>
            elastic.startSolve(fixedDofs, fixedValues, forces, options)
        : (options: SolveOptions) => {
            const tables = rustTieTables(constraintTies, refVid);
            const ties = new fem.Ties(
              tables.slaves,
              tables.offsets,
              tables.masters,
              tables.weights,
              tables.interfaces,
            );
            try {
              const run = elastic.startTiedSolve(
                ties,
                fixedDofs,
                fixedValues,
                forces,
                options,
              );
              const prescribedNote =
                run.tiePrescribed > 0
                  ? `, ${run.tiePrescribed} tied DOF(s) also fixed or prescribed — the support applies there`
                  : "";
              log(
                `Tie constraints: ${run.tiedNodes} tied node(s), ${run.tieEliminated} DOF(s) eliminated${prescribedNote}`,
              );
              return run;
            } finally {
              ties.free();
            }
          };
    return await runRustSolve(
      fem,
      method,
      iterationLimit,
      start,
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

// The solid model of tetrahedra and hexahedra (tets first, then hexes, as
// buildSolidEngineInputs packs them for MFEM) as a Rust ElasticModel with
// elements of `elementOrder`. `vid` indexes element connectivity. The caller
// frees the model.
export function createRustSolidModel(
  fem: Pick<FemModule, "ElasticModel">,
  model: Pick<AmgSolidModel, "nodes" | "elements" | "materials" | "properties">,
  elementOrder: number,
  vid: VertexIndexer,
): { elastic: ElasticModel; tetCount: number; hexCount: number } {
  const tetElements = model.elements.filter((e) => e.type === "CTETRA");
  const hexElements = model.elements.filter((e) => e.type === "CHEXA");
  const mesh = packSolveMesh(model.nodes, tetElements, hexElements, vid);
  const { materials, attributes } = resolveMaterials(
    [...tetElements, ...hexElements],
    model.materials,
    model.properties,
  );
  // resolveMaterials numbers materials from 1 (the MFEM attribute contract);
  // the Rust module indexes them from 0.
  const materialOfElement = Uint32Array.from(attributes, (index) => index - 1);
  const elastic = new fem.ElasticModel(
    mesh.vertices,
    Uint32Array.from(mesh.tetrahedra),
    Uint32Array.from(mesh.hexahedra),
    materialOfElement,
    Float64Array.from(
      materials.flatMap((material) => [
        material.young_modulus,
        material.poisson_ratio,
      ]),
    ),
    elementOrder,
  );
  return {
    elastic,
    tetCount: tetElements.length,
    hexCount: hexElements.length,
  };
}

// The element kinds a model has, e.g. "24 tetrahedra and 4 hexahedra".
export function describeSolidElements(
  tetCount: number,
  hexCount: number,
): string {
  return [[tetCount, "tetrahedra"] as const, [hexCount, "hexahedra"] as const]
    .filter(([count]) => count !== 0)
    .map(([count, kind]) => `${count} ${kind}`)
    .join(" and ");
}

// The supports (3·vertex + component, with their prescribed values) and the
// nodal forces (3 per node of `elastic`) of a solid model: point loads, and
// surface loads integrated by the Rust module. `refVid` resolves constraint,
// load and surface-face node references.
export function rustSolidBoundaryConditions(
  elastic: ElasticModel,
  model: Pick<AmgSolidModel, "constraints" | "loads" | "surfaceLoads">,
  refVid: VertexIndexer,
  log: (line: string) => void,
): { fixedDofs: Uint32Array; fixedValues: Float64Array; forces: Float64Array } {
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
  addSurfaceLoads(
    elastic,
    forces,
    surfaceLoadsToVertices(model.surfaceLoads, refVid),
    log,
  );
  return {
    fixedDofs: Uint32Array.from(fixedDofList),
    fixedValues: Float64Array.from(fixedValueList),
    forces,
  };
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
  // The loads split for an order-2 solve: point loads (6·pool+dof) and
  // surface loads over pool-index faces, which Rust integrates itself.
  pointLoads: Pick<EngineCoupledBcs, "load_dofs" | "load_vals">;
  poolSurfaceLoads: SurfaceLoad[];
  // One material per 1-based `mesh.attributes` value.
  solidMaterials: { young_modulus: number; poisson_ratio: number }[];
}

// Solve an all-solid model with surface-to-point couplings in Rust — what
// the engine's solve_coupled does for it, with elements of `elementOrder` (1
// linear, 2 quadratic) and CG preconditioned by `method`. Returns the same fields: three translations per pool
// node and one von Mises stress per tet (no shell facets).
//
// The engine's coupled solve is linear only. At order 1 the forces are its
// own nodal loads, surface loads lumped onto the corners, so both solvers take
// the identical model. At order 2 a surface load must reach the edge nodes,
// so Rust integrates it over the 6-node faces as the MFEM solid solve does;
// the couplings and supports name vertices, and the Rust module
// (crates/kofem-fem/src/coupled_static.rs) extends kinematic couplings and
// supports to the edge nodes; a distributing coupling keeps its corner nodes,
// as at order 1.
export async function solveCoupledSolidInRust(
  fem: CoupledFemModule,
  input: AmgCoupledInputs,
  elementOrder: number,
  method: SolverMethod,
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
      "The Rust solver cannot solve this model: it does not support shell elements.",
    );
  if (elementOrder !== 1 && elementOrder !== 2)
    throw new Error(
      `The Rust solver cannot solve this model: element order ${elementOrder} is not 1 or 2.`,
    );
  const elastic = new fem.ElasticModel(
    mesh.vertices,
    Uint32Array.from(mesh.tets),
    new Uint32Array(0),
    // The coupled assembler numbers materials from 1; Rust from 0.
    Uint32Array.from(mesh.attributes, (attribute) => attribute - 1),
    Float64Array.from(
      solidMaterials.flatMap((material) => [
        material.young_modulus,
        material.poisson_ratio,
      ]),
    ),
    elementOrder,
  );
  try {
    const started = performance.now();
    const nonzeros = elastic.assemble();
    const pointCount = elastic.vertexCount;
    // Vertices, then (order 2) one node per edge.
    const nodeCount = elastic.dofCount / 3;
    log(
      `${METHOD_LABEL[method]} solve: ${pointCount} nodes, ${mesh.tets.length / 4} tetrahedra ` +
        `(order ${elementOrder}), ${coupling.ref.length} couplings, ` +
        `${nonzeros} stiffness entries assembled`,
    );
    const couplings = new fem.Couplings(
      Uint32Array.from(coupling.ref),
      Uint32Array.from(coupling.offsets),
      Uint32Array.from(coupling.solid),
      Int32Array.from(coupling.mpc),
      Uint32Array.from(coupling.dof_mask),
      // eslint-disable-next-line kofem/no-silent-fallback -- weights are optional in the coupling set; absent means equal weights, as for solve_coupled
      coupling.weights ?? new Float64Array(0),
      coupling.relaxation,
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
      const forces = new Float64Array(perVertex * nodeCount);
      const addLoads = (
        loads: Pick<EngineCoupledBcs, "load_dofs" | "load_vals">,
      ) =>
        loads.load_dofs.forEach((dof, index) => {
          if (dof < 0 || dof >= perVertex * pointCount)
            throw new Error(
              `Load DOF ${dof} is out of range (the model has ${perVertex * pointCount})`,
            );
          forces[dof] += loads.load_vals[index];
        });
      if (elementOrder === 1) addLoads(bcs);
      else {
        addLoads(input.pointLoads);
        const translations = new Float64Array(elastic.dofCount);
        addSurfaceLoads(elastic, translations, input.poolSurfaceLoads, log);
        for (let node = 0; node < nodeCount; node++)
          for (let component = 0; component < 3; component++)
            forces[perVertex * node + component] +=
              translations[3 * node + component];
      }
      return await runRustSolve(
        fem,
        method,
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
          // One triple per node: the pool vertices first, then any edge nodes.
          const nodal = solution.displacements;
          return {
            displacements: nodal.slice(0, 3 * pointCount),
            von_mises_tets: elastic.vonMises(nodal),
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

// Set up the run with `start`, preconditioned by `method`, advance it to
// convergence (asking to go on past the iteration budget) and read the result
// with `read`. Frees the options, the run and the solution whatever happens.
async function runRustSolve<T>(
  fem: FemModule,
  method: SolverMethod,
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
    method,
    "residual",
  );
  // The hierarchy is built in one call; on large models that takes seconds,
  // so say what is happening before it starts.
  if (method === "amg") log("Building the AMG preconditioner…");
  let run: SolveRun;
  try {
    run = start(options);
  } finally {
    options.free();
  }
  if (method === "amg")
    log(
      `AMG preconditioner ready: multigrid levels [${Array.from(run.levelSizes).join(", ")}] unknowns`,
    );
  let finished = false;
  try {
    await iterateToConvergence(
      run,
      {
        initialBudget: budget,
        logEvery: LOG_EVERY,
        tag: `[${method}]`,
        started,
      },
      askToContinue,
      log,
    );
    finished = true;
    const solution = run.finish();
    try {
      const result = read(solution);
      const seconds = (performance.now() - started) / 1000;
      log(
        `${METHOD_LABEL[method]} CG converged: ${solution.iterations} iterations, force residual ` +
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

// Add the work-equivalent nodal forces of `surfaceLoads` (faces as vertex
// indices) to `forces` (3 per node), warning about faces off the boundary.
function addSurfaceLoads(
  elastic: ElasticModel,
  forces: Float64Array,
  surfaceLoads: SurfaceLoad[],
  log: (line: string) => void,
): void {
  surfaceLoads.forEach((surfaceLoad, index) => {
    // Tet faces are triangles, hex faces quadrilaterals.
    const triangles: number[] = [];
    const quadrilaterals: number[] = [];
    surfaceLoad.faces.forEach((face, faceIndex) => {
      if (face.length === 3) triangles.push(...face);
      else if (face.length === 4) quadrilaterals.push(...face);
      else
        throw new Error(
          `Surface load ${index}: face ${faceIndex} has ${face.length} nodes — ` +
            "a solid mesh has triangular (tetrahedron) and quadrilateral " +
            "(hexahedron) faces only",
        );
    });
    const unmatched = elastic.addSurfaceLoad(
      forces,
      index,
      Uint32Array.from(triangles),
      Uint32Array.from(quadrilaterals),
      surfaceLoad.type,
      surfaceLoadValues(surfaceLoad, index),
    );
    if (unmatched > 0)
      log(
        `WARNING: surface load ${index}: ${unmatched} of ${surfaceLoad.faces.length} ` +
          "selected face(s) are not on the mesh boundary and carry no load — " +
          "check for stale or interior face selections",
      );
  });
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
