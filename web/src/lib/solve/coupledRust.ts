// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Mixed solid + shell static solve through the Rust finite-element module
// (crates/kofem-wasm MixedModel, KOF-308): linear tets and Kirchhoff shell
// facets over one node pool, joined by the coupling set the shell
// idealisation and the user's surface-to-point couplings produce. It reads
// exactly the arguments the C++ engine's solve_coupled reads — { mesh,
// coupling, bcs, matJson }, built by buildCoupledEngineInputs or
// prepareAutoCoupledSolve — and returns the same result layout, so both
// solvers see one contract and the C++ entry stays the test oracle
// (web/tests/integration/coupled-rust.test.mjs).
//
// Arguments, as engine/cpp/solve_coupled.cpp reads them:
//   mesh      { vertices, tets, triangles, thicknesses?, attributes?,
//               shell_attributes? } — 0-based pool indices; thicknesses one
//               per triangle; attributes / shell_attributes 1-based material
//               indices per tet / per triangle
//   coupling  { ref, offsets, solid, mpc, dof_mask, weights?, relaxation }
//   bcs       { fixed_dofs, prescribed_dofs, prescribed_vals, load_dofs,
//               load_vals } — DOF = 6·pool node + component (u, v, w, θx, θy, θz)
//   matJson   { solid, shell }: each one { young_modulus, poisson_ratio }
//             or an ARRAY of them selected by the matching attributes

import type { Couplings, MixedModel } from "../../wasm/fem/kofem_wasm.js";
import { iterateToConvergence, type ContinuationPrompt } from "./cgRun.js";
import type { EngineCoupledBcs, EngineCoupling } from "./coupled.js";
import { defaultShellIterationLimit } from "./shellRust.js";

// The C++ coupled solve's stopping rule: ‖f − K·u‖ / ‖f‖ below 1e-10
// (CoupledInput::cg_rel_tol).
const RELATIVE_TOLERANCE = 1e-10;
// Progress is logged every this many iterations, as the C++ solve does.
const LOG_EVERY = 100;

// The preconditioners the Rust mixed solve offers: IC(0) is the C++ coupled
// solve's choice (symmetric Gauss–Seidel if it cannot factor).
export type MixedPreconditionerName =
  "amg" | "incomplete-cholesky" | "gauss-seidel";

// The Rust module's classes the mixed solve needs, passed in so the worker and
// the node-side tests can each load the module their own way.
export interface MixedFemModule {
  MixedModel: typeof MixedModel;
  Couplings: typeof Couplings;
}

export interface CoupledEngineArgs {
  mesh: {
    vertices: Float64Array;
    tets: Int32Array;
    triangles: Int32Array;
    thicknesses?: Float64Array;
    attributes?: Int32Array;
    shell_attributes?: Int32Array;
  };
  coupling: EngineCoupling;
  bcs: EngineCoupledBcs;
  matJson: string;
}

export interface CoupledSolveResult {
  // Three translations per pool node.
  displacements: Float64Array;
  // One von Mises stress per tet, then one surface stress per shell facet.
  von_mises_tets: Float64Array;
  von_mises_tris: Float64Array;
  iterations: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireNumber(value: unknown, what: string): number {
  if (typeof value !== "number" || !Number.isFinite(value))
    throw new Error(`${what} must be a finite number, got ${String(value)}`);
  return value;
}

// One domain's materials as (E, ν) pairs plus a 0-based material per element,
// from a material object or array and its 1-based attributes — the contract
// of solve_coupled's `mat.solid` / `mesh.attributes` and read_shell_materials'
// `mat.shell` / `mesh.shell_attributes`. Several materials need attributes:
// there is no default material for an element that names none.
function readDomainMaterials(
  material: unknown,
  attributes: Int32Array | undefined,
  elementCount: number,
  domain: "solid" | "shell",
  attributesName: string,
  element: string,
): { pairs: Float64Array; materialOf: Uint32Array; count: number } {
  if (material === undefined || material === null)
    throw new Error(`coupled: the ${domain} material is missing`);
  const list: unknown[] = Array.isArray(material) ? material : [material];
  if (list.length === 0)
    throw new Error(
      `coupled: mat.${domain} is an empty material array — at least one material is required`,
    );
  const pairs = new Float64Array(2 * list.length);
  list.forEach((entry, index) => {
    const label = `coupled: ${domain} material ${index + 1}`;
    if (!isRecord(entry)) throw new Error(`${label} must be an object`);
    pairs[2 * index] = requireNumber(
      entry.young_modulus,
      `${label} young_modulus`,
    );
    pairs[2 * index + 1] = requireNumber(
      entry.poisson_ratio,
      `${label} poisson_ratio`,
    );
  });
  const materialOf = new Uint32Array(elementCount);
  if (attributes === undefined || attributes.length === 0) {
    if (list.length > 1 && elementCount > 0)
      throw new Error(
        `coupled: ${list.length} ${domain} materials were given but no ${attributesName} ` +
          `to select one per ${element}`,
      );
  } else {
    if (attributes.length !== elementCount)
      throw new Error(
        `coupled: ${attributes.length} ${attributesName} for ${elementCount} ${element}s`,
      );
    attributes.forEach((attribute, index) => {
      if (
        !Number.isInteger(attribute) ||
        attribute < 1 ||
        attribute > list.length
      )
        throw new Error(
          `coupled: ${element} ${index} selects ${domain} material ${attribute}, outside 1..${list.length}`,
        );
      materialOf[index] = attribute - 1;
    });
  }
  return { pairs, materialOf, count: list.length };
}

function requireIndices(
  values: Int32Array,
  what: string,
  limit: number,
): Uint32Array {
  values.forEach((value, index) => {
    if (value < 0 || value >= limit)
      throw new Error(
        `coupled: ${what}[${index}] = ${value} is out of range [0, ${limit})`,
      );
  });
  return Uint32Array.from(values);
}

// The supports and loads as the Rust solve takes them: one list of
// prescribed DOFs (fixed ones at zero) and a dense force vector.
function readBcs(bcs: EngineCoupledBcs, dofCount: number) {
  if (bcs.prescribed_dofs.length !== bcs.prescribed_vals.length)
    throw new Error(
      `coupled: ${bcs.prescribed_dofs.length} bcs.prescribed_dofs but ` +
        `${bcs.prescribed_vals.length} bcs.prescribed_vals — one value per prescribed DOF`,
    );
  if (bcs.load_dofs.length !== bcs.load_vals.length)
    throw new Error(
      `coupled: ${bcs.load_dofs.length} bcs.load_dofs but ${bcs.load_vals.length} bcs.load_vals`,
    );
  const fixedDofs = requireIndices(
    Int32Array.from([...bcs.fixed_dofs, ...bcs.prescribed_dofs]),
    "bcs fixed/prescribed DOF",
    dofCount,
  );
  const fixedValues = Float64Array.from([
    ...Array.from(bcs.fixed_dofs, () => 0),
    ...bcs.prescribed_vals,
  ]);
  const forces = new Float64Array(dofCount);
  bcs.load_dofs.forEach((dof, index) => {
    if (dof < 0 || dof >= dofCount)
      throw new Error(
        `coupled: load DOF ${dof} is out of range [0, ${dofCount})`,
      );
    forces[dof] += requireNumber(
      bcs.load_vals[index],
      `coupled: load value ${index}`,
    );
  });
  return { fixedDofs, fixedValues, forces };
}

export async function solveCoupledInRust(
  fem: MixedFemModule,
  args: CoupledEngineArgs,
  preconditioner: MixedPreconditionerName,
  iterationLimit: number | undefined,
  askToContinue: ContinuationPrompt,
  log: (line: string) => void,
): Promise<CoupledSolveResult> {
  const { mesh, coupling, bcs } = args;
  if (
    mesh.vertices.length % 3 !== 0 ||
    mesh.tets.length % 4 !== 0 ||
    mesh.triangles.length % 3 !== 0
  )
    throw new Error(
      `coupled: bad mesh array lengths (${mesh.vertices.length} coordinates, ` +
        `${mesh.tets.length} tet indices, ${mesh.triangles.length} triangle indices)`,
    );
  const nodeCount = mesh.vertices.length / 3;
  const tetCount = mesh.tets.length / 4;
  const triangleCount = mesh.triangles.length / 3;

  const mat = JSON.parse(args.matJson) as unknown;
  if (!isRecord(mat))
    throw new Error("coupled: matJson must hold an object { solid, shell }");
  const solid = readDomainMaterials(
    mat.solid,
    mesh.attributes,
    tetCount,
    "solid",
    "mesh.attributes",
    "tet",
  );
  const shell = readDomainMaterials(
    mat.shell,
    mesh.shell_attributes,
    triangleCount,
    "shell",
    "mesh.shell_attributes",
    "triangle",
  );
  // Every shell facet needs its thickness; a model without facets may omit
  // the field.
  const thicknessCount =
    mesh.thicknesses === undefined ? 0 : mesh.thicknesses.length;
  if (thicknessCount !== triangleCount)
    throw new Error(
      `coupled: ${thicknessCount} mesh.thicknesses for ${triangleCount} shell triangles — ` +
        "every shell facet needs its thickness",
    );
  if (coupling.offsets.length !== coupling.ref.length + 1)
    throw new Error(
      `coupled: ${coupling.ref.length} couplings need ${coupling.ref.length + 1} offsets, ` +
        `got ${coupling.offsets.length}`,
    );

  const model = new fem.MixedModel(
    mesh.vertices,
    requireIndices(mesh.tets, "mesh.tets", nodeCount),
    solid.materialOf,
    solid.pairs,
    requireIndices(mesh.triangles, "mesh.triangles", nodeCount),
    mesh.thicknesses === undefined ? new Float64Array(0) : mesh.thicknesses,
    triangleCount > 0 ? shell.materialOf : new Uint32Array(0),
    shell.pairs,
  );
  try {
    const started = performance.now();
    const nonzeros = model.assemble();
    const { fixedDofs, fixedValues, forces } = readBcs(bcs, model.dofCount);
    log(
      `[coupled] Rust solve: ${nodeCount} nodes, ${tetCount} tets ` +
        `(${solid.count} material${solid.count === 1 ? "" : "s"}), ${triangleCount} shell facets, ` +
        `${coupling.ref.length} couplings, ${fixedDofs.length} constrained DOFs, ` +
        `${bcs.load_dofs.length} loads; ${nonzeros} stiffness entries assembled`,
    );
    const couplings = new fem.Couplings(
      requireIndices(coupling.ref, "coupling.ref", nodeCount),
      requireIndices(
        coupling.offsets,
        "coupling.offsets",
        coupling.solid.length + 1,
      ),
      requireIndices(coupling.solid, "coupling.solid", nodeCount),
      coupling.mpc,
      Uint32Array.from(coupling.dof_mask),
      // eslint-disable-next-line kofem/no-silent-fallback -- weights are optional in the coupling set; absent means equal weights, as for solve_coupled
      coupling.weights ?? new Float64Array(0),
      requireNumber(coupling.relaxation, "coupling.relaxation"),
    );
    try {
      const run = model.startSolve(
        couplings,
        fixedDofs,
        fixedValues,
        forces,
        RELATIVE_TOLERANCE,
        preconditioner,
      );
      let finished = false;
      try {
        log(`[coupled] preconditioner: ${run.preconditioner}`);
        await iterateToConvergence(
          run,
          {
            // cgIterationLimit is optional in the solve message; absent means
            // the solver's own budget, as for the C++ coupled solve.
            initialBudget:
              iterationLimit === undefined
                ? defaultShellIterationLimit(model.dofCount)
                : iterationLimit,
            logEvery: LOG_EVERY,
            tag: "[coupled]",
            started,
          },
          askToContinue,
          log,
        );
        finished = true;
        const solution = run.finish();
        try {
          const dofs = solution.displacements;
          const result = {
            displacements: Float64Array.from(model.translations(dofs)),
            von_mises_tets: Float64Array.from(model.vonMisesTets(dofs)),
            von_mises_tris: Float64Array.from(model.vonMisesTris(dofs)),
            iterations: solution.iterations,
          };
          const seconds = (performance.now() - started) / 1000;
          log(
            `[coupled] converged: ${solution.iterations} iterations, relative residual ` +
              `${solution.relativeResidual.toExponential(3)}, ${seconds.toFixed(2)} s`,
          );
          return result;
        } finally {
          solution.free();
        }
      } finally {
        // finish() consumes the run; free it only when it was not reached.
        if (!finished) run.free();
      }
    } finally {
      couplings.free();
    }
  } finally {
    model.free();
  }
}
