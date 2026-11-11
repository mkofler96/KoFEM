// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Static solve through the Rust finite-element module (crates/kofem-wasm) with
// the smoothed-aggregation multigrid (AMG) preconditioner, and the rule for
// which models it covers. The Rust module handles linear and quadratic
// tetrahedra with per-body materials, supports (fixed, roller, prescribed),
// nodal loads and surface loads; hex elements and couplings still solve with
// the MFEM engine's Gauss–Seidel CG, and the solve says so. Pure-shell models
// take the Rust shell solve (shellRust.ts) instead.
//
// The inputs are built by the same helpers as the MFEM payload
// (packSolveMesh, resolveMaterials, groupDirichlet, groupPointLoads,
// surfaceLoadsToVertices), so both solvers see an identical model.

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
  ElasticModel,
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
  if (model.elements.some((element) => element.type !== "CTETRA"))
    return "it supports tetrahedral meshes only";
  if (model.couplingCount > 0)
    return "it does not support surface-to-point couplings";
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
      run = elastic.startSolve(
        Uint32Array.from(fixedDofList),
        Float64Array.from(fixedValueList),
        forces,
        options,
      );
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
        // One triple per node: the vertices first, then any edge nodes.
        const nodal = solution.displacements;
        const vonMises = elastic.vonMises(nodal);
        const displacements = nodal.slice(0, 3 * elastic.vertexCount);
        const seconds = (performance.now() - started) / 1000;
        log(
          `AMG CG converged: ${solution.iterations} iterations, force residual ` +
            `${solution.relativeResidual.toExponential(2)}, ${seconds.toFixed(2)} s`,
        );
        return { displacements, vonMises };
      } finally {
        solution.free();
      }
    } finally {
      // finish() consumes the run; free it only when it was not reached.
      if (!finished) run.free();
    }
  } finally {
    elastic.free();
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
