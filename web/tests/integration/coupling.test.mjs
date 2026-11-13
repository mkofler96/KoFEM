// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Kinematic (RBE2) coupling and the point-to-point connector (KOF-208).
//
// A surface is idealised to a reference point: the surface nodes follow the
// point as a rigid body, so the point can be loaded, fixed, or tied onward — the
// bolt/screw idealisation. Two such points tied together make a connection whose
// DOF mask decides its character: translations alone are a spherical joint (the
// parts can rotate about it), all six make it rigid.
//
// Checks, all against the real WASM engine:
//   1. A force applied at the reference point reaches the beam — tip deflection
//      matches the same force applied directly to the coupled face.
//   2. A MOMENT applied at the reference point bends the beam, and matches the
//      analytic cantilever value. Only a rigid spider can do this: it is the
//      θ_R × r term of u_i = u_R + θ_R × r_i that turns the moment into a
//      self-equilibrated force pattern on the face.
//   3. Two beams joined point-to-point: with all six DOFs tied the pair carries
//      bending as one member; with only x,y,z tied the joint is a hinge and the
//      second beam is a mechanism — which is exactly the behaviour the mask is
//      there to switch off.

import { beforeAll, describe, expect, test } from "bun:test";
import { loadEngine } from "../support/wasm.mjs";

// ── Tet beam ──────────────────────────────────────────────────────────────────
// A box [x0, x0+L] × [0, h] × [0, h] of Kuhn tets, nx cells along the length.
const KUHN = [
  [0, 1, 3, 7],
  [0, 3, 2, 7],
  [0, 2, 6, 7],
  [0, 6, 4, 7],
  [0, 4, 5, 7],
  [0, 5, 1, 7],
];

function beam(verts, index, x0, length, height, cellsAlong, cellsAcross = 2) {
  const stepX = length / cellsAlong;
  const stepYZ = height / cellsAcross;
  const vertexAt = (i, j, k) => {
    const key = `${(x0 + i * stepX).toFixed(6)},${(j * stepYZ).toFixed(6)},${(k * stepYZ).toFixed(6)}`;
    let vertexIndex = index.get(key);
    if (vertexIndex === undefined) {
      vertexIndex = verts.length / 3;
      index.set(key, vertexIndex);
      verts.push(x0 + i * stepX, j * stepYZ, k * stepYZ);
    }
    return vertexIndex;
  };
  const tets = [];
  for (let i = 0; i < cellsAlong; i++)
    for (let j = 0; j < cellsAcross; j++)
      for (let k = 0; k < cellsAcross; k++) {
        const corner = [
          vertexAt(i, j, k),
          vertexAt(i + 1, j, k),
          vertexAt(i, j + 1, k),
          vertexAt(i + 1, j + 1, k),
          vertexAt(i, j, k + 1),
          vertexAt(i + 1, j, k + 1),
          vertexAt(i, j + 1, k + 1),
          vertexAt(i + 1, j + 1, k + 1),
        ];
        for (const tet of KUHN)
          tets.push(
            corner[tet[0]],
            corner[tet[1]],
            corner[tet[2]],
            corner[tet[3]],
          );
      }
  return tets;
}

const YOUNG = 210000; // MPa
const POISSON = 0.3;
const LENGTH = 60; // mm
const HEIGHT = 6; // mm

// Solve one coupled model. `couplings` is a list of
// {ref, nodes, kind, dofMask}; kind 2 is kinematic.
function solve(Module, verts, tets, couplings, fixedDofs, loads) {
  const ref = [];
  const offsets = [0];
  const solid = [];
  const mpc = [];
  const dofMask = [];
  for (const coupling of couplings) {
    ref.push(coupling.ref);
    solid.push(...coupling.nodes);
    offsets.push(solid.length);
    mpc.push(coupling.kind);
    dofMask.push(coupling.dofMask ?? 0x3f);
  }
  const loadDofs = [];
  const loadVals = [];
  for (const [dof, value] of loads) {
    loadDofs.push(dof);
    loadVals.push(value);
  }
  let result;
  try {
    result = Module.solve_coupled(
      {
        vertices: Float64Array.from(verts),
        tets: Int32Array.from(tets),
        triangles: new Int32Array(0),
        thicknesses: new Float64Array(0),
      },
      {
        ref: Int32Array.from(ref),
        offsets: Int32Array.from(offsets),
        solid: Int32Array.from(solid),
        mpc: Int32Array.from(mpc),
        dof_mask: Int32Array.from(dofMask),
        relaxation: 1.0,
      },
      {
        fixed_dofs: Int32Array.from(fixedDofs),
        load_dofs: Int32Array.from(loadDofs),
        load_vals: Float64Array.from(loadVals),
      },
      JSON.stringify({
        solid: { young_modulus: YOUNG, poisson_ratio: POISSON },
        shell: { young_modulus: YOUNG, poisson_ratio: POISSON },
      }),
    );
  } catch (err) {
    const decoded = Module.getExceptionMessage
      ? Module.getExceptionMessage(err)
      : null;
    return { ok: false, error: decoded ? decoded[1] : String(err) };
  }
  if ("error" in result) return { ok: false, error: result.error };
  return { ok: true, disp: result.displacements };
}

const maxDeflection = (disp, axis) => {
  let max = 0;
  for (let i = 0; i < disp.length / 3; i++)
    max = Math.max(max, Math.abs(disp[3 * i + axis]));
  return max;
};

// ── 1 + 2: one cantilever, its tip face idealised to a reference point ────────
describe("kinematic coupling: force and moment through a reference point", () => {
  const FORCE = -500; // N, −Y
  let direct;
  let viaPoint;
  let moment;

  beforeAll(async () => {
    const Module = await loadEngine();
    const verts = [];
    const index = new Map();
    const tets = beam(verts, index, 0, LENGTH, HEIGHT, 20);
    const meshNodeCount = verts.length / 3;

    const nodesAt = (predicate) => {
      const out = [];
      for (let node = 0; node < meshNodeCount; node++)
        if (
          predicate(verts[3 * node], verts[3 * node + 1], verts[3 * node + 2])
        )
          out.push(node);
      return out;
    };
    const root = nodesAt((x) => Math.abs(x) < 1e-9);
    const tipFace = nodesAt((x) => Math.abs(x - LENGTH) < 1e-9);

    // The reference point at the tip face centroid — where KOF-208 places it.
    let centroidX = 0,
      centroidY = 0,
      centroidZ = 0;
    for (const node of tipFace) {
      centroidX += verts[3 * node];
      centroidY += verts[3 * node + 1];
      centroidZ += verts[3 * node + 2];
    }
    const referencePoint = meshNodeCount;
    verts.push(
      centroidX / tipFace.length,
      centroidY / tipFace.length,
      centroidZ / tipFace.length,
    );

    const fixed = root.flatMap((node) => [0, 1, 2].map((c) => 6 * node + c));

    // Same force, applied directly to the tip face nodes (no coupling).
    direct = solve(
      Module,
      verts,
      tets,
      [],
      fixed.concat([0, 1, 2, 3, 4, 5].map((c) => 6 * referencePoint + c)), // park the unused point
      tipFace.map((node) => [6 * node + 1, FORCE / tipFace.length]),
    );

    // The same force applied at the reference point instead.
    viaPoint = solve(
      Module,
      verts,
      tets,
      [{ ref: referencePoint, nodes: tipFace, kind: 2 }],
      fixed,
      [[6 * referencePoint + 1, FORCE]],
    );

    // A MOMENT at the reference point — only reachable because the spider ties
    // the face to the point's ROTATION, turning the couple into a
    // self-equilibrated force pattern on the face.
    //
    // The reference is the force case on THIS mesh, not a beam formula: linear
    // tets two elements through the thickness are about twice as stiff as
    // Euler-Bernoulli, so an analytic value would measure the mesh, not the
    // coupling. Ratio of the two analytic tip deflections is
    // (ML²/2EI)/(PL³/3EI) = 3M/(2PL), chosen here to be exactly 1 — so a correct
    // moment coupling must reproduce the force case's deflection.
    const MOMENT = (2 * Math.abs(FORCE) * LENGTH) / 3; // ⇒ same tip deflection
    moment = solve(
      Module,
      verts,
      tets,
      [{ ref: referencePoint, nodes: tipFace, kind: 2 }],
      fixed,
      [[6 * referencePoint + 5, MOMENT]],
    );
  });

  test("the directly-loaded cantilever solves", () => {
    expect(direct.ok, direct.error).toBe(true);
  });

  test("the point-loaded cantilever solves", () => {
    expect(viaPoint.ok, viaPoint.error).toBe(true);
  });

  test("a force at the reference point reaches the beam", () => {
    expect(direct.ok, direct.error).toBe(true);
    expect(viaPoint.ok, viaPoint.error).toBe(true);
    const uDirect = maxDeflection(direct.disp, 1);
    const uPoint = maxDeflection(viaPoint.disp, 1);
    // The spider makes the tip face rigid, so the point-loaded beam is a little
    // stiffer — but it is the same load path, not a different one.
    expect(
      Math.abs(uPoint - uDirect) / uDirect,
      `direct ${uDirect}, via point ${uPoint}`,
    ).toBeLessThan(0.1);
  });

  test("a moment at the reference point solves", () => {
    expect(moment.ok, moment.error).toBe(true);
  });

  test("a moment at the reference point bends the beam by the equivalent amount", () => {
    expect(moment.ok, moment.error).toBe(true);
    expect(direct.ok, direct.error).toBe(true);
    const uTip = maxDeflection(moment.disp, 1);
    const uForce = maxDeflection(direct.disp, 1);
    expect(
      Math.abs(uTip - uForce) / uForce,
      `couple ${uTip}, force ${uForce}`,
    ).toBeLessThan(0.05);
  });
});

// ── 3: two beams joined point-to-point — rigid vs hinge ──────────────────────
describe("point-to-point connection: the DOF mask switches the hinge off", () => {
  const TRANSVERSE = -300; // N at the far tip of beam B
  const AXIAL = 4000; // N along the beams
  const RIGID = 0x3f;
  const HINGE = 0x07; // x, y, z only
  let axialRigid;
  let axialHinge;
  let bendRigid;
  let monolithic;
  let bendHinge;

  beforeAll(async () => {
    const Module = await loadEngine();
    const verts = [];
    const index = new Map();
    // Two collinear beams meeting at x = LENGTH, meshed independently.
    const tetsA = beam(verts, index, 0, LENGTH, HEIGHT, 12);
    const startB = verts.length / 3;
    const indexB = new Map();
    const tetsB = beam(verts, indexB, LENGTH, LENGTH, HEIGHT, 12);
    const tets = [...tetsA, ...tetsB];

    const meshNodeCount = verts.length / 3;
    const nodesAt = (predicate, low, high) => {
      const out = [];
      for (let node = low; node < high; node++)
        if (
          predicate(verts[3 * node], verts[3 * node + 1], verts[3 * node + 2])
        )
          out.push(node);
      return out;
    };
    const root = nodesAt((x) => Math.abs(x) < 1e-9, 0, startB);
    const endA = nodesAt((x) => Math.abs(x - LENGTH) < 1e-9, 0, startB);
    const startFaceB = nodesAt(
      (x) => Math.abs(x - LENGTH) < 1e-9,
      startB,
      meshNodeCount,
    );
    const tipB = nodesAt(
      (x) => Math.abs(x - 2 * LENGTH) < 1e-9,
      startB,
      meshNodeCount,
    );

    // A reference point on each side of the joint, both at the interface centre.
    const joint = [LENGTH, HEIGHT / 2, HEIGHT / 2];
    const referenceA = meshNodeCount;
    verts.push(...joint);
    const referenceB = meshNodeCount + 1;
    verts.push(...joint);

    const fixed = root.flatMap((node) => [0, 1, 2].map((c) => 6 * node + c));
    const spiders = [
      { ref: referenceA, nodes: endA, kind: 2 },
      { ref: referenceB, nodes: startFaceB, kind: 2 },
    ];
    // The connection itself: one kinematic coupling whose single coupled node is
    // the other point. Its mask is the hinge/rigid switch.
    const connector = (mask) => ({
      ref: referenceA,
      nodes: [referenceB],
      kind: 2,
      dofMask: mask,
    });
    const axialLoad = tipB.map((node) => [6 * node, AXIAL / tipB.length]);
    const transverseLoad = tipB.map((node) => [
      6 * node + 1,
      TRANSVERSE / tipB.length,
    ]);

    // Axial pull: a hinge transmits force just as a rigid joint does.
    axialRigid = solve(
      Module,
      verts,
      tets,
      [...spiders, connector(RIGID)],
      fixed,
      axialLoad,
    );
    axialHinge = solve(
      Module,
      verts,
      tets,
      [...spiders, connector(HINGE)],
      fixed,
      axialLoad,
    );

    // Transverse load: the rigid joint carries the bending moment across, so the
    // pair acts as one 2L cantilever. The hinge cannot — beam B is free to rotate
    // about the joint, which is a mechanism, and the solve says so.
    bendRigid = solve(
      Module,
      verts,
      tets,
      [...spiders, connector(RIGID)],
      fixed,
      transverseLoad,
    );

    // Reference: one continuous beam of the same length, meshed the same way, so
    // the comparison isolates the joint. The jointed pair comes out stiffer —
    // a kinematic coupling rigidifies the two faces it grips, which is the
    // known cost of an RBE2 idealisation, not an error.
    const solidVerts = [];
    const solidTets = beam(solidVerts, new Map(), 0, 2 * LENGTH, HEIGHT, 24);
    const solidNodeCount = solidVerts.length / 3;
    const solidNodes = (predicate) => {
      const out = [];
      for (let node = 0; node < solidNodeCount; node++)
        if (predicate(solidVerts[3 * node])) out.push(node);
      return out;
    };
    monolithic = solve(
      Module,
      solidVerts,
      solidTets,
      [],
      solidNodes((x) => Math.abs(x) < 1e-9).flatMap((node) =>
        [0, 1, 2].map((c) => 6 * node + c),
      ),
      solidNodes((x) => Math.abs(x - 2 * LENGTH) < 1e-9).map((node) => [
        6 * node + 1,
        TRANSVERSE / tipB.length,
      ]),
    );

    bendHinge = solve(
      Module,
      verts,
      tets,
      [...spiders, connector(HINGE)],
      fixed,
      transverseLoad,
    );
  });

  test("the rigid joint carries an axial pull", () => {
    expect(axialRigid.ok, axialRigid.error).toBe(true);
  });

  test("the hinged joint carries an axial pull", () => {
    expect(axialHinge.ok, axialHinge.error).toBe(true);
  });

  test("a hinge transmits axial force exactly as a rigid joint does", () => {
    expect(axialRigid.ok, axialRigid.error).toBe(true);
    expect(axialHinge.ok, axialHinge.error).toBe(true);
    const uRigid = maxDeflection(axialRigid.disp, 0);
    const uHinge = maxDeflection(axialHinge.disp, 0);
    expect(
      Math.abs(uRigid - uHinge) / uRigid,
      `rigid ${uRigid}, hinge ${uHinge}`,
    ).toBeLessThan(0.02);
  });

  test("the rigid joint carries bending", () => {
    expect(bendRigid.ok, bendRigid.error).toBe(true);
  });

  test("with all six DOFs tied the pair bends much like one continuous member", () => {
    expect(bendRigid.ok, bendRigid.error).toBe(true);
    expect(monolithic.ok, monolithic.error).toBe(true);
    const uTip = maxDeflection(bendRigid.disp, 1);
    const uMono = maxDeflection(monolithic.disp, 1);
    expect(
      Math.abs(uTip - uMono) / uMono,
      `jointed ${uTip}, monolithic ${uMono}`,
    ).toBeLessThan(0.35);
  });

  test("with only x,y,z tied the joint is a hinge — beam B is a mechanism in bending", () => {
    expect(
      bendHinge.ok,
      "the hinged pair should not have a bending solution",
    ).toBe(false);
  });
});
