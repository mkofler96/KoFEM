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
// The inputs are built by the same helpers as the C++ engine's solve payload
// was, so the stored C++ results still compare to them
// (packSolveMesh, resolveMaterials, groupDirichlet, groupPointLoads,
// surfaceLoadsToVertices for the solid solve; buildCoupledEngineInputs for a
// model with couplings), so both solvers see an identical model.

import type {
  Constraint,
  Element,
  LargeDeformation,
  Load,
  Material,
  Node,
  Property,
  SurfaceLoad,
  TemperatureLoad,
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
import type { ContactDefinition, ContactResult } from "../contact.js";
import type { SolveRoute } from "./route.js";
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
import { uniformStress, type ElementStress } from "../stressFields.js";
import { thermalInputs, type EvaluateField } from "./thermal.js";
import {
  readReactions,
  supportOwners,
  type ReactionSummary,
  type SupportOwners,
} from "./reactions.js";
import { release } from "./rustFailure.js";
import {
  ContactUnheldError,
  contactPairs,
  readContact,
  runContactSolve,
  type ContactFemModule,
} from "./contactRun.js";
import { contactUnheldMessage } from "./rigidBody.js";
import { runLargeDeformationSolve } from "./largeDeformation.js";
import { tr } from "../../i18n/useLocale.js";
import { solveMessages } from "../../i18n/messages/solve.js";

export type { ContinuationPrompt } from "./cgRun.js";

export type SolverMethod = "amg" | "gauss-seidel";

// The options the Solve panel offers, AMG first as the recommended default.
export const SOLVER_METHODS: readonly SolverMethod[] = ["amg", "gauss-seidel"];

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
    return tr(solveMessages).amgOrder;
  const shellCount = model.elements.filter(
    (element) => element.type === "CTRIA3",
  ).length;
  if (shellCount > 0 && shellCount === model.elements.length)
    return tr(solveMessages).amgShellOnly;
  if (
    model.elements.some(
      (element) =>
        element.type !== "CTETRA" &&
        element.type !== "CHEXA" &&
        element.type !== "CTRIA3",
    )
  )
    return tr(solveMessages).amgElementTypes;
  // Shells mixed with tets take the Rust mixed solve (coupledRust.ts), which
  // is linear tets + DKT facets with every coupling (as the engine's
  // solve_coupled); routeSolve refuses element order 2 on these models.
  if (shellCount > 0)
    return model.elements.some((element) => element.type === "CHEXA")
      ? tr(solveMessages).amgShellsWithHexes
      : null;
  // The coupled model is built by the coupled solver's input builder, which
  // takes tetrahedra only.
  if (
    model.couplingCount > 0 &&
    model.elements.some((element) => element.type === "CHEXA")
  )
    return tr(solveMessages).amgCouplings;
  if (shellMarkedBodies(model.properties).length > 0)
    return tr(solveMessages).amgShellBodies;
  return null;
}

export type Preconditioner = SolverMethod | "incomplete-cholesky";

// The preconditioner a solve uses for the chosen method, decided by the route
// the model takes (routeSolve), so the Solve panel and the worker agree. A
// path with shell facets solves with incomplete Cholesky IC(0) unless AMG was
// chosen and takes the model; the shell solves have no Gauss–Seidel. An
// all-solid path solves with the chosen method, or routeSolve refuses it.
export function solvePreconditioner(
  requested: SolverMethod,
  route: SolveRoute,
  amgReason: string | null,
  elements: readonly Element[],
): Preconditioner {
  if (requested === "amg" && amgReason === null) return "amg";
  const hasShells =
    route.path === "shell" ||
    route.path === "auto-shell" ||
    elements.some((element) => element.type === "CTRIA3");
  return hasShells ? "incomplete-cholesky" : requested;
}

export function preconditionerLabel(preconditioner: Preconditioner): string {
  return preconditioner === "incomplete-cholesky"
    ? tr(solveMessages).incompleteCholesky
    : METHOD_LABEL[preconditioner];
}

// Why the chosen method is not the one the solve uses, and which it uses, for
// the Solve panel and the solve log; null when the chosen method is used.
export function preconditionerNotice(
  requested: SolverMethod,
  used: Preconditioner,
  amgReason: string | null,
): string | null {
  if (used === requested) return null;
  const reason =
    requested === "gauss-seidel"
      ? tr(solveMessages).gaussSeidelShells
      : amgReason;
  if (reason === null)
    throw new Error(
      `preconditionerNotice: AMG gave way to ${used} with no reason`,
    );
  return tr(solveMessages).methodUnavailable(
    METHOD_LABEL[requested],
    reason,
    preconditionerLabel(used),
  );
}

// The classes of the Rust module the solve needs, passed in so the worker and
// the node-side tests can each load the module their own way.
export interface FemModule {
  ElasticModel: typeof ElasticModel;
  SolveOptions: typeof SolveOptions;
}

// The solid solve needs the tie tables too, for constraint ties, the
// formula evaluator for a temperature change, and the contact pairs.
export interface SolidFemModule extends FemModule, ContactFemModule {
  Ties: typeof Ties;
  evaluateFieldExpression: EvaluateField;
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
  // A temperature change over the model; absent or null: none.
  temperature?: TemperatureLoad | null;
  // The constraint-tie equations of the model's "mpc" connections
  // (weldTies), in original node ids; absent or empty when it has none.
  constraintTies?: TieConstraint[];
  // Frictionless contacts; absent or empty when it has none.
  contacts?: ContactDefinition[];
  // Large deformation; absent or null: the linear solve.
  largeDeformation?: LargeDeformation | null;
}

// The CG budget when the solve request names none (the former MFEM path's
// cap). AMG converges in tens to a few hundred iterations, so reaching it is
// rare; when it happens the user is asked whether to go on.
const DEFAULT_ITERATION_LIMIT = 5000;

// The CG budget of a solve whose request names `iterationLimit` or none. The
// solve entries call this once and hand the number down.
function cgBudget(iterationLimit: number | undefined): number {
  // eslint-disable-next-line kofem/no-silent-fallback -- cgIterationLimit is optional in the solve message; absent means the solver's own budget
  return iterationLimit ?? DEFAULT_ITERATION_LIMIT;
}
// Progress is logged every this many iterations.
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
// element, tets first, then hexes. Quadratic elements add edge (and hex face
// and centre) nodes inside the Rust module, as MFEM's order-2 space does;
// their displacements stay there.
// Constraint ties (`model.constraintTies`) are eliminated in the same solve;
// on quadratic elements their tied surface's edge and face nodes come along.
// Contacts (`model.contacts`, linear elements) make it a contact solve, which
// also returns the contact pressure and status of every slave node.
// `model.largeDeformation` makes it a Neo-Hookean solve over load increments,
// whose stresses are Cauchy stresses; routeSolve has refused it with a
// contact, a constraint tie or a temperature change.
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
): Promise<{
  displacements: Float64Array;
  vonMises: Float64Array;
  stress: ElementStress;
  reactions: ReactionSummary | null;
  contact: ContactResult | null;
}> {
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
    const largeDeformation = model.largeDeformation ?? null;
    if (largeDeformation !== null) {
      const unsupported = [
        ...((model.contacts ?? []).length > 0 ? ["contact"] : []),
        ...((model.constraintTies ?? []).length > 0 ? ["constraint ties"] : []),
        ...(model.temperature ? ["a temperature change"] : []),
      ];
      if (unsupported.length > 0)
        throw new Error(
          `The large-deformation solve does not take ${unsupported.join(", ")}.`,
        );
      // The Newton solve assembles its own tangent each iteration.
      log(
        `${METHOD_LABEL[method]} large-deformation solve: ${model.nodes.length} nodes, ${describeSolidElements(tetCount, hexCount)} (order ${elementOrder}), ` +
          `${elastic.dofCount} unknowns, Neo-Hookean solids over ${largeDeformation.increments} load increments`,
      );
    } else {
      const nonzeros = elastic.assemble();
      log(
        `${METHOD_LABEL[method]} solve: ${model.nodes.length} nodes, ${describeSolidElements(tetCount, hexCount)} (order ${elementOrder}), ` +
          `${elastic.dofCount} unknowns, ${nonzeros} stiffness entries assembled`,
      );
    }
    const { fixedDofs, fixedValues, forces } = rustSolidBoundaryConditions(
      elastic,
      model,
      refVid,
    );
    // A temperature change adds its thermal load to the forces.
    const thermal = model.temperature
      ? thermalInputs(
          fem.evaluateFieldExpression,
          model.temperature,
          [
            ...model.elements.filter((e) => e.type === "CTETRA"),
            ...model.elements.filter((e) => e.type === "CHEXA"),
          ],
          model.materials,
          model.properties,
          elastic.nodeCoordinates,
        )
      : null;
    if (thermal) {
      const thermalForces = elastic.thermalLoad(thermal.alpha, thermal.deltaT);
      for (let i = 0; i < forces.length; i++) forces[i] += thermalForces[i];
      log(
        `Temperature change ${model.temperature?.formula} °C applied as a thermal load`,
      );
    }
    const supports = supportOwners(
      model.constraints,
      elastic.vertexCount,
      (nodeId) => refVid(nodeId, "support reaction"),
    );

    const constraintTies = model.constraintTies ?? [];
    // One triple per node: the vertices first, then any edge nodes.
    const readSolution = (solution: ElasticSolution) => {
      const nodal = solution.displacements;
      return {
        displacements: nodal.slice(0, 3 * elastic.vertexCount),
        vonMises: elastic.vonMises(nodal),
        stress: uniformStress(
          thermal
            ? elastic.stressTensorsThermal(nodal, thermal.alpha, thermal.deltaT)
            : elastic.stressTensors(nodal),
        ),
        reactions: readReactions(elastic, solution, forces, supports),
      };
    };
    if (largeDeformation !== null)
      return await solveLargeDeformation(
        fem,
        elastic,
        { fixedDofs, fixedValues, forces },
        largeDeformation.increments,
        method,
        cgBudget(iterationLimit),
        started,
        log,
        (solution) => {
          const nodal = solution.displacements;
          return {
            displacements: nodal.slice(0, 3 * elastic.vertexCount),
            vonMises: elastic.cauchyVonMises(nodal),
            stress: uniformStress(elastic.cauchyStressTensors(nodal)),
            reactions: readReactions(elastic, solution, forces, supports),
            contact: null,
          };
        },
      );
    const contacts = model.contacts ?? [];
    if (contacts.length > 0)
      return await solveWithContact(
        fem,
        elastic,
        model,
        contacts,
        constraintTies,
        refVid,
        { fixedDofs, fixedValues, forces },
        method,
        cgBudget(iterationLimit),
        started,
        log,
        readSolution,
      );
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
              release(ties);
            }
          };
    return await runRustSolve(
      fem,
      method,
      cgBudget(iterationLimit),
      start,
      started,
      askToContinue,
      log,
      (solution) => ({ ...readSolution(solution), contact: null }),
    );
  } finally {
    release(elastic);
  }
}

// The contact solve of an assembled solid model (see solveSolidInRust): the
// constraint ties, if any, eliminated with it; each correction solved by CG
// with `method` to the solid solve's tolerance.
async function solveWithContact<T>(
  fem: SolidFemModule,
  elastic: ElasticModel,
  model: AmgSolidModel,
  contacts: ContactDefinition[],
  constraintTies: TieConstraint[],
  refVid: VertexIndexer,
  conditions: {
    fixedDofs: Uint32Array;
    fixedValues: Float64Array;
    forces: Float64Array;
  },
  method: SolverMethod,
  budget: number,
  started: number,
  log: (line: string) => void,
  read: (solution: ElasticSolution) => T,
): Promise<T & { contact: ContactResult }> {
  const tables = rustTieTables(constraintTies, refVid);
  const ties = new fem.Ties(
    tables.slaves,
    tables.offsets,
    tables.masters,
    tables.weights,
    tables.interfaces,
  );
  const pairs = contactPairs(fem, contacts, refVid);
  const options = new fem.SolveOptions(
    RELATIVE_TOLERANCE,
    budget,
    method,
    "residual",
  );
  log(
    `${METHOD_LABEL[method]} contact solve: ${contacts.length} contact pair(s), each touching node found by the active set`,
  );
  try {
    const solution = await runContactSolve(
      elastic,
      pairs,
      ties,
      conditions.fixedDofs,
      conditions.fixedValues,
      conditions.forces,
      options,
      log,
    ).catch((err: unknown) => {
      if (!(err instanceof ContactUnheldError)) throw err;
      throw new Error(
        contactUnheldMessage(
          {
            nodeId: model.nodes[err.vertex].id,
            direction: err.direction,
            turns: err.turns,
          },
          model.elements,
          model.properties,
        ),
        { cause: err },
      );
    });
    try {
      const contact = readContact(solution, model.nodes);
      const elasticSolution = solution.elastic;
      try {
        const result = read(elasticSolution);
        const touching = contact.closed.reduce(
          (sum, closed) => sum + closed,
          0,
        );
        const seconds = (performance.now() - started) / 1000;
        log(
          `Contact converged: ${contact.iterations} active-set iterations, ${elasticSolution.iterations} CG iterations, ` +
            `${touching} of ${contact.nodeIds.length} slave nodes touching, contact force ${contact.force.toExponential(3)}, ${seconds.toFixed(2)} s`,
        );
        if (solution.heldNodes > 0)
          log(
            `${solution.heldNodes} slave node(s) held by a support along their normal — the support applies there`,
          );
        if (solution.sharedNodes > 0)
          log(
            `${solution.sharedNodes} node(s) on an edge two contacts share — each keeps one contact role there`,
          );
        return { ...result, contact };
      } finally {
        release(elasticSolution);
      }
    } finally {
      release(solution);
    }
  } finally {
    release(options);
    release(pairs);
    release(ties);
  }
}

// The large-deformation solve of a solid model (see solveSolidInRust): each
// Newton correction solved by CG with `method` to the solid solve's
// tolerance, which also bounds the out-of-balance force.
async function solveLargeDeformation<T>(
  fem: FemModule,
  elastic: ElasticModel,
  conditions: {
    fixedDofs: Uint32Array;
    fixedValues: Float64Array;
    forces: Float64Array;
  },
  increments: number,
  method: SolverMethod,
  budget: number,
  started: number,
  log: (line: string) => void,
  read: (solution: ElasticSolution) => T,
): Promise<T> {
  const options = new fem.SolveOptions(
    RELATIVE_TOLERANCE,
    budget,
    method,
    "residual",
  );
  try {
    const solution = await runLargeDeformationSolve(
      elastic,
      conditions.fixedDofs,
      conditions.fixedValues,
      conditions.forces,
      options,
      increments,
      log,
    );
    try {
      const elasticSolution = solution.elastic;
      try {
        const result = read(elasticSolution);
        const seconds = (performance.now() - started) / 1000;
        log(
          `Large deformation converged: ${increments} load increments, ${solution.iterations} Newton iterations, ` +
            `${elasticSolution.iterations} CG iterations, each increment checked stable, ${seconds.toFixed(2)} s`,
        );
        return result;
      } finally {
        release(elasticSolution);
      }
    } finally {
      release(solution);
    }
  } finally {
    release(options);
  }
}

// The solid model of tetrahedra and hexahedra (tets first, then hexes, as
// buildSolidEngineInputs packs them) as a Rust ElasticModel with
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
  // resolveMaterials numbers materials from 1 (the engine-input contract);
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
  );
  return {
    fixedDofs: Uint32Array.from(fixedDofList),
    fixedValues: Float64Array.from(fixedValueList),
    forces,
  };
}

// What the Rust coupled solve reads: the coupled assembler's inputs
// (CoupledEngineInputs, from buildCoupledEngineInputs) without the shell
// fields, as the engine's solve_coupled took them.
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
// the engine's solve_coupled did for it, with elements of `elementOrder` (1
// linear, 2 quadratic) and CG preconditioned by `method`. Returns the same fields: three translations per pool
// node and one von Mises stress per tet (no shell facets).
//
// At order 1 the forces are the coupled inputs' nodal loads, surface loads
// lumped onto the corners, as the engine's linear-only coupled solve took
// them. At order 2 a surface load must reach the edge nodes, so Rust
// integrates it over the 6-node faces, as the solid solve does;
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
  // Which support holds each pool DOF; callers that report no reactions (the
  // stored-reference tests) leave it out.
  supports?: SupportOwners,
): Promise<{
  displacements: Float64Array;
  von_mises_tets: Float64Array;
  von_mises_tris: Float64Array;
  stress_tets: Float64Array;
  stress_tris: ElementStress;
  reactions: ReactionSummary | null;
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
      // Weights are optional in the coupling set; empty means equal weights, as for solve_coupled.
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
        addSurfaceLoads(elastic, translations, input.poolSurfaceLoads);
        for (let node = 0; node < nodeCount; node++)
          for (let component = 0; component < 3; component++)
            forces[perVertex * node + component] +=
              translations[3 * node + component];
      }
      return await runRustSolve(
        fem,
        method,
        cgBudget(iterationLimit),
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
            stress_tets: elastic.stressTensors(nodal),
            stress_tris: uniformStress(new Float64Array(0)),
            reactions:
              supports === undefined
                ? null
                : readReactions(elastic, solution, forces, supports),
          };
        },
      );
    } finally {
      release(couplings);
    }
  } finally {
    release(elastic);
  }
}

// Set up the run with `start`, preconditioned by `method`, advance it to
// convergence (asking to go on past the iteration budget) and read the result
// with `read`. Frees the options, the run and the solution whatever happens.
async function runRustSolve<T>(
  fem: FemModule,
  method: SolverMethod,
  budget: number,
  start: (options: SolveOptions) => SolveRun,
  started: number,
  askToContinue: ContinuationPrompt,
  log: (line: string) => void,
  read: (solution: ElasticSolution) => T,
): Promise<T> {
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
    release(options);
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
      release(solution);
    }
  } finally {
    // finish() consumes the run; free it only when it was not reached.
    if (!finished) release(run);
  }
}

// Add the work-equivalent nodal forces of `surfaceLoads` (faces as vertex
// indices) to `forces` (3 per node). Rust refuses a load with a face off the
// boundary, which would put the total on a smaller area (KOF-411);
// surfaceLoadRefusal names it before the solve gets here.
function addSurfaceLoads(
  elastic: ElasticModel,
  forces: Float64Array,
  surfaceLoads: SurfaceLoad[],
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
    elastic.addSurfaceLoad(
      forces,
      index,
      Uint32Array.from(triangles),
      Uint32Array.from(quadrilaterals),
      surfaceLoad.type,
      surfaceLoadValues(surfaceLoad, index),
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
  const force: unknown = surfaceLoad.force;
  if (force === undefined)
    throw new Error(
      `Surface load ${index} (${surfaceLoad.type}) has no force vector`,
    );
  // Exactly three finite numbers: Float64Array.from would read the string
  // "123" as [1, 2, 3] and an object with a length as NaNs.
  if (
    !Array.isArray(force) ||
    force.length !== 3 ||
    !force.every((value) => typeof value === "number" && Number.isFinite(value))
  )
    throw new Error(
      `Surface load ${index} (${surfaceLoad.type}): the force vector must be three finite numbers, got ${JSON.stringify(force)}`,
    );
  return Float64Array.from(force as number[]);
}
