// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// The Rust Kirchhoff shell solve (crates/kofem-fem shell, KOF-306) against the
// C++ engine's solve_shell, which stays the oracle until MFEM leaves the build.
// Both take the SAME { mesh, mat_json, bcs_json } payload; the Rust side runs
// through solveShellInRust, the function the solver worker calls. Displacements
// and facet von Mises stresses must agree to the solvers' tolerance.
//
// Models:
//   - a folded three-panel bracket built by the app's own builder
//     (buildShellEngineInputs) from a store model: two materials, two gauges,
//     clamps, a roller, prescribed translation and rotation, point forces, a
//     moment, a pressure and a total-force surface load;
//   - a thin solid body marked Shell (test_files/single_fin.step, meshed by
//     the engine), idealised by preparePureShellSolve as the worker's pure
//     auto-shell path does;
//   - the plate-with-hole shell example (examples/gallery), as its generator
//     loads it;
//   - the shell cases of examples/validation and engine/tests/shell_validation:
//     the simply supported plate and the prescribed-displacement strip;
//   - payloads both must refuse.
//
// Usage:  bash ../scripts/build-fem-wasm.sh && bun tests/test_shell_rust.mjs
//         (from web/; the C++ engine comes from scripts/fetch-wasm-engine.sh)

import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { buildShellEngineInputs } from "../src/lib/solve/shell.ts";
import { solveShellInRust } from "../src/lib/solve/shellRust.ts";
import { preparePureShellSolve } from "../src/lib/solve/autoShell.ts";
import { loadFemModule } from "../src/lib/femModule.ts";
import { meshStep } from "../../examples/shell-coupling/lib.mjs";
import {
  nodesWhere,
  plateWithHoleShellMesh,
} from "../../examples/validation/lib/mesh.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const enginePkg = join(here, "../src/wasm/pkg");
const femPkg = join(here, "../src/wasm/fem");

let failures = 0;
function check(name, condition, detail) {
  console.log(
    `  [${condition ? "PASS" : "FAIL"}] ${name}${detail ? ` — ${detail}` : ""}`,
  );
  if (!condition) failures++;
}

const { default: createModule } = await import(
  join(enginePkg, "kofem_wasm_emcc.js")
);
const engine = await createModule({
  wasmBinary: readFileSync(join(enginePkg, "kofem_wasm_emcc.wasm")).buffer,
  print: () => {},
  printErr: () => {},
});
const { default: init, ShellModel } = await import(
  join(femPkg, "kofem_wasm.js")
);
await init({
  module_or_path: readFileSync(join(femPkg, "kofem_wasm_bg.wasm")),
});
// The shell idealisation (kofem-shellize) runs in the same Rust module, loaded
// the way the app loads it.
await loadFemModule();

const neverContinue = () => {
  throw new Error("the CG budget ran out — no continuation in this test");
};

// Solve one payload with both solvers. Returns the two results, or the two
// errors (null where a solver succeeded).
async function solveBoth(inputs) {
  let cpp;
  try {
    cpp = engine.solve_shell(inputs.mesh, inputs.matJson, inputs.bcsJson);
  } catch (thrown) {
    // The C++ BC readers throw past solve_shell's own error result; Emscripten
    // surfaces that as the exception's heap pointer.
    const message =
      typeof thrown === "number" && engine.getExceptionMessage
        ? engine.getExceptionMessage(thrown).join(": ")
        : String(thrown);
    cpp = { error: message };
  }
  let rust = null;
  let rustError = null;
  try {
    rust = await solveShellInRust(
      { ShellModel },
      inputs,
      undefined,
      neverContinue,
      () => {},
    );
  } catch (error) {
    rustError = String(error);
  }
  return { cpp, rust, rustError };
}

function maxAbs(values) {
  let largest = 0;
  for (const value of values) largest = Math.max(largest, Math.abs(value));
  return largest;
}

function relativeDifference(lhs, rhs) {
  let difference = 0;
  for (let i = 0; i < lhs.length; i++)
    difference = Math.max(difference, Math.abs(lhs[i] - rhs[i]));
  return difference / maxAbs(lhs);
}

// Agreement bound: both stop at ‖r‖/‖f‖ < 1e-10, but take different CG paths
// (preconditioner details differ in floating-point order), so their answers
// differ by the remaining algebraic error, not by round-off.
const AGREE = 1e-6;

async function compare(name, inputs) {
  console.log(`${name}:`);
  const { cpp, rust, rustError } = await solveBoth(inputs);
  if ("error" in cpp) {
    check(`${name}: C++ solves`, false, cpp.error);
    return null;
  }
  if (rust === null) {
    check(`${name}: Rust solves`, false, rustError);
    return null;
  }
  check(
    `${name}: same result sizes`,
    rust.displacements.length === cpp.displacements.length &&
      rust.von_mises.length === cpp.von_mises.length,
  );
  const du = relativeDifference(cpp.displacements, rust.displacements);
  const ds = relativeDifference(cpp.von_mises, rust.von_mises);
  check(
    `${name}: displacements agree`,
    du < AGREE,
    `max |u| ${maxAbs(cpp.displacements).toExponential(3)}, Rust − C++ ${du.toExponential(2)} relative`,
  );
  check(
    `${name}: von Mises agrees`,
    ds < AGREE,
    `max σ ${maxAbs(cpp.von_mises).toExponential(3)}, Rust − C++ ${ds.toExponential(2)} relative`,
  );
  console.log(
    `    CG iterations: C++ ${cpp.iterations}, Rust ${rust.iterations}`,
  );
  return { cpp, rust };
}

// ── 1. Folded bracket, through the app's builder ─────────────────────────────
//
// Panel A: z = 0, x ∈ [0, 60], y ∈ [0, 40] (steel, t = 2), clamped at x = 0.
// Panel B: folded up at x = 60, z ∈ [0, 30] (aluminium, t = 3).
// Panel C: folded again at z = 30, leaning back at 35° (steel, t = 2).
function foldedBracket() {
  const nodes = [];
  const elements = [];
  const idOf = new Map();
  const node = (x, y, z) => {
    const key = `${x.toFixed(9)},${y.toFixed(9)},${z.toFixed(9)}`;
    let id = idOf.get(key);
    if (id === undefined) {
      id = 1000 + nodes.length; // ids offset from vertex indices
      idOf.set(key, id);
      nodes.push({ id, x, y, z });
    }
    return id;
  };
  const panel = (corner, alongU, alongV, cellsU, cellsV, propertyId) => {
    const at = (i, j) =>
      node(
        ...[0, 1, 2].map(
          (k) =>
            corner[k] + (alongU[k] * i) / cellsU + (alongV[k] * j) / cellsV,
        ),
      );
    for (let i = 0; i < cellsU; i++)
      for (let j = 0; j < cellsV; j++) {
        const [a0, a1, a2, a3] = [
          at(i, j),
          at(i + 1, j),
          at(i + 1, j + 1),
          at(i, j + 1),
        ];
        // Alternate the diagonal so the mesh is not all one orientation.
        const tris =
          (i + j) % 2 === 0
            ? [
                [a0, a1, a2],
                [a0, a2, a3],
              ]
            : [
                [a0, a1, a3],
                [a1, a2, a3],
              ];
        for (const nodeIds of tris)
          elements.push({
            id: elements.length + 1,
            type: "CTRIA3",
            nodeIds,
            propertyId,
          });
      }
  };
  const lean = (35 * Math.PI) / 180;
  panel([0, 0, 0], [60, 0, 0], [0, 40, 0], 12, 8, 1);
  panel([60, 0, 0], [0, 0, 30], [0, 40, 0], 6, 8, 2);
  panel(
    [60, 0, 30],
    [25 * Math.sin(lean), 0, 25 * Math.cos(lean)],
    [0, 40, 0],
    5,
    8,
    1,
  );

  const nodeAt = (x, y, z) => {
    const id = idOf.get(`${x.toFixed(9)},${y.toFixed(9)},${z.toFixed(9)}`);
    if (id === undefined) throw new Error(`no node at ${x}, ${y}, ${z}`);
    return id;
  };
  const constraints = [];
  for (const { id, x } of nodes)
    if (x === 0)
      for (let dof = 0; dof < 6; dof++) constraints.push({ nodeId: id, dof });
  // A roller and a prescribed translation and rotation on panel A.
  constraints.push({ nodeId: nodeAt(30, 0, 0), dof: 1 });
  constraints.push({
    nodeId: nodeAt(30, 40, 0),
    dof: 2,
    prescribedValue: 0.05,
  });
  constraints.push({
    nodeId: nodeAt(45, 20, 0),
    dof: 4,
    prescribedValue: 1e-3,
  });

  const tipX = 60 + 25 * Math.sin(lean);
  const tipZ = 30 + 25 * Math.cos(lean);
  const loads = [
    { nodeId: nodeAt(tipX, 0, tipZ), dof: 0, value: -150 },
    { nodeId: nodeAt(tipX, 40, tipZ), dof: 2, value: 80 },
    { nodeId: nodeAt(tipX, 20, tipZ), dof: 3, value: 2500 },
  ];
  // Pressure on panel B, total force on a strip of panel A.
  const facesOf = (predicate) =>
    elements
      .filter((element) =>
        element.nodeIds.every((nodeId) =>
          predicate(nodes.find((candidate) => candidate.id === nodeId)),
        ),
      )
      .map((element) => element.nodeIds);
  const surfaceLoads = [
    {
      type: "pressure",
      faces: facesOf((point) => Math.abs(point.x - 60) < 1e-9),
      pressure: 0.4,
    },
    {
      type: "force",
      faces: facesOf((point) => point.z === 0 && point.x >= 50),
      force: [0, 120, -300],
    },
  ];
  return {
    nodes,
    elements,
    materials: [
      { id: 1, name: "Steel", young: 210000, poisson: 0.3, density: 7.85e-9 },
      {
        id: 2,
        name: "Aluminium",
        young: 70000,
        poisson: 0.33,
        density: 2.7e-9,
      },
    ],
    properties: [
      { id: 1, materialId: 1, thickness: 2 },
      { id: 2, materialId: 2, thickness: 3 },
    ],
    constraints,
    loads,
    surfaceLoads,
  };
}

await compare(
  "folded bracket (app builder)",
  buildShellEngineInputs(foldedBracket()),
);

// ── 2. A thin body marked Shell, idealised at solve time ─────────────────────
{
  const meshed = meshStep(
    engine,
    join(here, "../../test_files/single_fin.step"),
    { maxElementSize: 4 },
  );
  const nodes = [];
  for (let i = 0; i < meshed.V.length / 3; i++)
    nodes.push({
      id: i + 1,
      x: meshed.V[3 * i],
      y: meshed.V[3 * i + 1],
      z: meshed.V[3 * i + 2],
    });
  const elements = [];
  for (let e = 0; e < meshed.tet.length / 4; e++)
    elements.push({
      id: e + 1,
      type: "CTETRA",
      nodeIds: meshed.tet.slice(4 * e, 4 * e + 4).map((vertex) => vertex + 1),
      propertyId: 1,
    });
  const surfaceTriangles = [];
  for (let t = 0; t < meshed.surfTri.length / 3; t++)
    surfaceTriangles.push([0, 1, 2].map((k) => meshed.surfTri[3 * t + k] + 1));
  // The fin is a 2 mm wall on y = 50 hanging from z = 0 to its tip at
  // z ≈ −92.5. Clamp everything at and above the root, push the tip out of
  // plane (bending).
  const tipZ = Math.min(...nodes.map((point) => point.z));
  const payload = {
    nodes,
    elements,
    materials: [
      {
        id: 1,
        name: "Aluminium",
        young: 70000,
        poisson: 0.33,
        density: 2.7e-9,
      },
    ],
    properties: [{ id: 1, materialId: 1, discretization: "shell" }],
    constraints: nodes
      .filter((point) => point.z > -1e-6)
      .flatMap((point) => [0, 1, 2].map((dof) => ({ nodeId: point.id, dof }))),
    loads: nodes
      .filter((point) => point.z < tipZ + 1e-6)
      .map((point) => ({ nodeId: point.id, dof: 1, value: 2 })),
    surfaceTriangles,
    surfaceFaceIds: Array.from(meshed.surfFace),
  };
  const pure = preparePureShellSolve(payload, new Set([1]), () => {});
  check("single fin: idealised as a pure shell", pure !== null);
  if (pure) {
    const result = await compare("single fin (auto-shell)", pure);
    if (result) {
      const cppFields = pure.mapResult(result.cpp);
      const rustFields = pure.mapResult(result.rust);
      const du = relativeDifference(
        cppFields.displacements,
        rustFields.displacements,
      );
      const ds = relativeDifference(cppFields.vonMises, rustFields.vonMises);
      check(
        "single fin: fields mapped back onto the tets agree",
        du < AGREE && ds < AGREE,
        `displacements ${du.toExponential(2)}, von Mises ${ds.toExponential(2)} relative`,
      );
    }
  }
}

// ── 3. Plate with a hole, shells (examples/gallery) ──────────────────────────
{
  const radius = 1000;
  const halfWidth = 10000;
  const thickness = 500;
  const stress = 100;
  const plate = plateWithHoleShellMesh(radius, halfWidth, 12, 64, 2);
  const left = nodesWhere(plate.vertices, (x) => x <= -halfWidth + 1e-6);
  const right = nodesWhere(plate.vertices, (x) => x >= halfWidth - 1e-6).sort(
    (i, j) => plate.vertices[i][1] - plate.vertices[j][1],
  );
  const forceAt = new Map(right.map((vertex) => [vertex, 0]));
  for (let k = 0; k + 1 < right.length; k++) {
    const length =
      plate.vertices[right[k + 1]][1] - plate.vertices[right[k]][1];
    const share = (stress * thickness * length) / 2;
    forceAt.set(right[k], forceAt.get(right[k]) + share);
    forceAt.set(right[k + 1], forceAt.get(right[k + 1]) + share);
  }
  const result = await compare("plate with a hole (gallery example)", {
    mesh: {
      vertices: Float64Array.from(plate.vertices.flat()),
      triangles: Int32Array.from(plate.triangles.flat()),
    },
    matJson: JSON.stringify({
      young_modulus: 210000,
      poisson_ratio: 0.3,
      density: 7.85e-9,
      thickness,
    }),
    bcsJson: JSON.stringify({
      fixed_vertices: left,
      point_loads: [...forceAt.entries()].map(([vertex, fx]) => ({
        vertex,
        force: [fx, 0, 0],
      })),
    }),
  });
  if (result) {
    let peak = 0;
    for (let e = 0; e < 2 * plate.nth; e++)
      peak = Math.max(peak, result.rust.von_mises[e]);
    const kt = peak / stress;
    check(
      "plate with a hole: Rust Kt near Kirsch's 3",
      Math.abs(kt - 3) / 3 < 0.1,
      `Kt = ${kt.toFixed(3)}`,
    );
  }
}

// ── 4. Validation cases ──────────────────────────────────────────────────────

function gridPlate(sizeX, sizeY, cellsX, cellsY) {
  const vertices = [];
  const triangles = [];
  const id = (i, j) => i * (cellsY + 1) + j;
  for (let i = 0; i <= cellsX; i++)
    for (let j = 0; j <= cellsY; j++)
      vertices.push((sizeX * i) / cellsX, (sizeY * j) / cellsY, 0);
  for (let i = 0; i < cellsX; i++)
    for (let j = 0; j < cellsY; j++) {
      const [a0, a1, a2, a3] = [
        id(i, j),
        id(i + 1, j),
        id(i + 1, j + 1),
        id(i, j + 1),
      ];
      triangles.push(a0, a1, a2, a0, a2, a3);
    }
  return { vertices, triangles, id };
}

// Simply supported square plate under uniform pressure (Timoshenko).
{
  const cells = 16;
  const side = 1;
  const pressure = 1;
  const { vertices, triangles, id } = gridPlate(side, side, cells, cells);
  const fixed_dofs = [];
  const force = new Map();
  for (let i = 0; i <= cells; i++)
    for (let j = 0; j <= cells; j++) {
      const edge = i === 0 || i === cells || j === 0 || j === cells;
      fixed_dofs.push({
        vertex: id(i, j),
        dofs: edge ? [0, 1, 2, 5] : [0, 1, 5],
      });
    }
  const area = (side / cells) ** 2 / 2;
  for (const vertex of triangles)
    force.set(vertex, (force.get(vertex) ?? 0) + (pressure * area) / 3);
  const result = await compare("simply supported plate (validation)", {
    mesh: {
      vertices: Float64Array.from(vertices),
      triangles: Int32Array.from(triangles),
    },
    matJson: JSON.stringify({
      young_modulus: 1e7,
      poisson_ratio: 0.3,
      thickness: 0.01,
    }),
    bcsJson: JSON.stringify({
      fixed_dofs,
      point_loads: [...force.entries()].map(([vertex, fz]) => ({
        vertex,
        force: [0, 0, fz],
      })),
    }),
  });
  if (result) {
    const rigidity = (1e7 * 0.01 ** 3) / (12 * (1 - 0.09));
    const reference = (0.00406 * pressure * side ** 4) / rigidity;
    const centre = id(cells / 2, cells / 2);
    const deflection = result.rust.displacements[3 * centre + 2];
    check(
      "simply supported plate: Rust within 2% of plate theory",
      Math.abs(deflection - reference) / reference < 0.02,
      `w = ${deflection.toExponential(4)}, theory ${reference.toExponential(4)}`,
    );
  }
}

// Prescribed membrane extension of a strip (shell-prescribed-displacement.test).
{
  const [nx, ny] = [8, 2];
  const delta = 1e-4;
  const { vertices, triangles, id } = gridPlate(1, 0.25, nx, ny);
  const fixed_dofs = [];
  const prescribed_dofs = [];
  for (let i = 0; i <= nx; i++)
    for (let j = 0; j <= ny; j++) {
      const dofs = [2, 3, 4, 5];
      if (i === 0) dofs.push(0);
      if (j === 0) dofs.push(1);
      fixed_dofs.push({ vertex: id(i, j), dofs });
      if (i === nx)
        prescribed_dofs.push({ vertex: id(i, j), dof: 0, value: delta });
    }
  const result = await compare("prescribed strip (validation)", {
    mesh: {
      vertices: Float64Array.from(vertices),
      triangles: Int32Array.from(triangles),
    },
    matJson: JSON.stringify({
      young_modulus: 210e9,
      poisson_ratio: 0.3,
      thickness: 0.01,
    }),
    bcsJson: JSON.stringify({ fixed_dofs, prescribed_dofs }),
  });
  if (result) {
    const corner = id(nx, ny);
    const contraction = result.rust.displacements[3 * corner + 1];
    check(
      "prescribed strip: Rust reaches δ with the Poisson contraction",
      Math.abs(result.rust.displacements[3 * corner] - delta) < 1e-12 &&
        Math.abs(contraction - -0.3 * delta * 0.25) < 1e-12,
      `ux ${result.rust.displacements[3 * corner].toExponential(6)}, uy ${contraction.toExponential(6)}`,
    );
  }
}

// ── 5. Payloads both must refuse ─────────────────────────────────────────────
console.log("refusals:");
{
  const { vertices, triangles } = gridPlate(1, 1, 2, 2);
  const mesh = {
    vertices: Float64Array.from(vertices),
    triangles: Int32Array.from(triangles),
  };
  const clamp = { fixed_vertices: [0, 1, 2] };
  const material = { young_modulus: 1e7, poisson_ratio: 0.3, thickness: 0.01 };
  const cases = [
    [
      "missing thickness",
      {
        mesh,
        matJson: JSON.stringify({ young_modulus: 1e7, poisson_ratio: 0.3 }),
        bcsJson: JSON.stringify(clamp),
      },
      /missing thickness/,
    ],
    [
      "thickness field and uniform thickness",
      {
        mesh: { ...mesh, thicknesses: new Float64Array(8).fill(0.01) },
        matJson: JSON.stringify(material),
        bcsJson: JSON.stringify(clamp),
      },
      /not both/,
    ],
    [
      "two materials without attributes",
      {
        mesh: { ...mesh, thicknesses: new Float64Array(8).fill(0.01) },
        matJson: JSON.stringify([
          { young_modulus: 1e7, poisson_ratio: 0.3 },
          { young_modulus: 2e7, poisson_ratio: 0.3 },
        ]),
        bcsJson: JSON.stringify(clamp),
      },
      /no mesh\.attributes/,
    ],
    [
      "vertex out of range",
      {
        mesh,
        matJson: JSON.stringify(material),
        bcsJson: JSON.stringify({ fixed_vertices: [0, 99] }),
      },
      /out of range/,
    ],
    [
      "shell DOF component 6",
      {
        mesh,
        matJson: JSON.stringify(material),
        bcsJson: JSON.stringify({ fixed_dofs: [{ vertex: 0, dofs: [6] }] }),
      },
      /expected 0\.\.5/,
    ],
    [
      "conflicting prescribed values",
      {
        mesh,
        matJson: JSON.stringify(material),
        bcsJson: JSON.stringify({
          ...clamp,
          prescribed_dofs: [
            { vertex: 4, dof: 2, value: 1e-3 },
            { vertex: 4, dof: 2, value: 2e-3 },
          ],
        }),
      },
      /vertex 4 component Uz \(DOF 2\) is prescribed to 0\.001 and also prescribed to 0\.002/,
    ],
    [
      "fixed and prescribed to different values",
      {
        mesh,
        matJson: JSON.stringify(material),
        bcsJson: JSON.stringify({
          fixed_vertices: [0, 1, 2, 4],
          prescribed_dofs: [{ vertex: 4, dof: 2, value: 1e-3 }],
        }),
      },
      /fixed to 0 and also prescribed to 0\.001/,
    ],
    [
      "unconstrained model",
      {
        mesh,
        matJson: JSON.stringify(material),
        bcsJson: JSON.stringify({
          point_loads: [{ vertex: 4, force: [0, 0, 1] }],
        }),
      },
      /positive definite|did not converge|breakdown/,
    ],
  ];
  for (const [name, inputs, pattern] of cases) {
    const { cpp, rust, rustError } = await solveBoth(inputs);
    const cppRefused = "error" in cpp;
    check(
      `${name}: both refuse`,
      cppRefused && rust === null && pattern.test(rustError),
      `C++ "${cppRefused ? cpp.error : "solved"}", Rust "${rustError ?? "solved"}"`,
    );
  }
}

console.log(failures === 0 ? "\nPASS" : `\n${failures} check(s) FAILED`);
process.exit(failures === 0 ? 0 : 1);
