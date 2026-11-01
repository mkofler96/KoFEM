// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Boundary-condition and load grouping shared by the solve paths. The solid
// path's grouping (groupDirichlet / groupPointLoads) lives in solveMeshPacking;
// this module holds the shell (6-DOF per vertex) and coupled (6·pool+dof) forms,
// and the conversions between them, so every path applies one rule for what a
// fixed, a prescribed and a loaded DOF mean.

import type {
  Constraint,
  Load,
  Node,
  SurfaceLoad,
} from "../../workers/solverTypes.js";
import type { VertexIndexer } from "../solveMeshPacking.js";
import { coupledLoads as packCoupledLoads } from "../solveLoads.js";

// solve_shell's essential BCs. `fixed_*` always mean u = 0; a driven DOF is a
// `prescribed_dofs` entry (inhomogeneous essential BC, KOF-210).
export interface ShellDirichlet {
  fixed_vertices: number[];
  fixed_dofs: { vertex: number; dofs: number[] }[];
  prescribed_dofs: { vertex: number; dof: number; value: number }[];
}

// solve_coupled's essential BCs, as flat DOF indices 6·pool+dof.
export interface CoupledDirichlet {
  fixed_dofs: number[];
  prescribed_dofs: number[];
  prescribed_vals: number[];
}

// Look up a vertex's DOF set, creating an empty one on first use.
export function getOrInitDofs(
  map: Map<number, Set<number>>,
  key: number,
): Set<number> {
  let set = map.get(key);
  if (!set) {
    set = new Set();
    map.set(key, set);
  }
  return set;
}

// A vertex with all six DOFs fixed becomes a fixed_vertices entry, anything
// partial a fixed_dofs entry (DOFs sorted ascending), in first-seen order.
function splitFixedVertices(
  dofsByVertex: Map<number, Set<number>>,
): Pick<ShellDirichlet, "fixed_vertices" | "fixed_dofs"> {
  const fixed_vertices: number[] = [];
  const fixed_dofs: { vertex: number; dofs: number[] }[] = [];
  for (const [vertex, dofSet] of dofsByVertex) {
    if (dofSet.size === 6) fixed_vertices.push(vertex);
    else fixed_dofs.push({ vertex, dofs: [...dofSet].sort((a, b) => a - b) });
  }
  return { fixed_vertices, fixed_dofs };
}

// Essential BCs for the shell solve. Shell nodes carry six DOFs
// (u,v,w,θx,θy,θz), so rotational constraints are honoured — unlike the solid
// path, which drops them as stiffness-free. A node with all six DOFs fixed
// becomes a fixed_vertices entry, anything partial a fixed_dofs entry.
//
// A non-zero prescribed displacement (or rotation) is split off into
// prescribed_dofs exactly as groupDirichlet does for the solid path: the
// fixed_* sets always mean u = 0, so folding a driven DOF into them would pin
// away the value the user asked for (KOF-210).
export function shellDirichlet(
  constraints: Constraint[],
  vid: VertexIndexer,
): ShellDirichlet {
  const dofsByVertex = new Map<number, Set<number>>();
  const prescribed_dofs: ShellDirichlet["prescribed_dofs"] = [];
  for (const c of constraints) {
    if (c.dof < 0 || c.dof > 5)
      throw new Error(
        `shell solve: constraint on node ${c.nodeId} names DOF ${c.dof} — valid shell DOFs are 0..5`,
      );
    const vertex = vid(c.nodeId, "constraint");
    // eslint-disable-next-line kofem/no-silent-fallback -- a constraint without prescribedValue is a homogeneous fixed BC, i.e. u = 0 by definition
    const value = c.prescribedValue ?? 0;
    if (value !== 0) {
      prescribed_dofs.push({ vertex, dof: c.dof, value });
      continue;
    }
    getOrInitDofs(dofsByVertex, vertex).add(c.dof);
  }
  return { ...splitFixedVertices(dofsByVertex), prescribed_dofs };
}

// A DOF fixed to zero by one BC group and driven to a value by another is a
// contradiction the solve must not resolve by picking a winner (KOF-218).
function fixedAndPrescribedError(nodeId: number, dof: number, value: number) {
  return new Error(
    `Node ${nodeId} (DOF ${dof}) is fixed to 0 and also prescribed to ${value} — a DOF ` +
      "cannot be held at two displacements at once. Remove the node from one of the " +
      "boundary conditions.",
  );
}

// Essential BCs for the coupled solve: a translation constraint maps to its
// pool node, and a shelled node clamped in all three translations is also
// clamped in rotation. `isShell` reports whether a pool node carries shell
// (6-DOF) stiffness — the auto-shell and mixed paths supply it differently, but
// the rule is the same.
//
// `isRefPoint` marks the pool nodes that are a coupling's REFERENCE POINT. Those
// carry six real DOFs (shell_core gives a coupling reference its rotations), so
// an Rx/Ry/Rz constraint on one is a genuine rotational restraint and is passed
// through instead of dropped — clamping a kinematic reference point is how a
// bolted connection is stated. Everywhere else a rotational constraint is still
// dropped: the shell nodes take their rotational clamp from the all-three-
// translations rule below, and a solid node has no rotational DOF to restrain.
//
// A non-zero prescribed value leaves through `prescribed_dofs`/`prescribed_vals`
// (the coupled engine's inhomogeneous essential BCs), never through fixed_dofs,
// which always mean u = 0 (KOF-210). A driven node is NOT given the
// all-translations-clamped rotational treatment: a face pulled to a displacement
// is not thereby built in, and clamping its rotations would over-stiffen it.
export function coupledFixedDofs(
  constraints: Constraint[],
  poolOf: (nodeId: number) => number,
  isShell: (poolIndex: number) => boolean,
  isRefPoint: (poolIndex: number) => boolean,
): CoupledDirichlet {
  const fixedByPool = new Map<number, Set<number>>();
  const drivenPools = new Set<number>();
  const prescribed = new Map<number, number>();
  for (const c of constraints) {
    const pi = poolOf(c.nodeId);
    // eslint-disable-next-line kofem/no-silent-fallback -- a constraint without prescribedValue is a homogeneous fixed BC, i.e. u = 0 by definition
    const value = c.prescribedValue ?? 0;
    if (c.dof > 2 && !isRefPoint(pi)) {
      // A rotational CLAMP is dropped here by design (see above), but a driven
      // rotation has no such substitute — dropping it is the silent pin-to-zero
      // this path was fixed for (KOF-210). Say so instead.
      if (value !== 0)
        throw new Error(
          `Node ${c.nodeId} prescribes a rotation (DOF ${c.dof} = ${value}), which this ` +
            "model has nowhere to apply: only a coupling reference point carries a " +
            "drivable rotational DOF here. Prescribe the translations instead, or " +
            "declare the node as a coupling reference point.",
        );
      continue;
    }
    if (value !== 0) {
      const dof = 6 * pi + c.dof;
      const seen = prescribed.get(dof);
      if (seen !== undefined && seen !== value)
        throw new Error(
          `Node ${c.nodeId} (DOF ${c.dof}) is prescribed to two different displacements, ` +
            `${seen} and ${value} — a DOF cannot be driven to both. Remove or merge one ` +
            "of the boundary conditions.",
        );
      if (fixedByPool.get(pi)?.has(c.dof))
        throw fixedAndPrescribedError(c.nodeId, c.dof, value);
      prescribed.set(dof, value);
      drivenPools.add(pi);
      continue;
    }
    const dofs = getOrInitDofs(fixedByPool, pi);
    const driven = prescribed.get(6 * pi + c.dof);
    if (driven !== undefined)
      throw fixedAndPrescribedError(c.nodeId, c.dof, driven);
    dofs.add(c.dof);
  }
  const fixed_dofs: number[] = [];
  for (const [pi, dofs] of fixedByPool) {
    for (const d of dofs) fixed_dofs.push(6 * pi + d);
    // A shell node clamped in all three translations is clamped, not hinged.
    // A reference point is NOT given that treatment: its rotations are the DOFs
    // the coupled surface's rigid-body motion rides on, so fixing them because
    // the translations were fixed would silently turn a pinned point into a
    // built-in one. Check Rx/Ry/Rz to clamp a reference point.
    if (
      isShell(pi) &&
      !isRefPoint(pi) &&
      !drivenPools.has(pi) &&
      dofs.has(0) &&
      dofs.has(1) &&
      dofs.has(2)
    )
      for (const d of [3, 4, 5]) fixed_dofs.push(6 * pi + d);
  }
  const prescribed_dofs: number[] = [];
  const prescribed_vals: number[] = [];
  for (const [dof, value] of prescribed) {
    prescribed_dofs.push(dof);
    prescribed_vals.push(value);
  }
  return { fixed_dofs, prescribed_dofs, prescribed_vals };
}

// Point + surface loads as 6·pool+dof nodal forces, with surface-load faces
// positioned from the store nodes.
export function coupledLoads(
  loads: Load[],
  surfaceLoads: SurfaceLoad[] | undefined,
  poolOf: (nodeId: number) => number,
  isRefPoint: (poolIndex: number) => boolean,
  nodes: Node[],
  vid: VertexIndexer,
): { load_dofs: number[]; load_vals: number[] } {
  return packCoupledLoads(loads, surfaceLoads, poolOf, isRefPoint, (nodeId) => {
    const node = nodes[vid(nodeId, "surface load face")];
    return [node.x, node.y, node.z];
  });
}

// Fold coupled-form (6·vertex+dof) essential BCs into solve_shell's form: a
// vertex with all six DOFs fixed → fixed_vertices, partial → fixed_dofs, and
// driven DOFs kept separate as prescribed_dofs (KOF-210).
export function coupledToShellDirichlet(
  flat: CoupledDirichlet,
): ShellDirichlet {
  const dofsByVertex = new Map<number, Set<number>>();
  for (const d of flat.fixed_dofs)
    getOrInitDofs(dofsByVertex, Math.floor(d / 6)).add(d % 6);
  return {
    ...splitFixedVertices(dofsByVertex),
    prescribed_dofs: flat.prescribed_dofs.map((d, k) => ({
      vertex: Math.floor(d / 6),
      dof: d % 6,
      value: flat.prescribed_vals[k],
    })),
  };
}

// Fold coupled-form (6·vertex+dof) loads into solve_shell's point_loads: the
// three force components per vertex, summed. Moments (DOF 3..5) never reach
// here — a pure shell has no reference point to receive them.
export function coupledToShellPointLoads(
  load_dofs: number[],
  load_vals: number[],
): { vertex: number; force: [number, number, number] }[] {
  const forceByVertex = new Map<number, [number, number, number]>();
  for (let k = 0; k < load_dofs.length; k++) {
    const vertex = Math.floor(load_dofs[k] / 6);
    const comp = load_dofs[k] % 6;
    let acc = forceByVertex.get(vertex);
    if (!acc) {
      acc = [0, 0, 0];
      forceByVertex.set(vertex, acc);
    }
    if (comp <= 2) acc[comp] += load_vals[k];
  }
  return [...forceByVertex.entries()].map(([vertex, force]) => ({
    vertex,
    force,
  }));
}

// Surface-load faces are node-id lists from the store; remap each to the
// engine's vertex indices so the solid engine's boundary-element matcher finds
// them.
export function surfaceLoadsToVertices(
  surfaceLoads: SurfaceLoad[] | undefined,
  vid: VertexIndexer,
): SurfaceLoad[] {
  return (surfaceLoads ?? []).map((sl) => ({
    ...sl,
    faces: sl.faces.map((face) =>
      face.map((nodeId) => vid(nodeId, "surface load face")),
    ),
  }));
}
