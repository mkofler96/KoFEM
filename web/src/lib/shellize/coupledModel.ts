// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Assemble the node pool of the engine's coupled solve (solve_coupled): solid
// nodes, then shell nodes, then reference points, with the tets and shell
// facets remapped onto it and the couplings that join the two domains.

import { SpatialGrid } from "../spatialGrid.js";
import { concatCouplings, type CouplingSet } from "./couplingSet.js";
import { shellFootprintCouplings } from "./footprint.js";
import {
  dist2,
  medianTetEdge,
  pt,
  tetMeshBoundary,
  type ShellizeMesh,
  type Vec3,
} from "./geometry.js";
import type { ShellExtraction } from "./midSurface.js";
import { autoDetectCouplings, partnerSearchRadius } from "./partners.js";
import { seamShellNodes, seamTolerance } from "./seam.js";
import {
  tieCouplings,
  tiesToPool,
  type PoolTie,
  type TieCouplingReport,
  type TieSurfaces,
} from "./ties.js";

export interface CoupledModel {
  pool: number[]; // 3·nPool (solid nodes, then shell nodes, then reference points)
  tets: number[]; // 4·nSolidTets over pool
  tetBody: number[]; // body id per solid tet (for per-body PSOLID labelling)
  triangles: number[]; // 3·nShellTris over pool
  thicknesses: number[];
  coupling: CouplingSet;
  solidPool: Map<number, number>; // original vertex index → pool index (solid)
  shellPool: number[]; // local shell index → pool index
  refPool: Map<number, number>; // reference-point vertex index → pool index
  tieReports: TieCouplingReport[]; // what each tie connection contributed
}

export interface CouplingOptions {
  // How far off the retained solid's boundary a shell node may sit and still
  // count as seam. Defaults to seamTolerance() of the model's own scales.
  seamTolerance?: number;
  // How far a seam node may reach for its solid partners. Defaults to the
  // solid mesh's own spacing — see partnerSearchRadius.
  couplingRadius?: number;
  maxCoupledNodes?: number;
  // The model's tie connections. Distinct solid bodies are joined ONLY by
  // these — nothing is inferred from the geometry — so an assembly with no
  // connection keeps its bodies apart, which is what the empty default means.
  ties?: TieSurfaces[];
  // Vertex indices of the surface-to-point couplings' REFERENCE POINTS. They
  // belong to no element, so nothing else would put them in the pool — and
  // without a pool node the coupling has no reference to tie to.
  referencePoints?: number[];
}

// The couplings that join a pool's solid and shell domains, shared by both
// builders: the declared tie connections, the physical shell footprint on
// through-thickness solid sections, and the seam tie of the remaining shell
// nodes that sit on the retained solid.
function domainCouplings(
  pool: number[],
  tets: number[],
  triangles: number[],
  thicknesses: number[],
  seamCandidates: number[],
  solidPoolIndices: number[],
  ties: PoolTie[],
  {
    seamTolerance: seamToleranceOverride,
    couplingRadius,
    maxCoupledNodes,
  }: {
    seamTolerance?: number;
    couplingRadius?: number;
    maxCoupledNodes: number;
  },
): { coupling: CouplingSet; tieReports: TieCouplingReport[] } {
  const ppt = (i: number): Vec3 => [
    pool[3 * i],
    pool[3 * i + 1],
    pool[3 * i + 2],
  ];
  // Every coupling distance below is derived from the solid mesh's own spacing —
  // a fixed radius rigidified whole millimetres of thin wall.
  const medEdge = medianTetEdge(ppt, tets);
  // The tie connections first — their reference nodes become coupling-dependent,
  // so the shell↔solid seam detection must not also target them (a target DOF
  // must be independent).
  const { coupling: solidCoupling, reports: tieReports } = tieCouplings(
    ppt,
    ties,
    medEdge,
    maxCoupledNodes,
  );
  const solidRefs = new Set(solidCoupling.ref);
  // Tie only the shell nodes that sit on the retained solid, and let each reach
  // as far as the solid mesh's own spacing to find its partners.
  const tolerance =
    seamToleranceOverride ??
    seamTolerance(
      thicknesses.length > 0 ? Math.max(...thicknesses) : 0,
      medEdge,
    );
  const seam = seamShellNodes(
    ppt,
    seamCandidates,
    tetMeshBoundary(tets),
    tolerance,
  );
  const footprint = shellFootprintCouplings(
    pool,
    tets,
    triangles,
    thicknesses,
    solidRefs,
    tolerance,
  );
  const shellCoupling = autoDetectCouplings(
    ppt,
    solidPoolIndices.filter((pi) => !solidRefs.has(pi)),
    seam.filter((index) => !footprint.shellNodes.has(index)),
    couplingRadius ?? partnerSearchRadius(medEdge, tolerance),
    maxCoupledNodes,
  );
  return {
    tieReports,
    // The shell↔solid seam is continuous material (a thin wall idealised as shell,
    // tied back to its retained solid) — not a tie connection between parts, and
    // never something the user declares — so it uses the relaxed MPC coupling
    // (mpc=1) for displacement continuity. A tie connection across a clearance
    // stays distributing.
    coupling: concatCouplings(
      concatCouplings(footprint.coupling, {
        ...shellCoupling,
        mpc: shellCoupling.ref.map(() => 1),
      }),
      { ...solidCoupling, mpc: solidCoupling.ref.map(() => 0) },
    ),
  };
}

// Assemble the coupled node pool (solid nodes then shell nodes), remap tets and
// shell triangles onto it, and tie the two domains: the shell's SEAM nodes (those
// on the retained solid's boundary) to their nearest solid nodes, plus any gapped
// solid↔solid interface.
export function buildCoupledModel(
  m: ShellizeMesh,
  shells: ShellExtraction,
  wallTets: Set<number>,
  {
    seamTolerance: seamToleranceOverride,
    couplingRadius,
    maxCoupledNodes = 16,
    ties = [],
    referencePoints = [],
  }: CouplingOptions = {},
): CoupledModel {
  // Solid tets = the other bodies plus the shelled body's non-wall (base) tets;
  // only the tets inside the thin walls are replaced by shell facets. Different
  // solid bodies keep their own nodes; a gapped interface is tied by the
  // distributing couplings of a tie connection (tieCouplings), not node-merging.
  const solidTets: number[] = [];
  const tetBody: number[] = [];
  for (let e = 0; e < m.tet.length / 4; e++)
    if (!(m.body[e] === shells.shellBody && wallTets.has(e))) {
      solidTets.push(
        m.tet[4 * e],
        m.tet[4 * e + 1],
        m.tet[4 * e + 2],
        m.tet[4 * e + 3],
      );
      tetBody.push(m.body[e]);
    }

  const pool: number[] = [];
  const solidPool = new Map<number, number>();
  const addPool = (x: number, y: number, z: number) => {
    const id = pool.length / 3;
    pool.push(x, y, z);
    return id;
  };
  for (const n of new Set(solidTets)) solidPool.set(n, addPool(...pt(m.V, n)));
  const shellPool: number[] = [];
  for (let s = 0; s < shells.shellVerts.length / 3; s++)
    shellPool.push(
      addPool(
        shells.shellVerts[3 * s],
        shells.shellVerts[3 * s + 1],
        shells.shellVerts[3 * s + 2],
      ),
    );
  // Reference points last, so isShellPoolIndex can keep telling the three
  // groups apart by index range.
  const refPool = new Map<number, number>();
  for (const vi of referencePoints)
    if (!refPool.has(vi)) refPool.set(vi, addPool(...pt(m.V, vi)));

  const tets = solidTets.map((n) => {
    const poolIndex = solidPool.get(n);
    if (poolIndex === undefined)
      throw new Error(`solid node ${n} missing from the coupled pool`);
    return poolIndex;
  });
  const triangles = shells.shellTris.map((s) => shellPool[s]);

  const { coupling, tieReports } = domainCouplings(
    pool,
    tets,
    triangles,
    shells.shellThk,
    shellPool,
    [...solidPool.values()],
    tiesToPool(ties, (vi) => solidPool.get(vi)),
    { seamTolerance: seamToleranceOverride, couplingRadius, maxCoupledNodes },
  );

  return {
    pool,
    tets,
    tetBody,
    triangles,
    thicknesses: shells.shellThk,
    solidPool,
    shellPool,
    refPool,
    tieReports,
    coupling,
  };
}

// Coupled model built from EXPLICIT shell and solid elements (a hand-mixed
// CTRIA3 + CTETRA model, or the regenerated crane showcase) — as opposed to the
// auto-shell path, where the shells are derived by collapsing thin solid walls.
// The pool is the solid tet nodes followed by the shell triangle nodes; the two
// domains are joined by RBE3 couplings re-derived from proximity, exactly as the
// auto-shell path does. `poolOfVertex` maps every store vertex index to its pool
// node (used to place BCs/loads), and `shellPoolIndex` is the set of pool nodes
// carrying shell (6-DOF) stiffness (used to auto-fix rotations of clamped shell
// nodes). A shell node that IS a solid node (shared store id) reuses the solid
// pool entry — a direct rigid connection, no distributing coupling needed.
export interface ExplicitCoupledModel {
  pool: number[]; // 3·nPool (solid nodes then shell nodes)
  tets: number[]; // 4·nSolidTets over pool
  triangles: number[]; // 3·nShellTris over pool
  thicknesses: number[]; // per shell triangle
  coupling: CouplingSet;
  poolOfVertex: Map<number, number>; // store vertex index → pool index
  shellPoolIndex: Set<number>; // pool indices carrying shell stiffness
  tieReports: TieCouplingReport[]; // what each tie connection contributed
}

export function buildExplicitCoupledModel(
  V: number[], // 3·nNodes, xyz interleaved (store vertex order)
  solidTets: number[], // 4·nSolidTets, store vertex indices
  shellTris: number[], // 3·nShellTris, store vertex indices
  shellThk: number[], // per shell triangle thickness
  {
    seamTolerance: seamToleranceOverride,
    couplingRadius,
    maxCoupledNodes = 16,
    ties = [],
    referencePoints = [],
  }: CouplingOptions = {},
): ExplicitCoupledModel {
  const pool: number[] = [];
  const poolOfVertex = new Map<number, number>();
  const addVertex = (vi: number): number => {
    let pi = poolOfVertex.get(vi);
    if (pi !== undefined) return pi;
    pi = pool.length / 3;
    poolOfVertex.set(vi, pi);
    pool.push(V[3 * vi], V[3 * vi + 1], V[3 * vi + 2]);
    return pi;
  };

  // Solid nodes first — their pool indices are the RBE3 coupling targets.
  const solidPoolIndices: number[] = [];
  for (const vi of new Set(solidTets)) solidPoolIndices.push(addVertex(vi));
  const tets = solidTets.map((vi) => {
    const pi = poolOfVertex.get(vi);
    if (pi === undefined)
      throw new Error(`explicit coupled: solid node ${vi} missing from pool`);
    return pi;
  });
  // Shell nodes second — a node also used by a solid tet reuses its pool entry.
  const shellPoolIndex = new Set<number>();
  const triangles = shellTris.map((vi) => {
    const pi = addVertex(vi);
    shellPoolIndex.add(pi);
    return pi;
  });
  // Reference points last. They carry no element stiffness; the engine gives a
  // coupling reference its six DOFs and leaves its rotations free (shell_core:
  // is_coupling_ref), so they need nothing here beyond a place in the pool.
  for (const vi of referencePoints) addVertex(vi);

  // Shell nodes NOT shared with the solid need a distributing coupling; shared
  // nodes are already rigidly attached through the common pool DOFs. Of those,
  // only the SEAM nodes — the ones sitting on the retained solid's boundary — are
  // tied, by the same geometric rule the auto-shell path uses, so a saved mixed
  // model reloads with the seam it was meshed with. Gapped solid↔solid
  // interfaces (a pin in a hole) are tied across the clearance by the model's
  // tie connections, as on the auto-shell path.
  const solidPoolSet = new Set(solidPoolIndices);
  const unsharedShellNodes = [...shellPoolIndex].filter(
    (pi) => !solidPoolSet.has(pi),
  );
  const { coupling, tieReports } = domainCouplings(
    pool,
    tets,
    triangles,
    shellThk,
    unsharedShellNodes,
    solidPoolIndices,
    tiesToPool(ties, (vi) => poolOfVertex.get(vi)),
    { seamTolerance: seamToleranceOverride, couplingRadius, maxCoupledNodes },
  );

  return {
    pool,
    tets,
    triangles,
    thicknesses: shellThk,
    coupling,
    poolOfVertex,
    shellPoolIndex,
    tieReports,
  };
}

// The pool is built in three blocks — solid nodes, then shell mid-surface
// nodes, then reference points — so a pool index says which it is. Only the
// middle block carries shell (6-DOF) element stiffness; a reference point has
// six DOFs too, but they come from its coupling, not from a facet.
export function isShellPoolIndex(
  model: CoupledModel,
  poolIndex: number,
): boolean {
  return (
    poolIndex >= model.solidPool.size &&
    poolIndex < model.solidPool.size + model.shellPool.length
  );
}

// Nearest shell-mid-surface pool node to a point — used to map the shelled
// body's boundary conditions and its displacement result (the mid-surface is
// offset ~t/2 from the original solid surface). Grid-accelerated with an
// expanding ring search so it works regardless of the offset magnitude.
export function shellNodeLocator(model: CoupledModel): (p: Vec3) => number {
  const cell = 15;
  const grid = new SpatialGrid(
    model.shellPool,
    (pi) => pt(model.pool, pi),
    cell,
  );
  const maxRings = 6;
  return (p) => {
    let best = -1,
      bd = Infinity;
    for (let r = 0; r <= maxRings && bd === Infinity; r++) {
      for (const pi of grid.candidates(p, r, r)) {
        const dd = dist2(p, pt(model.pool, pi));
        if (dd < bd) {
          bd = dd;
          best = pi;
        }
      }
    }
    // No candidate within the searched radius: the query point (a BC/load on the
    // shelled body) is farther from every shell mid-surface node than the grid
    // sweep reaches. Returning the seed node would silently map the constraint or
    // load onto an arbitrary, unrelated node — throw instead (issue #378).
    if (best < 0 || bd === Infinity)
      throw new Error(
        `shellNodeLocator: no shell mid-surface node found within ${maxRings * cell} units of ` +
          `query point (${p[0]}, ${p[1]}, ${p[2]}) — a boundary condition or load on the shelled ` +
          "body could not be mapped onto the shell mesh. The node may lie farther from any thin " +
          "wall than the search radius, or the model may be mis-scaled.",
      );
    return best;
  };
}
