#!/usr/bin/env bun
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
//
// Usage:  bun tests/test_coupling.mjs   (from the web/ directory)

import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const wasmPkg = join(__dirname, "../src/wasm/pkg");
const wasmBinary = readFileSync(join(wasmPkg, "kofem_wasm_emcc.wasm")).buffer;
const { default: createModule } = await import(
  join(wasmPkg, "kofem_wasm_emcc.js")
);

let passed = 0;
let failed = 0;
function check(label, condition, detail = "") {
  if (condition) {
    console.log(`  [PASS] ${label}`);
    passed++;
  } else {
    console.error(`  [FAIL] ${label}${detail ? ` — ${detail}` : ""}`);
    failed++;
  }
}

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

function beam(verts, index, x0, length, height, nx, nt = 2) {
  const dx = length / nx;
  const dy = height / nt;
  const at = (i, j, k) => {
    const key = `${(x0 + i * dx).toFixed(6)},${(j * dy).toFixed(6)},${(k * dy).toFixed(6)}`;
    let vi = index.get(key);
    if (vi === undefined) {
      vi = verts.length / 3;
      index.set(key, vi);
      verts.push(x0 + i * dx, j * dy, k * dy);
    }
    return vi;
  };
  const tets = [];
  for (let i = 0; i < nx; i++)
    for (let j = 0; j < nt; j++)
      for (let k = 0; k < nt; k++) {
        const corner = [
          at(i, j, k),
          at(i + 1, j, k),
          at(i, j + 1, k),
          at(i + 1, j + 1, k),
          at(i, j, k + 1),
          at(i + 1, j, k + 1),
          at(i, j + 1, k + 1),
          at(i + 1, j + 1, k + 1),
        ];
        for (const t of KUHN)
          tets.push(corner[t[0]], corner[t[1]], corner[t[2]], corner[t[3]]);
      }
  return tets;
}

const YOUNG = 210000; // MPa
const POISSON = 0.3;
const LENGTH = 60; // mm
const HEIGHT = 6; // mm
const INERTIA = (HEIGHT * HEIGHT ** 3) / 12;

const Module = await createModule({
  wasmBinary,
  print: () => {},
  printErr: () => {},
});

// Solve one coupled model. `couplings` is a list of
// {ref, nodes, kind, dofMask}; kind 2 is kinematic.
function solve(verts, tets, couplings, fixedDofs, loads) {
  const ref = [];
  const offsets = [0];
  const solid = [];
  const mpc = [];
  const dofMask = [];
  for (const cp of couplings) {
    ref.push(cp.ref);
    solid.push(...cp.nodes);
    offsets.push(solid.length);
    mpc.push(cp.kind);
    dofMask.push(cp.dofMask ?? 0x3f);
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
console.log("\nKinematic coupling: force and moment through a reference point");
{
  const verts = [];
  const index = new Map();
  const tets = beam(verts, index, 0, LENGTH, HEIGHT, 20);
  const nMesh = verts.length / 3;

  const nodesAt = (predicate) => {
    const out = [];
    for (let vi = 0; vi < nMesh; vi++)
      if (predicate(verts[3 * vi], verts[3 * vi + 1], verts[3 * vi + 2]))
        out.push(vi);
    return out;
  };
  const root = nodesAt((x) => Math.abs(x) < 1e-9);
  const tipFace = nodesAt((x) => Math.abs(x - LENGTH) < 1e-9);

  // The reference point at the tip face centroid — where KOF-208 places it.
  let cx = 0,
    cy = 0,
    cz = 0;
  for (const vi of tipFace) {
    cx += verts[3 * vi];
    cy += verts[3 * vi + 1];
    cz += verts[3 * vi + 2];
  }
  const RP = nMesh;
  verts.push(cx / tipFace.length, cy / tipFace.length, cz / tipFace.length);

  const fixed = root.flatMap((vi) => [0, 1, 2].map((c) => 6 * vi + c));
  const FORCE = -500; // N, −Y

  // Same force, applied directly to the tip face nodes (no coupling).
  const direct = solve(
    verts,
    tets,
    [],
    fixed.concat([0, 1, 2, 3, 4, 5].map((c) => 6 * RP + c)), // park the unused point
    tipFace.map((vi) => [6 * vi + 1, FORCE / tipFace.length]),
  );
  check("the directly-loaded cantilever solves", direct.ok, direct.error);

  // The same force applied at the reference point instead.
  const viaPoint = solve(
    verts,
    tets,
    [{ ref: RP, nodes: tipFace, kind: 2 }],
    fixed,
    [[6 * RP + 1, FORCE]],
  );
  check("the point-loaded cantilever solves", viaPoint.ok, viaPoint.error);

  if (direct.ok && viaPoint.ok) {
    const uDirect = maxDeflection(direct.disp, 1);
    const uPoint = maxDeflection(viaPoint.disp, 1);
    console.log(
      `    tip deflection: direct ${uDirect.toFixed(5)} mm, via point ${uPoint.toFixed(5)} mm`,
    );
    // The spider makes the tip face rigid, so the point-loaded beam is a little
    // stiffer — but it is the same load path, not a different one.
    check(
      "a force at the reference point reaches the beam",
      Math.abs(uPoint - uDirect) / uDirect < 0.1,
      `direct ${uDirect}, via point ${uPoint}`,
    );
  }

  // A MOMENT at the reference point — only reachable because the spider ties the
  // face to the point's ROTATION, turning the couple into a self-equilibrated
  // force pattern on the face.
  //
  // The reference is the force case on THIS mesh, not a beam formula: linear
  // tets two elements through the thickness are about twice as stiff as
  // Euler-Bernoulli, so an analytic value would measure the mesh, not the
  // coupling. Ratio of the two analytic tip deflections is
  // (ML²/2EI)/(PL³/3EI) = 3M/(2PL), chosen here to be exactly 1 — so a correct
  // moment coupling must reproduce the force case's deflection.
  const MOMENT = (2 * Math.abs(FORCE) * LENGTH) / 3; // ⇒ same tip deflection
  const moment = solve(
    verts,
    tets,
    [{ ref: RP, nodes: tipFace, kind: 2 }],
    fixed,
    [[6 * RP + 5, MOMENT]],
  );
  check("a moment at the reference point solves", moment.ok, moment.error);
  if (moment.ok && direct.ok) {
    const uTip = maxDeflection(moment.disp, 1);
    const uForce = maxDeflection(direct.disp, 1);
    console.log(
      `    tip deflection under an equivalent tip couple: ${uTip.toFixed(5)} mm, force case ${uForce.toFixed(5)} mm`,
    );
    check(
      "a moment at the reference point bends the beam by the equivalent amount",
      Math.abs(uTip - uForce) / uForce < 0.05,
      `couple ${uTip}, force ${uForce}`,
    );
  }
}

// ── 3: two beams joined point-to-point — rigid vs hinge ──────────────────────
console.log("\nPoint-to-point connection: the DOF mask switches the hinge off");
{
  const verts = [];
  const index = new Map();
  // Two collinear beams meeting at x = LENGTH, meshed independently.
  const tetsA = beam(verts, index, 0, LENGTH, HEIGHT, 12);
  const startB = verts.length / 3;
  const indexB = new Map();
  const tetsB = beam(verts, indexB, LENGTH, LENGTH, HEIGHT, 12);
  const tets = [...tetsA, ...tetsB];

  const nMesh = verts.length / 3;
  const nodesAt = (predicate, lo, hi) => {
    const out = [];
    for (let vi = lo; vi < hi; vi++)
      if (predicate(verts[3 * vi], verts[3 * vi + 1], verts[3 * vi + 2]))
        out.push(vi);
    return out;
  };
  const root = nodesAt((x) => Math.abs(x) < 1e-9, 0, startB);
  const endA = nodesAt((x) => Math.abs(x - LENGTH) < 1e-9, 0, startB);
  const startFaceB = nodesAt((x) => Math.abs(x - LENGTH) < 1e-9, startB, nMesh);
  const tipB = nodesAt((x) => Math.abs(x - 2 * LENGTH) < 1e-9, startB, nMesh);

  // A reference point on each side of the joint, both at the interface centre.
  const joint = [LENGTH, HEIGHT / 2, HEIGHT / 2];
  const RP_A = nMesh;
  verts.push(...joint);
  const RP_B = nMesh + 1;
  verts.push(...joint);

  const fixed = root.flatMap((vi) => [0, 1, 2].map((c) => 6 * vi + c));
  const spiders = [
    { ref: RP_A, nodes: endA, kind: 2 },
    { ref: RP_B, nodes: startFaceB, kind: 2 },
  ];
  // The connection itself: one kinematic coupling whose single coupled node is
  // the other point. Its mask is the hinge/rigid switch.
  const connector = (mask) => ({
    ref: RP_A,
    nodes: [RP_B],
    kind: 2,
    dofMask: mask,
  });

  const TRANSVERSE = -300; // N at the far tip of beam B
  const AXIAL = 4000; // N along the beams

  const RIGID = 0x3f;
  const HINGE = 0x07; // x, y, z only

  // Axial pull: a hinge transmits force just as a rigid joint does.
  const axialRigid = solve(
    verts,
    tets,
    [...spiders, connector(RIGID)],
    fixed,
    tipB.map((vi) => [6 * vi, AXIAL / tipB.length]),
  );
  const axialHinge = solve(
    verts,
    tets,
    [...spiders, connector(HINGE)],
    fixed,
    tipB.map((vi) => [6 * vi, AXIAL / tipB.length]),
  );
  check(
    "the rigid joint carries an axial pull",
    axialRigid.ok,
    axialRigid.error,
  );
  check(
    "the hinged joint carries an axial pull",
    axialHinge.ok,
    axialHinge.error,
  );
  if (axialRigid.ok && axialHinge.ok) {
    const uRigid = maxDeflection(axialRigid.disp, 0);
    const uHinge = maxDeflection(axialHinge.disp, 0);
    console.log(
      `    axial extension: rigid ${uRigid.toFixed(6)} mm, hinge ${uHinge.toFixed(6)} mm`,
    );
    check(
      "a hinge transmits axial force exactly as a rigid joint does",
      Math.abs(uRigid - uHinge) / uRigid < 0.02,
      `rigid ${uRigid}, hinge ${uHinge}`,
    );
  }

  // Transverse load: the rigid joint carries the bending moment across, so the
  // pair acts as one 2L cantilever. The hinge cannot — beam B is free to rotate
  // about the joint, which is a mechanism, and the solve says so.
  const bendRigid = solve(
    verts,
    tets,
    [...spiders, connector(RIGID)],
    fixed,
    tipB.map((vi) => [6 * vi + 1, TRANSVERSE / tipB.length]),
  );
  check("the rigid joint carries bending", bendRigid.ok, bendRigid.error);
  if (bendRigid.ok) {
    // Reference: one continuous beam of the same length, meshed the same way, so
    // the comparison isolates the joint. The jointed pair comes out stiffer —
    // a kinematic coupling rigidifies the two faces it grips, which is the
    // known cost of an RBE2 idealisation, not an error.
    const solidVerts = [];
    const solidTets = beam(solidVerts, new Map(), 0, 2 * LENGTH, HEIGHT, 24);
    const nSolid = solidVerts.length / 3;
    const solidNodes = (predicate) => {
      const out = [];
      for (let vi = 0; vi < nSolid; vi++)
        if (predicate(solidVerts[3 * vi])) out.push(vi);
      return out;
    };
    const monolithic = solve(
      solidVerts,
      solidTets,
      [],
      solidNodes((x) => Math.abs(x) < 1e-9).flatMap((vi) =>
        [0, 1, 2].map((c) => 6 * vi + c),
      ),
      solidNodes((x) => Math.abs(x - 2 * LENGTH) < 1e-9).map((vi) => [
        6 * vi + 1,
        TRANSVERSE / tipB.length,
      ]),
    );
    const uTip = maxDeflection(bendRigid.disp, 1);
    const uMono = monolithic.ok ? maxDeflection(monolithic.disp, 1) : NaN;
    console.log(
      `    tip deflection: through the rigid joint ${uTip.toFixed(4)} mm, one continuous beam ${uMono.toFixed(4)} mm`,
    );
    check(
      "with all six DOFs tied the pair bends much like one continuous member",
      monolithic.ok && Math.abs(uTip - uMono) / uMono < 0.35,
      `jointed ${uTip}, monolithic ${uMono}`,
    );
  }

  const bendHinge = solve(
    verts,
    tets,
    [...spiders, connector(HINGE)],
    fixed,
    tipB.map((vi) => [6 * vi + 1, TRANSVERSE / tipB.length]),
  );
  console.log(
    `    hinged joint under bending: ${bendHinge.ok ? "converged" : "no solution"}`,
  );
  check(
    "with only x,y,z tied the joint is a hinge — beam B is a mechanism in bending",
    !bendHinge.ok,
    "the hinged pair should not have a bending solution",
  );
}

console.log(`\n${passed + failed} checks: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
