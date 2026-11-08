// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Static solve through the Rust finite-element module (crates/kofem-wasm) with
// the smoothed-aggregation multigrid (AMG) preconditioner, and the rule for
// which models it covers. The Rust module handles linear tetrahedra with
// per-body materials, supports (fixed, roller, prescribed), nodal loads and
// surface loads; anything else (quadratic or hex elements, shells, couplings)
// still solves with the MFEM engine's Gauss–Seidel CG, and the solve says so.
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
import type { ElasticModel, SolveOptions } from "../../wasm/fem/kofem_wasm.js";
import {
  groupDirichlet,
  groupPointLoads,
  packSolveMesh,
  resolveMaterials,
  type VertexIndexer,
} from "../solveMeshPacking.js";
import { surfaceLoadsToVertices } from "./bcs.js";
import { shellMarkedBodies } from "./autoShell.js";

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
  if (model.elementOrder !== 1) return "it supports linear elements only";
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

// The CG budget when the solve request names none. AMG converges in tens to a
// few hundred iterations; running out is a real failure and is reported.
const DEFAULT_ITERATION_LIMIT = 5000;
// Stop on the force residual ‖f − K·u‖ / ‖f‖, which means the same accuracy
// whatever the preconditioner (see StoppingRule in crates/kofem-fem/src/cg.rs).
const RELATIVE_TOLERANCE = 1e-6;

// Solve one all-solid, linear-tet model with AMG. `vid` indexes element
// connectivity; `refVid` resolves constraint, load and surface-face node
// references (a tie maps them to their representative first). Returns one
// displacement triple per node of `model.nodes` and one von Mises stress per
// element, in element order — the same layout as the MFEM solve.
export function solveSolidWithAmg(
  fem: FemModule,
  model: AmgSolidModel,
  vid: VertexIndexer,
  refVid: VertexIndexer,
  iterationLimit: number | undefined,
  log: (line: string) => void,
): { displacements: Float64Array; vonMises: Float64Array } {
  const reason = amgUnavailableReason({
    elements: model.elements,
    properties: model.properties,
    elementOrder: 1,
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
  );
  try {
    const started = performance.now();
    const nonzeros = elastic.assemble();
    log(
      `AMG solve: ${model.nodes.length} nodes, ${model.elements.length} tetrahedra, ` +
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

    const options = new fem.SolveOptions(
      RELATIVE_TOLERANCE,
      // eslint-disable-next-line kofem/no-silent-fallback -- cgIterationLimit is optional in the solve message; absent means the solver's own budget, as for the MFEM path
      iterationLimit ?? DEFAULT_ITERATION_LIMIT,
      "amg",
      "residual",
    );
    try {
      const solution = elastic.solve(
        Uint32Array.from(fixedDofList),
        Float64Array.from(fixedValueList),
        forces,
        options,
      );
      try {
        const displacements = solution.displacements;
        const vonMises = elastic.vonMises(displacements);
        const seconds = (performance.now() - started) / 1000;
        log(
          `AMG CG converged: ${solution.iterations} iterations, force residual ` +
            `${solution.relativeResidual.toExponential(2)}, multigrid levels ` +
            `[${Array.from(solution.levelSizes).join(", ")}], ${seconds.toFixed(2)} s`,
        );
        return { displacements, vonMises };
      } finally {
        solution.free();
      }
    } finally {
      options.free();
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
