// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Pure-shell (Kirchhoff CST + DKT) static solve through the Rust
// finite-element module (crates/kofem-wasm ShellModel). It reads exactly the
// payload the C++ engine's solve_shell reads — { mesh, mat_json, bcs_json },
// built by buildShellEngineInputs or preparePureShellSolve — and returns the
// same result layout, so both solvers see one contract and the C++ entry
// stays the test oracle (web/tests/integration/shell-rust.test.mjs).
//
// Payload, as engine/cpp/solve_shell.h documents it:
//   mesh      { vertices, triangles, thicknesses?, attributes? }
//   mat_json  { young_modulus, poisson_ratio, thickness? }, or an ARRAY of
//             { young_modulus, poisson_ratio } selected per triangle by the
//             1-based mesh.attributes (thickness then from mesh.thicknesses)
//   bcs_json  { fixed_vertices?, fixed_dofs?: [{vertex, dofs}],
//               prescribed_dofs?: [{vertex, dof, value}],
//               point_loads?: [{vertex, force?, moment?}] }
// DOF components are 0..5 = (u, v, w, θx, θy, θz).

import type { ShellModel } from "../../wasm/fem/kofem_wasm.js";
import type { ShellMesh } from "../../wasm/pkg/kofem_wasm.js";
import { iterateToConvergence, type ContinuationPrompt } from "./cgRun.js";

// The C++ shell solve's stopping rule: ‖f − K·u‖ / ‖f‖ below 1e-10.
const RELATIVE_TOLERANCE = 1e-10;
// Progress is logged every this many iterations, as the C++ shell solve does.
const LOG_EVERY = 100;

// The Rust module's class the shell solve needs, passed in so the worker and
// the node-side tests can each load the module their own way.
export interface ShellFemModule {
  ShellModel: typeof ShellModel;
}

export interface ShellSolveResult {
  // Three translations per vertex.
  displacements: Float64Array;
  // One surface von Mises stress per triangle.
  von_mises: Float64Array;
  iterations: number;
}

// The C++ solve's default CG budget, max(20000, 400·∛n) for n unknowns
// (sparse_cg.cpp): its preconditioners need O(∛n) iterations.
export function defaultShellIterationLimit(dofCount: number): number {
  return Math.max(20000, Math.floor(400 * Math.cbrt(dofCount)));
}

export async function solveShellInRust(
  fem: ShellFemModule,
  inputs: { mesh: ShellMesh; matJson: string; bcsJson: string },
  iterationLimit: number | undefined,
  askToContinue: ContinuationPrompt,
  log: (line: string) => void,
): Promise<ShellSolveResult> {
  const { vertices, triangles } = inputs.mesh;
  if (vertices.length % 3 !== 0)
    throw new Error(
      `mesh.vertices length ${vertices.length} is not divisible by 3 — expected flat xyz coordinates`,
    );
  if (triangles.length % 3 !== 0)
    throw new Error(
      `mesh.triangles length ${triangles.length} is not divisible by 3 — expected three vertex indices per triangle`,
    );
  const nodeCount = vertices.length / 3;
  const triangleCount = triangles.length / 3;
  if (nodeCount === 0 || triangleCount === 0)
    throw new Error("shell mesh has no nodes or no triangles");

  const section = readShellSection(
    JSON.parse(inputs.matJson) as unknown,
    inputs.mesh,
    triangleCount,
  );
  const bcs = readShellBcs(JSON.parse(inputs.bcsJson) as unknown, nodeCount);

  if (triangles.some((vertex) => vertex < 0))
    throw new Error("mesh.triangles holds a negative vertex index");
  const model = new fem.ShellModel(
    vertices,
    Uint32Array.from(triangles),
    section.thicknesses,
    section.materialOfTriangle,
    section.materials,
  );
  try {
    const started = performance.now();
    const nonzeros = model.assemble();
    log(
      `[shell] Rust solve: ${nodeCount} nodes, ${triangleCount} triangles, ` +
        `${section.description}; ${bcs.fixedDofs.length} constrained DOFs, ` +
        `${bcs.loadCount} loads; ${nonzeros} stiffness entries assembled`,
    );
    const forces = new Float64Array(model.dofCount);
    for (const [dof, value] of bcs.loads) forces[dof] += value;
    const run = model.startSolve(
      Uint32Array.from(bcs.fixedDofs),
      Float64Array.from(bcs.fixedValues),
      forces,
      RELATIVE_TOLERANCE,
    );
    let finished = false;
    try {
      log(`[shell] preconditioner: ${run.preconditioner}`);
      await iterateToConvergence(
        run,
        {
          // cgIterationLimit is optional in the solve message; absent means
          // the solver's own budget, as for the C++ shell solve.
          initialBudget:
            iterationLimit === undefined
              ? defaultShellIterationLimit(model.dofCount)
              : iterationLimit,
          logEvery: LOG_EVERY,
          tag: "[shell]",
          started,
        },
        askToContinue,
        log,
      );
      finished = true;
      const solution = run.finish();
      try {
        const dofs = solution.displacements;
        const displacements = Float64Array.from(model.translations(dofs));
        const vonMises = Float64Array.from(model.vonMises(dofs));
        const seconds = (performance.now() - started) / 1000;
        log(
          `[shell] converged: ${solution.iterations} iterations, relative residual ` +
            `${solution.relativeResidual.toExponential(3)}, ${seconds.toFixed(2)} s`,
        );
        return {
          displacements,
          von_mises: vonMises,
          iterations: solution.iterations,
        };
      } finally {
        solution.free();
      }
    } finally {
      // finish() consumes the run; free it only when it was not reached.
      if (!finished) run.free();
    }
  } finally {
    model.free();
  }
}

interface ShellSection {
  thicknesses: Float64Array;
  // 0-based index into `materials` per triangle.
  materialOfTriangle: Uint32Array;
  // (E, ν) pairs.
  materials: Float64Array;
  description: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireNumber(value: unknown, what: string): number {
  if (typeof value !== "number" || !Number.isFinite(value))
    throw new Error(`${what} must be a finite number`);
  return value;
}

function requireVertex(value: unknown, nodeCount: number, fn: string): number {
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < 0 ||
    value >= nodeCount
  )
    throw new Error(
      `${fn}: vertex index ${String(value)} is out of range [0, ${nodeCount}) — a boundary ` +
        "condition or load references a vertex the mesh does not contain (a stale index " +
        "after a remesh renumbered the nodes?)",
    );
  return value;
}

function requireComponent(value: unknown, vertex: number, fn: string): number {
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < 0 ||
    value > 5
  )
    throw new Error(
      `${fn}: vertex ${vertex} was given the invalid shell DOF component index ` +
        `${String(value)} — expected 0..5 (0=Ux, 1=Uy, 2=Uz, 3=Rx, 4=Ry, 5=Rz)`,
    );
  return value;
}

function optionalArray(value: unknown, what: string): unknown[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new Error(`${what} must be an array`);
  return value;
}

// The shell material(s) and thickness field, as read_shell_materials and
// solve_shell read them (shell_material_js.h, solve_shell.cpp).
function readShellSection(
  material: unknown,
  mesh: ShellMesh,
  triangleCount: number,
): ShellSection {
  if (material === undefined || material === null)
    throw new Error("shell material is missing");
  const list = Array.isArray(material) ? material : [material];
  if (list.length === 0)
    throw new Error(
      "shell materials array is empty — at least one material is required",
    );
  const materials = new Float64Array(2 * list.length);
  list.forEach((entry: unknown, index) => {
    if (!isRecord(entry))
      throw new Error(`shell material ${index + 1} must be an object`);
    if (entry.young_modulus === undefined || entry.young_modulus === null)
      throw new Error(`shell material ${index + 1} is missing young_modulus`);
    if (entry.poisson_ratio === undefined || entry.poisson_ratio === null)
      throw new Error(`shell material ${index + 1} is missing poisson_ratio`);
    materials[2 * index] = requireNumber(
      entry.young_modulus,
      `shell material ${index + 1} young_modulus`,
    );
    materials[2 * index + 1] = requireNumber(
      entry.poisson_ratio,
      `shell material ${index + 1} poisson_ratio`,
    );
  });

  const materialOfTriangle = new Uint32Array(triangleCount);
  const { attributes } = mesh;
  if (attributes === undefined || attributes.length === 0) {
    if (list.length > 1)
      throw new Error(
        `${list.length} shell materials were given but no mesh.attributes to select one per triangle`,
      );
  } else {
    if (attributes.length !== triangleCount)
      throw new Error(
        `mesh.attributes has ${attributes.length} entries for ${triangleCount} triangles`,
      );
    attributes.forEach((attribute, triangle) => {
      if (attribute < 1 || attribute > list.length)
        throw new Error(
          `triangle ${triangle} selects shell material ${attribute}, outside 1..${list.length}`,
        );
      materialOfTriangle[triangle] = attribute - 1;
    });
  }

  // A uniform thickness rides on the single material object only.
  const uniform =
    !Array.isArray(material) && isRecord(material)
      ? material.thickness
      : undefined;
  const hasUniform = uniform !== undefined && uniform !== null;
  let thicknesses: Float64Array;
  let thicknessDescription: string;
  if (mesh.thicknesses !== undefined) {
    // The per-triangle field is the thickness source: it must cover every
    // triangle, and a uniform thickness alongside it would be ambiguous.
    if (mesh.thicknesses.length !== triangleCount)
      throw new Error(
        `mesh.thicknesses has ${mesh.thicknesses.length} entries for ${triangleCount} triangles`,
      );
    if (hasUniform)
      throw new Error(
        "give either mesh.thicknesses or material thickness, not both",
      );
    thicknesses = mesh.thicknesses;
    thicknessDescription = "per-facet thickness";
  } else {
    if (!hasUniform)
      throw new Error(
        "material is missing thickness (required for shell elements)",
      );
    const thickness = requireNumber(uniform, "shell thickness");
    if (thickness <= 0) throw new Error("shell thickness must be positive");
    thicknesses = new Float64Array(triangleCount).fill(thickness);
    thicknessDescription = `t=${thickness}`;
  }
  const materialDescription =
    list.length === 1
      ? `E=${materials[0]}, nu=${materials[1]}`
      : `${list.length} materials (per facet)`;
  return {
    thicknesses,
    materialOfTriangle,
    materials,
    description: `${thicknessDescription}, ${materialDescription}`,
  };
}

interface ShellBcs {
  fixedDofs: number[];
  fixedValues: number[];
  // (DOF, value) pairs; several for one DOF add up.
  loads: [number, number][];
  loadCount: number;
}

const COMPONENT_NAMES = ["Ux", "Uy", "Uz", "Rx", "Ry", "Rz"] as const;

// A DOF held at two different values is a modelling contradiction, refused
// with the C++ engine's wording (bc_validation.h, KOF-218). The same value
// twice is no contradiction.
function conflictError(
  dof: number,
  first: { value: number; prescribed: boolean },
  second: { value: number; prescribed: boolean },
): Error {
  const describe = ({ value, prescribed }: typeof first) =>
    `${prescribed ? "prescribed" : "fixed"} to ${Number(value.toPrecision(10))}`;
  const component = dof % 6;
  return new Error(
    `shell: vertex ${Math.floor(dof / 6)} component ${COMPONENT_NAMES[component]} ` +
      `(DOF ${component}) is ${describe(first)} and also ${describe(second)} — a DOF ` +
      "cannot be held at two displacements at once. Two boundary condition groups " +
      "overlap at this node; remove it from one of them or give both the same value.",
  );
}

// The supports and loads, as solve_shell.cpp reads them. fixed_* mean u = 0;
// prescribed_dofs states u = value.
function readShellBcs(bcs: unknown, nodeCount: number): ShellBcs {
  if (!isRecord(bcs))
    throw new Error("shell boundary conditions must be an object");
  const fixedDofs: number[] = [];
  const fixedValues: number[] = [];
  const heldAt = new Map<number, { value: number; prescribed: boolean }>();
  const hold = (dof: number, value: number, prescribed: boolean) => {
    const earlier = heldAt.get(dof);
    if (earlier !== undefined) {
      if (earlier.value !== value)
        throw conflictError(dof, earlier, { value, prescribed });
      return;
    }
    heldAt.set(dof, { value, prescribed });
    fixedDofs.push(dof);
    fixedValues.push(value);
  };
  const fix = (dof: number) => hold(dof, 0, false);

  for (const entry of optionalArray(bcs.fixed_vertices, "fixed_vertices")) {
    const vertex = requireVertex(entry, nodeCount, "add_fixed_vertices");
    for (let component = 0; component < 6; component++)
      fix(6 * vertex + component);
  }
  for (const entry of optionalArray(bcs.fixed_dofs, "fixed_dofs")) {
    if (!isRecord(entry)) throw new Error("fixed_dofs entries must be objects");
    const vertex = requireVertex(entry.vertex, nodeCount, "add_fixed_dofs");
    for (const component of optionalArray(entry.dofs, "fixed_dofs[].dofs"))
      fix(6 * vertex + requireComponent(component, vertex, "add_fixed_dofs"));
  }
  for (const entry of optionalArray(bcs.prescribed_dofs, "prescribed_dofs")) {
    if (!isRecord(entry))
      throw new Error("prescribed_dofs entries must be objects");
    const vertex = requireVertex(
      entry.vertex,
      nodeCount,
      "add_prescribed_dofs",
    );
    const component = requireComponent(
      entry.dof,
      vertex,
      "add_prescribed_dofs",
    );
    hold(
      6 * vertex + component,
      requireNumber(entry.value, `prescribed value at vertex ${vertex}`),
      true,
    );
  }

  const loads: [number, number][] = [];
  const points = optionalArray(bcs.point_loads, "point_loads");
  for (const entry of points) {
    if (!isRecord(entry))
      throw new Error("point_loads entries must be objects");
    const vertex = requireVertex(entry.vertex, nodeCount, "add_point_loads");
    for (const [key, offset] of [
      ["force", 0],
      ["moment", 3],
    ] as const) {
      const vector = optionalArray(entry[key], `point_loads[].${key}`);
      if (vector.length === 0) continue;
      if (vector.length !== 3)
        throw new Error(
          `point load at vertex ${vertex}: ${key} must have 3 components, got ${vector.length}`,
        );
      vector.forEach((value, component) =>
        loads.push([
          6 * vertex + offset + component,
          requireNumber(value, `point load ${key} at vertex ${vertex}`),
        ]),
      );
    }
  }
  return { fixedDofs, fixedValues, loads, loadCount: points.length };
}
