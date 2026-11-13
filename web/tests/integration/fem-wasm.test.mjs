// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Rust finite-element module (crates/kofem-wasm) against the MFEM engine.
//
// Both solve the same linear-tet cantilever: same mesh, supports and nodal
// loads, the same CG method (one symmetric Gauss–Seidel sweep, relative
// tolerance 1e-6 in the preconditioned norm). Their displacements must agree
// to the solver tolerance, so any difference in the element, the assembly or
// the boundary-condition handling shows up here. The Rust multigrid
// preconditioner (SA-AMG), stopped on the force residual ‖f − K·u‖/‖f‖, must
// reach the same displacements. A clamped cantilever of
// linear tets is stiff in bending, so the beam-theory check only bounds the
// result from above.
//
// Quadratic (order 2) tets are then checked the same way, displacements and
// element von Mises stress, on the cantilever and on a thin wall one element
// thick that carries a pressure surface load (6-node faces) and a prescribed
// displacement (extended to the edge nodes, as in MFEM).
//
// Hexahedra (8- and 27-node) follow, on a distorted hex cantilever and on a
// mixed one (tets at the root, hexes at the tip, two materials), loaded by a
// total force on quadrilateral faces and a pressure on warped ones, and on a
// bar whose tip hex is collapsed into a wedge.

import { beforeAll, describe, expect, test } from "bun:test";
import { boxHexMesh } from "../../../examples/validation/lib/mesh.mjs";
import { ElasticModel, SolveOptions } from "../../src/wasm/fem/kofem_wasm.js";
import { loadEngine, loadFem } from "../support/wasm.mjs";

// ── Mesh: a box of hexes, each split into six tets (Kuhn) ─────────────────────
const LENGTH = 100;
const WIDTH = 10;
const HEIGHT = 10;
const box = boxHexMesh(LENGTH, WIDTH, HEIGHT, 40, 4, 4);
// Hex corner order (MFEM AddHex) for each Kuhn cube corner bx + 2·by + 4·bz.
const HEX_OF_CUBE_CORNER = [0, 1, 3, 2, 4, 5, 7, 6];
const KUHN = [
  [0, 1, 3, 7],
  [0, 3, 2, 7],
  [0, 2, 6, 7],
  [0, 6, 4, 7],
  [0, 4, 5, 7],
  [0, 5, 1, 7],
];
const tetList = [];
for (const hex of box.hexahedra)
  for (const tet of KUHN)
    for (const corner of tet) tetList.push(hex[HEX_OF_CUBE_CORNER[corner]]);
const vertices = new Float64Array(box.vertices.flat());
const tets = new Int32Array(tetList);

const YOUNG = 210000;
const POISSON = 0.3;
const TIP_FORCE = -1000; // total, in z, spread equally over the free end
const clamped = [];
const tip = [];
box.vertices.forEach(([xCoordinate], node) => {
  if (Math.abs(xCoordinate) < 1e-9) clamped.push(node);
  if (Math.abs(xCoordinate - LENGTH) < 1e-9) tip.push(node);
});
const perNode = TIP_FORCE / tip.length;

const inertia = (WIDTH * HEIGHT ** 3) / 12;
const beamTip = (Math.abs(TIP_FORCE) * LENGTH ** 3) / (3 * YOUNG * inertia);

// Largest difference relative to the largest MFEM value.
function relativeDifference(reference, other, count) {
  let peak = 0;
  let difference = 0;
  for (let index = 0; index < count; index++) {
    peak = Math.max(peak, Math.abs(reference[index]));
    difference = Math.max(
      difference,
      Math.abs(other[index] - reference[index]),
    );
  }
  return { peak, relative: difference / peak };
}

// A box of Kuhn tets, as above, with its vertex positions and connectivity.
function kuhnBox(length, width, height, divisionsX, divisionsY, divisionsZ) {
  const hexBox = boxHexMesh(
    length,
    width,
    height,
    divisionsX,
    divisionsY,
    divisionsZ,
  );
  const corners = [];
  for (const hex of hexBox.hexahedra)
    for (const tet of KUHN)
      for (const corner of tet) corners.push(hex[HEX_OF_CUBE_CORNER[corner]]);
  return {
    points: hexBox.vertices,
    vertices: new Float64Array(hexBox.vertices.flat()),
    tets: corners,
  };
}

// Boundary triangles of a box side (all three corners on axis = value).
function sideFaces(mesh, axis, value) {
  const on = (vertex) => Math.abs(mesh.points[vertex][axis] - value) < 1e-9;
  const faces = [];
  for (let first = 0; first < mesh.tets.length; first += 4) {
    const tet = mesh.tets.slice(first, first + 4);
    for (let skip = 0; skip < 4; skip++) {
      const face = tet.filter((_, corner) => corner !== skip);
      if (face.every(on)) faces.push(face);
    }
  }
  return faces;
}

let engine = null;
beforeAll(async () => {
  engine = await loadEngine();
  await loadFem();
});

// ── Linear tets: Rust against MFEM on the same cantilever ─────────────────────
describe("linear tet cantilever", () => {
  let mfem = null;
  let model = null;
  let forces = null;
  let rust = null;
  let amg = null;
  let maxMfem = null;

  beforeAll(() => {
    mfem = engine.solve_linear_elastic(
      { vertices, tetrahedra: tets, hexahedra: new Int32Array(0) },
      JSON.stringify({ young_modulus: YOUNG, poisson_ratio: POISSON }),
      JSON.stringify({
        fixed_vertices: clamped,
        point_loads: tip.map((vertex) => ({ vertex, force: [0, 0, perNode] })),
      }),
      1,
    );
    model = new ElasticModel(
      vertices,
      new Uint32Array(tetList),
      new Uint32Array(0),
      new Uint32Array(tets.length / 4),
      new Float64Array([YOUNG, POISSON]),
      1,
    );
    model.assemble();
    const fixedDofs = new Uint32Array(
      clamped.flatMap((node) => [3 * node, 3 * node + 1, 3 * node + 2]),
    );
    forces = new Float64Array(model.dofCount);
    for (const node of tip) forces[3 * node + 2] = perNode;
    // MFEM's method and stopping rule, so the two must agree to the tolerance.
    rust = model.solve(
      fixedDofs,
      new Float64Array(fixedDofs.length),
      forces,
      new SolveOptions(1e-6, 20000, "gauss-seidel", "preconditioned"),
    );
    amg = model.solve(
      fixedDofs,
      new Float64Array(fixedDofs.length),
      forces,
      new SolveOptions(1e-6, 20000, "amg", "residual"),
    );
    maxMfem = 0;
    for (const value of mfem.displacements)
      maxMfem = Math.max(maxMfem, Math.abs(value));
  });

  test("MFEM solves the cantilever", () => {
    expect("error" in mfem, `MFEM solve failed: ${mfem.error}`).toBe(false);
  });

  test("Rust Gauss–Seidel CG displacements match MFEM", () => {
    const { relative } = relativeDifference(
      mfem.displacements,
      rust.displacements,
      rust.displacements.length,
    );
    expect(
      relative,
      `Rust and MFEM displacements differ by ${relative} relative`,
    ).toBeLessThan(1e-5);
  });

  test("Rust AMG displacements match MFEM and take fewer iterations", () => {
    const { relative } = relativeDifference(
      mfem.displacements,
      amg.displacements,
      amg.displacements.length,
    );
    expect(
      relative,
      `Rust AMG and MFEM displacements differ by ${relative} relative`,
    ).toBeLessThan(1e-5);
    expect(
      amg.iterations,
      `AMG took ${amg.iterations} iterations, Gauss–Seidel ${rust.iterations}`,
    ).toBeLessThan(rust.iterations);
  });

  test.each([
    ["ilu", "residual", /unknown preconditioner/],
    ["amg", "energy", /unknown stopping rule/],
  ])("SolveOptions(%s, %s) is refused", (preconditioner, stopping, pattern) => {
    expect(() => new SolveOptions(1e-6, 10, preconditioner, stopping)).toThrow(
      pattern,
    );
  });

  test("tip deflection lies below Euler–Bernoulli (linear tets are stiff)", () => {
    expect(maxMfem, `Euler–Bernoulli ${beamTip}`).toBeLessThan(beamTip);
    expect(maxMfem, `Euler–Bernoulli ${beamTip}`).toBeGreaterThan(
      0.3 * beamTip,
    );
  });

  // A floating model is refused, not solved.
  test("an unconstrained solve is refused", () => {
    expect(() =>
      model.solve(
        new Uint32Array(0),
        new Float64Array(0),
        forces,
        new SolveOptions(1e-6, 2000, "gauss-seidel", "preconditioned"),
      ),
    ).toThrow(/positive definite|did not converge/);
  });

  test("element order 3 is refused", () => {
    expect(
      () =>
        new ElasticModel(
          vertices,
          new Uint32Array(tetList),
          new Uint32Array(0),
          new Uint32Array(tets.length / 4),
          new Float64Array([YOUNG, POISSON]),
          3,
        ),
    ).toThrow(/element order 3 is not supported/);
  });
});

// ── Quadratic tetrahedra (order 2) ────────────────────────────────────────────
describe("quadratic tetrahedra", () => {
  const materialJson = JSON.stringify({
    young_modulus: YOUNG,
    poisson_ratio: POISSON,
  });

  // MFEM's order-2 solution of a Kuhn-tet mesh. `bcs` is the MFEM payload:
  // fixed_vertices, prescribed_dofs, point_loads and pressure surface_loads.
  function solveReference(mesh, bcs) {
    return engine.solve_linear_elastic(
      {
        vertices: mesh.vertices,
        tetrahedra: new Int32Array(mesh.tets),
        hexahedra: new Int32Array(0),
      },
      materialJson,
      JSON.stringify(bcs),
      2,
    );
  }

  // Solve one order-2 case in Rust (AMG on the force residual) and compare
  // displacements and von Mises stress with the MFEM `reference`.
  function compareQuadratic(name, mesh, bcs, reference) {
    const elementCount = mesh.tets.length / 4;
    expect(
      "error" in reference,
      `${name}: MFEM failed: ${reference.error}`,
    ).toBe(false);

    const quadratic = new ElasticModel(
      mesh.vertices,
      new Uint32Array(mesh.tets),
      new Uint32Array(0),
      new Uint32Array(elementCount),
      new Float64Array([YOUNG, POISSON]),
      2,
    );
    const vertexCount = quadratic.vertexCount;
    expect(
      vertexCount,
      `${name}: order 2 adds edge nodes after the ${mesh.points.length} vertices`,
    ).toBe(mesh.points.length);
    expect(
      quadratic.dofCount,
      `${name}: order 2 adds edge nodes after the ${mesh.points.length} vertices`,
    ).toBeGreaterThan(3 * vertexCount);
    quadratic.assemble();
    const dofs = [];
    const values = [];
    for (const vertex of bcs.fixed_vertices)
      for (let component = 0; component < 3; component++) {
        dofs.push(3 * vertex + component);
        values.push(0);
      }
    for (const { vertex, dof, value } of bcs.prescribed_dofs ?? []) {
      dofs.push(3 * vertex + dof);
      values.push(value);
    }
    const loads = new Float64Array(quadratic.dofCount);
    for (const { vertex, force } of bcs.point_loads)
      for (let component = 0; component < 3; component++)
        loads[3 * vertex + component] += force[component];
    (bcs.surface_loads ?? []).forEach((load, index) => {
      const unmatched = quadratic.addSurfaceLoad(
        loads,
        index,
        new Uint32Array(load.faces.flat()),
        new Uint32Array(0),
        load.type,
        new Float64Array([load.pressure]),
      );
      expect(unmatched, `${name}: surface load ${index} fully matched`).toBe(0);
    });

    // MFEM stops at 1e-6 in its Gauss–Seidel-preconditioned norm, which on the
    // ill-conditioned thin wall leaves a few 1e-6 of error. The converged Rust
    // solve isolates the formulation: it must match MFEM to that error. The
    // app's setting (AMG, force residual 1e-6) must land as close.
    for (const [label, tolerance] of [
      ["converged (1e-10)", 1e-10],
      ["app setting (1e-6)", 1e-6],
    ]) {
      const solution = quadratic.solve(
        new Uint32Array(dofs),
        new Float64Array(values),
        loads,
        new SolveOptions(tolerance, 50000, "amg", "residual"),
      );
      const nodal = solution.displacements;
      const stress = quadratic.vonMises(nodal);
      const motion = relativeDifference(
        reference.displacements,
        nodal,
        3 * vertexCount,
      );
      const vonMises = relativeDifference(
        reference.von_mises,
        stress,
        elementCount,
      );
      expect(
        motion.relative,
        `${name} (${label}): displacements differ by ${motion.relative} relative`,
      ).toBeLessThan(1e-5);
      expect(
        vonMises.relative,
        `${name} (${label}): von Mises differs by ${vonMises.relative} relative`,
      ).toBeLessThan(1e-4);
    }
    quadratic.free();
  }

  describe("cantilever", () => {
    const cantilever = kuhnBox(LENGTH, WIDTH, HEIGHT, 20, 2, 2);
    const cantileverClamped = [];
    const cantileverTip = [];
    cantilever.points.forEach(([xCoordinate], vertex) => {
      if (Math.abs(xCoordinate) < 1e-9) cantileverClamped.push(vertex);
      if (Math.abs(xCoordinate - LENGTH) < 1e-9) cantileverTip.push(vertex);
    });
    const bcs = {
      fixed_vertices: cantileverClamped,
      point_loads: cantileverTip.map((vertex) => ({
        vertex,
        force: [0, 0, TIP_FORCE / cantileverTip.length],
      })),
    };
    let reference = null;
    beforeAll(() => {
      reference = solveReference(cantilever, bcs);
    });

    test("Rust displacements and von Mises stress match MFEM", () => {
      compareQuadratic("cantilever", cantilever, bcs, reference);
    });

    // Quadratic tets resolve bending: within a few percent of beam theory,
    // where linear tets lock (the bound above is loose for that reason).
    test("tip deflection is near Euler–Bernoulli beam theory", () => {
      let tipSum = 0;
      for (const vertex of cantileverTip)
        tipSum += reference.displacements[3 * vertex + 2];
      const tipRatio = tipSum / cantileverTip.length / -beamTip;
      expect(
        tipRatio,
        `order-2 tip deflection should be near beam theory, got ${tipRatio}`,
      ).toBeGreaterThan(0.95);
      expect(
        tipRatio,
        `order-2 tip deflection should be near beam theory, got ${tipRatio}`,
      ).toBeLessThan(1.05);
    });
  });

  // Thin wall: 100 × 50 × 2 mm, one element through the thickness, clamped at
  // x = 0, a pressure on the top face and the far edge pushed down 0.05 mm.
  test("thin wall with pressure and prescribed displacement matches MFEM", () => {
    const wall = kuhnBox(100, 50, 2, 20, 10, 1);
    const wallClamped = [];
    const wallPushed = [];
    wall.points.forEach(([xCoordinate], vertex) => {
      if (Math.abs(xCoordinate) < 1e-9) wallClamped.push(vertex);
      if (Math.abs(xCoordinate - 100) < 1e-9) wallPushed.push(vertex);
    });
    const bcs = {
      fixed_vertices: wallClamped,
      prescribed_dofs: wallPushed.map((vertex) => ({
        vertex,
        dof: 2,
        value: -0.05,
      })),
      point_loads: [],
      surface_loads: [
        { type: "pressure", faces: sideFaces(wall, 2, 2), pressure: 0.2 },
      ],
    };
    compareQuadratic("thin wall", wall, bcs, solveReference(wall, bcs));
  });
});

// ── Hexahedra (8- and 27-node) and a mixed tet/hex mesh ───────────────────────
// A cantilever of hexes, and one whose root half is Kuhn tets (steel) and tip
// half hexes (aluminium), sharing the vertices between them. Every vertex off
// the two end planes is moved, so the hexes are not parallelepipeds and the
// top faces are warped quadrilaterals: the element and face integration rules
// must match MFEM's, not only be exact on boxes. Loads: a total force on the
// tip quadrilaterals and a pressure on the top (quadrilaterals, and the tets'
// triangles), with the root clamped.
describe("hexahedra and mixed meshes", () => {
  const HEX_TOP = [4, 5, 6, 7];
  function distortedHexBox(
    length,
    width,
    height,
    divisionsX,
    divisionsY,
    divisionsZ,
  ) {
    const hexBox = boxHexMesh(
      length,
      width,
      height,
      divisionsX,
      divisionsY,
      divisionsZ,
    );
    const points = hexBox.vertices.map(
      ([xCoordinate, yCoordinate, zCoordinate]) => {
        if (
          Math.abs(xCoordinate) < 1e-9 ||
          Math.abs(xCoordinate - length) < 1e-9
        )
          return [xCoordinate, yCoordinate, zCoordinate];
        return [
          xCoordinate +
            0.15 *
              (length / divisionsX) *
              Math.sin(0.7 * yCoordinate + 0.3 * zCoordinate),
          yCoordinate +
            0.1 *
              (width / divisionsY) *
              Math.sin(0.11 * xCoordinate + zCoordinate),
          zCoordinate +
            0.1 *
              (height / divisionsZ) *
              Math.cos(0.13 * xCoordinate + yCoordinate),
        ];
      },
    );
    return { box: hexBox, points, vertices: new Float64Array(points.flat()) };
  }

  // MFEM's solution of `mesh` ({ points, vertices, tets, hexes, attributes })
  // at `order`.
  function solveReference(mesh, order, materials, bcs) {
    return engine.solve_linear_elastic(
      {
        vertices: mesh.vertices,
        tetrahedra: new Int32Array(mesh.tets),
        hexahedra: new Int32Array(mesh.hexes),
        attributes: new Int32Array(mesh.attributes),
      },
      JSON.stringify(materials),
      JSON.stringify(bcs),
      order,
    );
  }

  // Solve `mesh` at `order` in Rust (converged AMG) and compare displacements
  // and von Mises stress with the MFEM `reference`. `bcs` is the MFEM payload;
  // its surface-load faces are vertex triples or quadruples.
  function compareSolid(name, mesh, order, materials, bcs, reference) {
    const elementCount = mesh.tets.length / 4 + mesh.hexes.length / 8;
    expect(
      "error" in reference,
      `${name}: MFEM failed: ${reference.error}`,
    ).toBe(false);

    const solid = new ElasticModel(
      mesh.vertices,
      new Uint32Array(mesh.tets),
      new Uint32Array(mesh.hexes),
      Uint32Array.from(mesh.attributes, (attribute) => attribute - 1),
      new Float64Array(
        materials.flatMap((material) => [
          material.young_modulus,
          material.poisson_ratio,
        ]),
      ),
      order,
    );
    const vertexCount = solid.vertexCount;
    solid.assemble();
    const dofs = [];
    for (const vertex of bcs.fixed_vertices)
      for (let component = 0; component < 3; component++)
        dofs.push(3 * vertex + component);
    const loads = new Float64Array(solid.dofCount);
    for (const { vertex, force } of bcs.point_loads)
      for (let component = 0; component < 3; component++)
        loads[3 * vertex + component] += force[component];
    bcs.surface_loads.forEach((load, index) => {
      const triangles = load.faces.filter((face) => face.length === 3);
      const quads = load.faces.filter((face) => face.length === 4);
      const unmatched = solid.addSurfaceLoad(
        loads,
        index,
        new Uint32Array(triangles.flat()),
        new Uint32Array(quads.flat()),
        load.type,
        new Float64Array(
          load.type === "pressure" ? [load.pressure] : load.force,
        ),
      );
      expect(unmatched, `${name}: surface load ${index} fully matched`).toBe(0);
    });
    const solution = solid.solve(
      new Uint32Array(dofs),
      new Float64Array(dofs.length),
      loads,
      new SolveOptions(1e-10, 50000, "amg", "residual"),
    );
    const nodal = solution.displacements;
    const stress = solid.vonMises(nodal);
    expect(
      stress.length,
      `${name}: one stress per element (tets, then hexes)`,
    ).toBe(elementCount);
    const motion = relativeDifference(
      reference.displacements,
      nodal,
      3 * vertexCount,
    );
    const vonMises = relativeDifference(
      reference.von_mises,
      stress,
      elementCount,
    );
    expect(
      motion.relative,
      `${name} (order ${order}): displacements differ by ${motion.relative} relative`,
    ).toBeLessThan(1e-5);
    expect(
      vonMises.relative,
      `${name} (order ${order}): von Mises differs by ${vonMises.relative} relative`,
    ).toBeLessThan(1e-4);
    solid.free();
  }

  const steel = { young_modulus: YOUNG, poisson_ratio: POISSON };
  const aluminium = { young_modulus: 70000, poisson_ratio: 0.33 };
  const DIVISIONS_X = 20;
  const DIVISIONS_Z = 2;
  const hexBeam = distortedHexBox(
    LENGTH,
    WIDTH,
    HEIGHT,
    DIVISIONS_X,
    2,
    DIVISIONS_Z,
  );
  const hexClamped = [];
  const hexTipNodes = new Set();
  hexBeam.box.vertices.forEach(([xCoordinate], vertex) => {
    if (Math.abs(xCoordinate) < 1e-9) hexClamped.push(vertex);
    if (Math.abs(xCoordinate - LENGTH) < 1e-9) hexTipNodes.add(vertex);
  });
  // boxHexMesh numbers hex (i, j, k) as (i·ny + j)·nz + k.
  const tipQuads = [];
  const topQuads = [];
  hexBeam.box.hexahedra.forEach((hex, index) => {
    const tipFace = [1, 2, 6, 5].map((corner) => hex[corner]);
    if (tipFace.every((vertex) => hexTipNodes.has(vertex)))
      tipQuads.push(tipFace);
    if (index % DIVISIONS_Z === DIVISIONS_Z - 1)
      topQuads.push(HEX_TOP.map((corner) => hex[corner]));
  });
  const hexLoads = (top) => ({
    fixed_vertices: hexClamped,
    point_loads: [],
    surface_loads: [
      { type: "force", faces: tipQuads, force: [0, 0, TIP_FORCE] },
      { type: "pressure", faces: top, pressure: 0.5 },
    ],
  });
  const allHexes = {
    points: hexBeam.points,
    vertices: hexBeam.vertices,
    tets: [],
    hexes: hexBeam.box.hexahedra.flat(),
    attributes: hexBeam.box.hexahedra.map(() => 1),
  };

  test.each([1, 2])(
    "distorted hex cantilever, order %i: Rust matches MFEM",
    (order) => {
      const bcs = hexLoads(topQuads);
      compareSolid(
        "hex cantilever",
        allHexes,
        order,
        [steel],
        bcs,
        solveReference(allHexes, order, [steel], bcs),
      );
    },
  );

  // Root half tets, tip half hexes.
  const mixedTets = [];
  const mixedHexes = [];
  const mixedTop = [];
  hexBeam.box.hexahedra.forEach((hex, index) => {
    const column = Math.floor(index / (2 * DIVISIONS_Z));
    const onTop = index % DIVISIONS_Z === DIVISIONS_Z - 1;
    if (column < DIVISIONS_X / 2) {
      for (const tet of KUHN) {
        const corners = tet.map((corner) => hex[HEX_OF_CUBE_CORNER[corner]]);
        mixedTets.push(...corners);
        const top = corners.filter((vertex) =>
          HEX_TOP.some((corner) => hex[corner] === vertex),
        );
        if (onTop && top.length === 3) mixedTop.push(top);
      }
    } else {
      mixedHexes.push(...hex);
      if (onTop) mixedTop.push(HEX_TOP.map((corner) => hex[corner]));
    }
  });
  const mixed = {
    points: hexBeam.points,
    vertices: hexBeam.vertices,
    tets: mixedTets,
    hexes: mixedHexes,
    attributes: [
      ...Array.from({ length: mixedTets.length / 4 }, () => 1),
      ...Array.from({ length: mixedHexes.length / 8 }, () => 2),
    ],
  };

  test("mixed top: two triangles per tet cell, one quadrilateral per hex", () => {
    expect(mixedTop.filter((face) => face.length === 3)).toHaveLength(
      2 * (DIVISIONS_X / 2) * 2,
    );
    expect(mixedTop.filter((face) => face.length === 4)).toHaveLength(
      (DIVISIONS_X / 2) * 2,
    );
  });

  test.each([1, 2])(
    "mixed tet/hex cantilever, order %i: Rust matches MFEM",
    (order) => {
      const bcs = hexLoads(mixedTop);
      compareSolid(
        "mixed tet/hex cantilever",
        mixed,
        order,
        [steel, aluminium],
        bcs,
        solveReference(mixed, order, [steel, aluminium], bcs),
      );
    },
  );

  // A wedge written as a hex: the tip hex of a 4 × 1 × 1 bar has its top
  // x = L edge collapsed onto the x = L − 10 one (corner 5 := 4, 6 := 7). Its
  // Jacobian vanishes only along that edge, never at a Gauss point, so MFEM
  // solves it and Rust must too. Root clamped, tip pulled down at its two
  // bottom corners.
  describe("collapsed (wedge) tip hex", () => {
    const bar = boxHexMesh(40, 10, 10, 4, 1, 1);
    const barHexes = bar.hexahedra.map((hex) => [...hex]);
    const tipHex = barHexes[barHexes.length - 1];
    const loadedCorners = [tipHex[1], tipHex[2]];
    tipHex[5] = tipHex[4];
    tipHex[6] = tipHex[7];
    const wedgeBar = {
      points: bar.vertices,
      vertices: new Float64Array(bar.vertices.flat()),
      tets: [],
      hexes: barHexes.flat(),
      attributes: barHexes.map(() => 1),
    };
    const wedgeLoads = {
      fixed_vertices: bar.vertices.flatMap(([xCoordinate], vertex) =>
        Math.abs(xCoordinate) < 1e-9 ? [vertex] : [],
      ),
      point_loads: loadedCorners.map((vertex) => ({
        vertex,
        force: [0, 0, -10],
      })),
      surface_loads: [],
    };

    // MFEM's peak displacement on this bar, as measured when the case was set up.
    test.each([
      [1, 1.6256e-3],
      [2, 2.7492e-3],
    ])("order %i: Rust matches MFEM, peak |u| %d", (order, peak) => {
      const reference = solveReference(wedgeBar, order, [steel], wedgeLoads);
      compareSolid(
        "collapsed (wedge) tip hex",
        wedgeBar,
        order,
        [steel],
        wedgeLoads,
        reference,
      );
      const largest = Math.max(
        ...Array.from(reference.displacements, Math.abs),
      );
      expect(
        Math.abs(largest - peak),
        `collapsed tip hex, order ${order}: MFEM max |u| ${largest}, expected ${peak}`,
      ).toBeLessThan(1e-4 * peak);
    });
  });

  // Malformed hexahedra are refused with the reason.
  test("a flat hex is refused", () => {
    expect(
      () =>
        new ElasticModel(
          new Float64Array([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0]),
          new Uint32Array(0),
          new Uint32Array([0, 1, 2, 3, 0, 1, 2, 3]),
          new Uint32Array(1),
          new Float64Array([YOUNG, POISSON]),
          1,
        ),
    ).toThrow(/hexahedron 0 is flat or folded/);
  });
});
