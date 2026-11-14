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
//   - payloads both must refuse;
//   - a pressure on the pure and the coupled auto-shell paths (single fin,
//     fin_two_parts), which must push into the body on every face whatever
//     the winding the app gives the face.

import { beforeAll, describe, expect, test } from "bun:test";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { buildShellEngineInputs } from "../../src/lib/solve/shell.ts";
import { solveShellInRust } from "../../src/lib/solve/shellRust.ts";
import {
  prepareAutoCoupledSolve,
  prepareAutoShellSolve,
  preparePureShellSolve,
} from "../../src/lib/solve/autoShell.ts";
import { rebuildSurfaceLoads } from "../../src/store/boundaryRebuild.ts";
import { meshStep } from "../../../examples/shell-coupling/lib.mjs";
import {
  nodesWhere,
  plateWithHoleShellMesh,
} from "../../../examples/validation/lib/mesh.mjs";
import { loadEngine, loadFem } from "../support/wasm.mjs";

const here = dirname(fileURLToPath(import.meta.url));

// One engine instance and the Rust module serve every test below. The engine's
// log stays dropped: the tests assert on results, and the refusal cases EXPECT
// failures.
let engine = null;
let ShellModel = null;
beforeAll(async () => {
  engine = await loadEngine();
  // The shell idealisation (kofem-shellize) runs in the same Rust module.
  ({ ShellModel } = await loadFem());
});

const neverContinue = () => {
  throw new Error("the CG budget ran out — no continuation in this test");
};

// Solve one payload with both solvers. Returns the two results, or the two
// errors (null where a solver succeeded).
async function solveBoth(inputs) {
  let cpp = null;
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
      () => {
        /* solve log lines; the comparison checks results only */
      },
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

// Registers the tests every comparison shares. `getResult` returns what
// solveBoth gave for the model; it is read inside each test, after beforeAll.
function agreementTests(getResult) {
  test("the C++ solver solves it", () => {
    const { cpp } = getResult();
    expect("error" in cpp, cpp.error).toBe(false);
  });

  test("the Rust solver solves it", () => {
    const { rust, rustError } = getResult();
    expect(rust, rustError).not.toBeNull();
  });

  test("both return the same result sizes", () => {
    const { cpp, rust } = getResult();
    expect(rust.displacements).toHaveLength(cpp.displacements.length);
    expect(rust.von_mises).toHaveLength(cpp.von_mises.length);
  });

  test("displacements agree", () => {
    const { cpp, rust } = getResult();
    const difference = relativeDifference(
      cpp.displacements,
      rust.displacements,
    );
    expect(
      difference,
      `max |u| ${maxAbs(cpp.displacements).toExponential(3)}, Rust − C++ ${difference.toExponential(2)} relative`,
    ).toBeLessThan(AGREE);
  });

  test("von Mises agrees", () => {
    const { cpp, rust } = getResult();
    const difference = relativeDifference(cpp.von_mises, rust.von_mises);
    expect(
      difference,
      `max σ ${maxAbs(cpp.von_mises).toExponential(3)}, Rust − C++ ${difference.toExponential(2)} relative`,
    ).toBeLessThan(AGREE);
  });
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

describe("folded bracket (app builder)", () => {
  let result = null;
  beforeAll(async () => {
    result = await solveBoth(buildShellEngineInputs(foldedBracket()));
  });
  agreementTests(() => result);
});

describe("single fin (auto-shell)", () => {
  let pure = null;
  let result = null;
  beforeAll(async () => {
    const meshed = meshStep(
      engine,
      join(here, "../../../test_files/single_fin.step"),
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
      surfaceTriangles.push(
        [0, 1, 2].map((k) => meshed.surfTri[3 * t + k] + 1),
      );
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
        .flatMap((point) =>
          [0, 1, 2].map((dof) => ({ nodeId: point.id, dof })),
        ),
      loads: nodes
        .filter((point) => point.z < tipZ + 1e-6)
        .map((point) => ({ nodeId: point.id, dof: 1, value: 2 })),
      surfaceTriangles,
      surfaceFaceIds: Array.from(meshed.surfFace),
    };
    pure = preparePureShellSolve(payload, new Set([1]), () => {
      /* auto-shell progress lines are not asserted on */
    });
    if (pure !== null) result = await solveBoth(pure);
  });

  test("the thin body is idealised as a pure shell", () => {
    expect(pure).not.toBeNull();
  });

  agreementTests(() => result);

  test("fields mapped back onto the tets agree", () => {
    const cppFields = pure.mapResult(result.cpp);
    const rustFields = pure.mapResult(result.rust);
    const displacements = relativeDifference(
      cppFields.displacements,
      rustFields.displacements,
    );
    const vonMises = relativeDifference(
      cppFields.vonMises,
      rustFields.vonMises,
    );
    const detail = `displacements ${displacements.toExponential(2)}, von Mises ${vonMises.toExponential(2)} relative`;
    expect(displacements, detail).toBeLessThan(AGREE);
    expect(vonMises, detail).toBeLessThan(AGREE);
  });
});

describe("plate with a hole (gallery example)", () => {
  const radius = 1000;
  const halfWidth = 10000;
  const thickness = 500;
  const stress = 100;
  let plate = null;
  let result = null;
  beforeAll(async () => {
    plate = plateWithHoleShellMesh(radius, halfWidth, 12, 64, 2);
    const left = nodesWhere(plate.vertices, (x) => x <= -halfWidth + 1e-6);
    const right = nodesWhere(plate.vertices, (x) => x >= halfWidth - 1e-6).sort(
      (lhs, rhs) => plate.vertices[lhs][1] - plate.vertices[rhs][1],
    );
    const forceAt = new Map(right.map((vertex) => [vertex, 0]));
    for (let k = 0; k + 1 < right.length; k++) {
      const length =
        plate.vertices[right[k + 1]][1] - plate.vertices[right[k]][1];
      const share = (stress * thickness * length) / 2;
      forceAt.set(right[k], forceAt.get(right[k]) + share);
      forceAt.set(right[k + 1], forceAt.get(right[k + 1]) + share);
    }
    result = await solveBoth({
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
  });

  agreementTests(() => result);

  test("Rust Kt is near Kirsch's 3", () => {
    let peak = 0;
    for (let e = 0; e < 2 * plate.nth; e++)
      peak = Math.max(peak, result.rust.von_mises[e]);
    const kt = peak / stress;
    expect(Math.abs(kt - 3) / 3, `Kt = ${kt.toFixed(3)}`).toBeLessThan(0.1);
  });
});

describe("shell validation cases", () => {
  // Simply supported square plate under uniform pressure (Timoshenko).
  describe("simply supported plate", () => {
    const cells = 16;
    const side = 1;
    const pressure = 1;
    let plateId = null;
    let result = null;
    beforeAll(async () => {
      const { vertices, triangles, id } = gridPlate(side, side, cells, cells);
      plateId = id;
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
      result = await solveBoth({
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
    });

    agreementTests(() => result);

    test("Rust is within 2% of plate theory", () => {
      const rigidity = (1e7 * 0.01 ** 3) / (12 * (1 - 0.09));
      const reference = (0.00406 * pressure * side ** 4) / rigidity;
      const centre = plateId(cells / 2, cells / 2);
      const deflection = result.rust.displacements[3 * centre + 2];
      expect(
        Math.abs(deflection - reference) / reference,
        `w = ${deflection.toExponential(4)}, theory ${reference.toExponential(4)}`,
      ).toBeLessThan(0.02);
    });
  });

  // Prescribed membrane extension of a strip (shell-prescribed-displacement.test).
  describe("prescribed strip", () => {
    const [nx, ny] = [8, 2];
    const delta = 1e-4;
    let stripId = null;
    let result = null;
    beforeAll(async () => {
      const { vertices, triangles, id } = gridPlate(1, 0.25, nx, ny);
      stripId = id;
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
      result = await solveBoth({
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
    });

    agreementTests(() => result);

    test("Rust reaches δ with the Poisson contraction", () => {
      const corner = stripId(nx, ny);
      const extension = result.rust.displacements[3 * corner];
      const contraction = result.rust.displacements[3 * corner + 1];
      const detail = `ux ${extension.toExponential(6)}, uy ${contraction.toExponential(6)}`;
      expect(Math.abs(extension - delta), detail).toBeLessThan(1e-12);
      expect(Math.abs(contraction - -0.3 * delta * 0.25), detail).toBeLessThan(
        1e-12,
      );
    });
  });
});

// ── Payloads both must refuse ────────────────────────────────────────────────
describe("payloads both solvers refuse", () => {
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

  test.each(cases)("%s: both refuse", async (_name, inputs, pattern) => {
    const { cpp, rust, rustError } = await solveBoth(inputs);
    const detail = `C++ "${"error" in cpp ? cpp.error : "solved"}", Rust "${rustError ?? "solved"}"`;
    expect("error" in cpp, detail).toBe(true);
    expect(rust, detail).toBeNull();
    expect(rustError, detail).toMatch(pattern);
  });
});

// A STEP file of test_files meshed by the engine as the app meshes it, as an
// all-tet store model with `properties` and no boundary conditions.
function meshModel(file, size, propertyOf, properties) {
  const meshed = meshStep(engine, join(here, "../../../test_files", file), {
    maxElementSize: size,
  });
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
      propertyId: propertyOf(meshed, e),
    });
  const surfaceTriangles = [];
  for (let t = 0; t < meshed.surfTri.length / 3; t++)
    surfaceTriangles.push([0, 1, 2].map((k) => meshed.surfTri[3 * t + k] + 1));
  return {
    nodes,
    elements,
    materials: [
      { id: 1, name: "Steel", young: 210000, poisson: 0.3, density: 7.85e-9 },
    ],
    properties,
    constraints: [],
    loads: [],
    surfaceTriangles,
    surfaceFaceIds: Array.from(meshed.surfFace),
  };
}

// ── A pressure on the auto-shell paths pushes into the solid ─────────────────
// The surface-load faces come from the app's rebuildSurfaceLoads, wound as
// their tets' local face lists (inward on some faces). Whatever the winding,
// a pressure p on a face of outward normal n must add up to −p·A·n.
describe("pressure on the auto-shell paths", () => {
  const pressure = 0.5;
  // A pressure group on the nodes `on` selects, as the app builds it, and
  // the area its faces cover.
  const pressureOn = (model, on) => {
    const nodeIds = model.nodes.filter(on).map((point) => point.id);
    const [load] = rebuildSurfaceLoads(
      [
        {
          id: 1,
          name: "Pressure",
          kind: "pressure",
          dof: 0,
          totalForce: pressure,
          faces: [{ nodeIds }],
        },
      ],
      model.elements,
    );
    const at = (id) => {
      const point = model.nodes[id - 1];
      return [point.x, point.y, point.z];
    };
    let area = 0;
    for (const [a, b, c] of load.faces.map((face) => face.map(at))) {
      const ab = [0, 1, 2].map((k) => b[k] - a[k]);
      const ac = [0, 1, 2].map((k) => c[k] - a[k]);
      area +=
        Math.hypot(
          ab[1] * ac[2] - ab[2] * ac[1],
          ab[2] * ac[0] - ab[0] * ac[2],
          ab[0] * ac[1] - ab[1] * ac[0],
        ) / 2;
    }
    return { load, area };
  };
  const expectResultant = (resultant, expected) => {
    const scale = Math.hypot(...expected);
    const error = Math.hypot(...resultant.map((v, k) => v - expected[k]));
    expect(
      error,
      `resultant [${resultant.map((v) => v.toFixed(3)).join(", ")}] against ` +
        `[${expected.map((v) => v.toFixed(3)).join(", ")}]`,
    ).toBeLessThan(1e-6 * scale);
  };
  const quiet = () => {
    /* auto-shell progress lines are not asserted on */
  };

  // Pure shell: the single fin's y = 51 wall (outward normal +y).
  describe("pure auto-shell", () => {
    let finModel = null;
    beforeAll(() => {
      finModel = meshModel("single_fin.step", 4, () => 1, [
        { id: 1, materialId: 1, discretization: "shell" },
      ]);
    });

    test("pressure on the fin's outer wall", () => {
      const yMax = Math.max(...finModel.nodes.map((point) => point.y));
      const { load, area } = pressureOn(finModel, (p) => p.y > yMax - 1e-6);
      const pure = preparePureShellSolve(
        { ...finModel, surfaceLoads: [load] },
        new Set([1]),
        quiet,
      );
      const resultant = [0, 0, 0];
      for (const { force } of JSON.parse(pure.bcsJson).point_loads)
        if (force) for (let k = 0; k < 3; k++) resultant[k] += force[k];
      expectResultant(resultant, [0, -pressure * area, 0]);
    });
  });

  // Coupled auto-shell: fin_two_parts with the fin (body 2) marked Shell; a
  // pressure on the base block's top (outward +z) and on the fin's wall.
  describe("coupled auto-shell", () => {
    let model = null;
    const inBody = (body) => {
      const ids = new Set(
        model.elements
          .filter((element) => element.propertyId === body)
          .flatMap((element) => element.nodeIds),
      );
      return (point) => ids.has(point.id);
    };
    beforeAll(() => {
      model = meshModel(
        "fin_two_parts.step",
        6,
        (meshed, e) => meshed.body[e],
        [
          { id: 1, materialId: 1, discretization: "solid" },
          { id: 2, materialId: 1, discretization: "shell" },
        ],
      );
    });

    const coupledResultant = (on, normal) => {
      const { load, area } = pressureOn(model, on);
      const coupled = prepareAutoCoupledSolve(
        { ...model, surfaceLoads: [load] },
        new Set([2]),
        quiet,
      );
      const resultant = [0, 0, 0];
      coupled.bcs.load_dofs.forEach((dof, index) => {
        if (dof % 6 < 3) resultant[dof % 6] += coupled.bcs.load_vals[index];
      });
      expectResultant(
        resultant,
        normal.map((component) => -pressure * area * component),
      );
    };

    test("pressure on the solid base's top", () => {
      const zMax = Math.max(
        ...model.nodes.filter(inBody(1)).map((point) => point.z),
      );
      coupledResultant((p) => inBody(1)(p) && p.z > zMax - 1e-6, [0, 0, 1]);
    });

    test("pressure on the shelled fin's wall", () => {
      const yMax = Math.max(
        ...model.nodes.filter(inBody(2)).map((point) => point.y),
      );
      coupledResultant((p) => inBody(2)(p) && p.y > yMax - 1e-6, [0, 1, 0]);
    });
  });
});

// ── Which auto-shell path a Shell body takes, or why it takes none ───────────
// A body marked Shell is solved as shells — coupled to the solid bodies it
// touches, or as a pure shell when every body is Shell — or the solve fails
// naming the body. It is never solved as solid (KOF-352).
describe("auto-shell path choice", () => {
  const quiet = () => {
    /* auto-shell progress lines are not asserted on */
  };
  const finProperties = [{ id: 1, materialId: 1, discretization: "shell" }];

  test("a single thin body marked Shell solves as a pure shell", () => {
    const fin = meshModel("single_fin.step", 4, () => 1, finProperties);
    expect(prepareAutoShellSolve(fin, new Set([1]), quiet).kind).toBe("pure");
  });

  test("a Shell body standing on a solid body solves coupled", () => {
    const model = meshModel(
      "fin_two_parts.step",
      6,
      (meshed, e) => meshed.body[e],
      [
        { id: 1, materialId: 1, discretization: "solid" },
        { id: 2, materialId: 1, discretization: "shell" },
      ],
    );
    expect(prepareAutoShellSolve(model, new Set([2]), quiet).kind).toBe(
      "coupled",
    );
  });

  // The fin of fin_two_parts (body 2, Shell) without its base, and a copy of
  // it 500 mm away (body 1, Solid): the shell touches no solid body, and not
  // every body is Shell.
  test("a Shell body that touches no solid body is refused, naming the body", () => {
    const parts = meshModel(
      "fin_two_parts.step",
      6,
      (meshed, e) => meshed.body[e],
      [],
    );
    const finElements = parts.elements.filter(
      (element) => element.propertyId === 2,
    );
    const finIds = new Set(finElements.flatMap((element) => element.nodeIds));
    const finNodes = parts.nodes.filter((point) => finIds.has(point.id));
    const offset = Math.max(...parts.nodes.map((point) => point.id));
    const finSurface = parts.surfaceTriangles
      .map((tri, index) => ({ tri, face: parts.surfaceFaceIds[index] }))
      .filter(({ tri }) => tri.every((id) => finIds.has(id)));
    const faceOffset = Math.max(...parts.surfaceFaceIds) + 1;
    const model = {
      ...parts,
      nodes: [
        ...finNodes,
        ...finNodes.map((point) => ({
          ...point,
          id: point.id + offset,
          x: point.x + 500,
        })),
      ],
      elements: [
        ...finElements,
        ...finElements.map((element) => ({
          ...element,
          id: element.id + parts.elements.length,
          nodeIds: element.nodeIds.map((id) => id + offset),
          propertyId: 1,
        })),
      ],
      properties: [
        { id: 1, materialId: 1, discretization: "solid" },
        { id: 2, materialId: 1, discretization: "shell" },
      ],
      surfaceTriangles: [
        ...finSurface.map(({ tri }) => tri),
        ...finSurface.map(({ tri }) => tri.map((id) => id + offset)),
      ],
      surfaceFaceIds: [
        ...finSurface.map(({ face }) => face),
        ...finSurface.map(({ face }) => face + faceOffset),
      ],
    };
    expect(() => prepareAutoShellSolve(model, new Set([2]), quiet)).toThrow(
      /Body 2 is marked "Shell".*touches no solid body/,
    );
  });
});
