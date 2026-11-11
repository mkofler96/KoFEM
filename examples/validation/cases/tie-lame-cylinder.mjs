// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Thick-walled cylinder under internal pressure, built from two tied rings.
//
//   A long cylinder (plane strain), bore radius a, outer radius b, internal
//   pressure p. It is modelled as two separately meshed rings — a ≤ r ≤ c and
//   c ≤ r ≤ b — with different numbers of elements around, so the nodes of the
//   curved interface r = c do not match and its two faceted surfaces do not
//   even coincide. A constraint (MPC) tie joins them. Tied correctly, the two
//   rings behave as one cylinder, whose answer is Lamé's (1852): in plane
//   strain the radial displacement is
//
//     u(r) = (1+ν)·p·a² / (E·(b²−a²)) · ((1−2ν)·r + b²/r).
//
// A quarter is modelled, with symmetry supports on its cut faces and both end
// faces held in z. The measured value is the bore's radial displacement; the
// von Mises stress next to the interface is compared with Lamé's as well,
// since stress at a tie is where node-to-surface methods are known to be noisy.
//
// Reference: Timoshenko & Goodier, "Theory of Elasticity", thick-walled
// cylinder; M. A. Puso, IJNME 59 (2004), for curved non-matching interfaces.

import { joinParts, nodesWhere, quarterAnnulusHexMesh } from "../lib/mesh.mjs";
import { STEEL, solveModel } from "../lib/app-model.mjs";

const E = STEEL.young_modulus; // MPa
const nu = STEEL.poisson_ratio;
const a = 50, // bore radius (mm)
  c = 75, // interface radius (mm)
  b = 100, // outer radius (mm)
  t = 10; // modelled length (mm), plane strain
const p = 100; // internal pressure (MPa)
const INNER = { nr: 5, nth: 12 }; // a ≤ r ≤ c
const OUTER = { nr: 5, nth: 8 }; // c ≤ r ≤ b

const near = (u, v, tol = 1e-6) => Math.abs(u - v) < tol;
const radius = ([x, y]) => Math.hypot(x, y);

/** Lamé's plane-strain solution: radial displacement and von Mises stress. */
export function lame(r) {
  const k = (p * a * a) / (b * b - a * a);
  const u = ((1 + nu) * k * ((1 - 2 * nu) * r + (b * b) / r)) / E;
  const sr = k * (1 - (b * b) / (r * r));
  const st = k * (1 + (b * b) / (r * r));
  const sz = nu * (sr + st);
  const vm = Math.sqrt(
    0.5 * ((sr - st) ** 2 + (st - sz) ** 2 + (sz - sr) ** 2),
  );
  return { u, vm };
}

export const lameInterfaceRadius = c;

/** The tied cylinder, with both rings' meshes refined `level` times. */
export function lameModel(title, level = 1) {
  const m = joinParts([
    {
      mesh: quarterAnnulusHexMesh(
        a,
        c,
        t,
        level * INNER.nr,
        level * INNER.nth,
        1,
      ),
    },
    {
      mesh: quarterAnnulusHexMesh(
        c,
        b,
        t,
        level * OUTER.nr,
        level * OUTER.nth,
        1,
      ),
    },
  ]);
  const inInner = (i) => i < m.firstVertex[1];
  return {
    title,
    mesh: { vertices: m.vertices, hexahedra: m.hexahedra },
    bodies: m.bodies,
    material: STEEL,
    order: 1,
    supports: [
      {
        nodes: nodesWhere(m.vertices, (x, y, z) => near(z, 0) || near(z, t)),
        label: "Plane strain, z = 0 and z = t",
        dofs: [2],
      },
      {
        nodes: nodesWhere(m.vertices, (x, y) => near(y, 0)),
        label: "Symmetry y = 0",
        dofs: [1],
      },
      {
        nodes: nodesWhere(m.vertices, (x) => near(x, 0)),
        label: "Symmetry x = 0",
        dofs: [0],
      },
    ],
    load: {
      kind: "pressure",
      value: p,
      nodes: nodesWhere(m.vertices, (x, y) => near(radius([x, y]), a)),
      label: "Internal pressure",
    },
    ties: [
      {
        name: "Tie1",
        a: {
          nodes: nodesWhere(
            m.vertices,
            (x, y, z, i) => inInner(i) && near(radius([x, y]), c),
          ),
          label: "Inner ring, r = c",
        },
        b: {
          nodes: nodesWhere(
            m.vertices,
            (x, y, z, i) => !inInner(i) && near(radius([x, y]), c),
          ),
          label: "Outer ring, r = c",
        },
        extent: "full",
        searchDistance: 0,
        method: "mpc",
      },
    ],
    resultType: "Von Mises stress",
  };
}

/** Mean radial displacement of the bore. */
export function boreDisplacement(model, result) {
  const d = result.displacements;
  const nodes = model.load.nodes;
  return (
    nodes.reduce((s, v) => {
      const [x, y] = model.mesh.vertices[v];
      const r = Math.hypot(x, y);
      return s + (d[3 * v] * x + d[3 * v + 1] * y) / r;
    }, 0) / nodes.length
  );
}

/**
 * Element von Mises stress against Lamé's at the element centre, as the
 * largest relative difference over the elements that touch the interface and
 * over the others.
 */
export function lameStressErrors(model, result) {
  const { vertices, hexahedra } = model.mesh;
  let tied = 0,
    other = 0;
  hexahedra.forEach((hex, e) => {
    const radii = hex.map((v) => radius(vertices[v]));
    const centre = radii.reduce((s, r) => s + r, 0) / radii.length;
    const err = Math.abs(result.von_mises[e] / lame(centre).vm - 1) * 100;
    if (radii.some((r) => near(r, c))) tied = Math.max(tied, err);
    else other = Math.max(other, err);
  });
  return { tied, other };
}

export default {
  id: "tie-lame-cylinder",
  name: "Tied thick-walled cylinder",
  quantity: "bore radial displacement u(a)",
  unit: "mm",
  reference: lame(a).u,
  referenceLabel: "Lamé, plane strain",
  tolPct: 2,
  readout: { field: "|U|", stat: "Max" },
  figure: {
    field: "vonMises",
    unit: "MPa",
    view: [0, 0, -1],
    deform: false,
  },
  page: {
    summary:
      "Two rings tied along a curved, non-matching interface behave as one cylinder under pressure.",
    model:
      "Quarter of a thick cylinder, bore a, outer radius b, in two rings tied at r = c.",
    inputs: [
      ["a", a, "mm"],
      ["c", c, "mm"],
      ["b", b, "mm"],
      ["t", t, "mm"],
      ["E", E, "MPa"],
      ["ν", nu, ""],
      ["p", p, "MPa"],
    ],
    supports:
      "Uz = 0 on both end faces (plane strain); symmetry Uy = 0 on y = 0 and Ux = 0 on x = 0.",
    loads: "Pressure p on the bore r = a.",
    measured: "Mean radial displacement of the bore nodes.",
    mesh: `inner ring ${INNER.nr} × ${INNER.nth}, outer ring ${OUTER.nr} × ${OUTER.nth} (radial × around), 1 through t`,
    source: "Lamé (1852); Timoshenko & Goodier",
    ties: true,
  },
  model() {
    return lameModel(this.name);
  },
  measure: boreDisplacement,
  // The stress next to the tie and elsewhere, against Lamé's — with this tie,
  // and with the same model tied node-to-surface instead.
  extras(model, result, solve) {
    const mortar = lameStressErrors(model, result);
    const projectedModel = { ...model, tieFormulation: "projection" };
    const projectedResult = solveModel(solve, projectedModel);
    const projected = lameStressErrors(projectedModel, projectedResult);
    return {
      interfaceStressErrPct: mortar.tied,
      otherStressErrPct: mortar.other,
      projectionInterfaceStressErrPct: projected.tied,
      projectionBoreErrPct:
        (boreDisplacement(projectedModel, projectedResult) / lame(a).u - 1) *
        100,
    };
  },
};
