// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Static solve through the Rust finite-element module (crates/kofem-wasm) with
// the smoothed-aggregation multigrid (AMG) preconditioner, and the rule for
// which models it covers. The Rust module handles linear and quadratic
// tetrahedra and hexahedra (alone or mixed) with per-body materials, supports
// (fixed, roller, prescribed), nodal loads and surface loads on triangular and
// quadrilateral faces, and surface-to-point couplings on linear tetrahedra.
// Pure-shell models take the Rust shell solve
// (shellRust.ts), and shells, bodies solved as shells and couplings AMG cannot
// take go to the coupled solver, both preconditioned with incomplete Cholesky.
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
  if (
    model.elements.some(
      (element) => element.type !== "CTETRA" && element.type !== "CHEXA",
    )
  )
    return "it supports tetrahedral and hexahedral meshes only";
  // A coupling ties the corner nodes of the picked faces; the edge nodes of
  // quadratic elements would not follow (the MFEM coupled path solves such a
  // model with linear elements).
  if (model.couplingCount > 0 && model.elementOrder !== 1)
    return "it supports surface-to-point couplings on linear elements only";
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

// The preconditioner a solve uses when AMG cannot take the model. Shell
// elements, bodies solved as shells and surface-to-point couplings (on
// quadratic elements, the case AMG refuses) route to the shell or coupled
// solver, which use incomplete Cholesky IC(0) (SSOR only if
// the factorisation breaks down); every other model solves with the MFEM
// engine's Gauss–Seidel CG. Mirrors routeSolve (route.ts).
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
// Stop on the force residual ‖f − K·u‖ / ‖f‖, which means the same accuracy
// whatever the preconditioner (see StoppingRule in crates/kofem-fem/src/cg.rs).
const RELATIVE_TOLERANCE = 1e-6;

// Solve one all-solid model of tetrahedra and hexahedra with AMG, with
// elements of `elementOrder` (1 linear, 2 quadratic). `vid` indexes element
// connectivity; `refVid` resolves constraint, load and surface-face node
// references (a tie maps them to their representative first). Returns one
// displacement triple per node of `model.nodes` and one von Mises stress per
// element, tets first, then hexes — the same layout as the MFEM solve.
// Quadratic elements add edge (and hex face and centre) nodes inside the Rust
// module, as MFEM's order-2 space does; their displacements stay there.
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

  // Tets first, then hexes, as buildSolidEngineInputs packs them for MFEM.
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
  try {
    if (elastic.vertexCount !== model.nodes.length)
      throw new Error(
        `The AMG solver received ${elastic.vertexCount} vertices for ${model.nodes.length} nodes`,
      );
    const started = performance.now();
    const nonzeros = elastic.assemble();
    log(
      `AMG solve: ${model.nodes.length} nodes, ${tetElements.length} tetrahedra and ` +
        `${hexElements.length} hexahedra (order ${elementOrder}), ${elastic.dofCount} unknowns, ` +
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
    new Uint32Array(0),
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
    await iterateToConvergence(
      run,
      { initialBudget: budget, logEvery: LOG_EVERY, tag: "[amg]", started },
      askToContinue,
      log,
    );
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
