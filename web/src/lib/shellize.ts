// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Solid → shell idealisation used by the solver worker: find the thin walls of
// the body the user marked Shell, collapse them to a Kirchhoff shell
// mid-surface (per-wall thickness), keep the other bodies as solid tets, and
// build the inputs for the coupled solve — the Rust mixed solve
// (lib/solve/coupledRust.ts), with the engine's solve_coupled as its oracle.
//
// The geometry runs in Rust (crates/kofem-shellize, through the kofem-wasm
// module; KOF-297). This file only converts between the app's arrays and that
// module, and holds the coupling-set plumbing that also carries the couplings
// the user declares. The Rust module must be loaded first (loadFemModule).

import {
  buildCoupledModel as rustCoupledModel,
  buildExplicitCoupledModel as rustExplicitCoupledModel,
  buildShellTransitionModel as rustShellTransition,
  CouplingInput,
  extractThinWallShells as rustExtractShells,
  shellBodyTets as rustShellBodyTets,
  ShellSet,
  shellWallTets as rustShellWallTets,
  ShellizeInput,
} from "../wasm/fem/kofem_wasm.js";
import { SpatialGrid } from "./spatialGrid.js";

export type Vec3 = [number, number, number];

// Flat mesh over a 0-based vertex numbering (the worker builds this from the
// store model via its vertex indexer).
export interface ShellizeMesh {
  V: number[]; // 3·nNodes, xyz interleaved
  tet: number[]; // 4·nTets, vertex indices
  body: number[]; // body id per tet
  surfTri: number[]; // 3·nSurfTri, vertex indices
  surfFace: number[]; // OCC face id per surface triangle
}

// A detected thin wall: the CAD face kept as its mid-surface source (the outer
// face of the pair), that face's unit normal, the thickness and the body.
export interface Wall {
  keep: number;
  n: Vec3;
  thk: number;
  body: number;
}

export interface ShellExtraction {
  walls: Wall[];
  shellBody: number; // -1 when no thin wall was found
  shellVerts: number[]; // 3·nShellNodes
  shellTris: number[]; // 3·nShellTris (local shell indices)
  shellThk: number[]; // per shell tri
  shellSrc: number[]; // source OCC face per shell node (a welded fold node: one of them)
  shellTriSrc: number[]; // source OCC face per shell TRI — unambiguous, so a BC on a
  // folded face reaches every node of its facets (fold nodes shared with a wall included)
}

// CSR-style coupling set. `mpc[k]` selects the coupling kind for reference k:
// 1 ⇒ relaxed shell-to-solid MPC (rigid translation tie + relaxed rotation, for a
// continuous-material seam), 2 ⇒ kinematic RBE2 (the coupled nodes follow the
// reference point rigidly), 3 ⇒ physical footprint (solid translations follow
// an interpolated shell edge), 0/absent ⇒ distributing RBE3 (for a gapped
// interface). `dofMask[k]` selects which of a kinematic coupling's six DOFs are
// tied (bits 0..5); absent ⇒ all six.
export interface CouplingSet {
  ref: number[];
  offsets: number[];
  solid: number[];
  mpc?: number[]; // per ref; length matches ref when present
  weights?: number[]; // per partner; shell-footprint interpolation coefficients
  dofMask?: number[]; // per ref; length matches ref when present
}

// One tie connection, as the coupled builders need it: the two surfaces the
// user picked, as STORE VERTEX INDICES (the builder maps them to pool nodes),
// and how far the tie reaches (`Infinity` couples the full surface).
export interface TieSurfaces {
  name: string;
  verticesA: number[];
  verticesB: number[];
  maxSeparation: number;
}

// Why a tie connection ended up coupling nothing — each has a different fix
// (KOF-203).
export type TieCouplingDrop =
  | { kind: "no-pool-nodes"; side: "A" | "B" | "both" }
  | { kind: "out-of-reach"; searched: number }
  | { kind: "beyond-search-distance"; gap: number; reach: number }
  | { kind: "too-few-partners"; refs: number; radius: number };

// What one tie connection contributed to the coupled model. `problem` is the
// sentence for a connection that coupled nothing.
export interface TieCouplingReport {
  name: string;
  nCoupled: number; // reference nodes that got a distributing coupling
  nPartners: number; // partner slots those references distribute onto
  nShared: number; // nodes the two surfaces already have in common
  gap: number; // measured closest approach, 0 when never measured
  drop?: TieCouplingDrop;
  problem?: string;
}

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

// Coupled model built from EXPLICIT shell and solid elements (a stored mixed
// CTRIA3 + CTETRA model). A shell node that IS a solid node (shared store id)
// reuses the solid pool entry — a direct rigid connection.
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

export interface CouplingOptions {
  // The model's tie connections. Distinct solid bodies are joined ONLY by
  // these, so an assembly with no connection keeps its bodies apart.
  ties?: TieSurfaces[];
  // Vertex indices of the surface-to-point couplings' REFERENCE POINTS. They
  // belong to no element, so nothing else would put them in the pool.
  referencePoints?: number[];
}

// ── Conversion to and from the Rust module ────────────────────────────────────

interface Freeable {
  free(): void;
}

// Run `use` on a WASM-side object and release its memory afterwards.
function using<T extends Freeable, R>(value: T, use: (value: T) => R): R {
  try {
    return use(value);
  } finally {
    value.free();
  }
}

function meshInput(mesh: ShellizeMesh): ShellizeInput {
  return new ShellizeInput(
    Float64Array.from(mesh.V),
    Uint32Array.from(mesh.tet),
    Int32Array.from(mesh.body),
    Uint32Array.from(mesh.surfTri),
    Int32Array.from(mesh.surfFace),
  );
}

function meshFrom(input: ShellizeInput): ShellizeMesh {
  return {
    V: Array.from(input.vertices),
    tet: Array.from(input.tets),
    body: Array.from(input.body),
    surfTri: Array.from(input.surfaceTriangles),
    surfFace: Array.from(input.surfaceFaces),
  };
}

function shellInput(shells: ShellExtraction): ShellSet {
  return new ShellSet(
    shells.shellBody < 0 ? undefined : shells.shellBody,
    Int32Array.from(shells.walls.map((wall) => wall.keep)),
    Float64Array.from(shells.walls.flatMap((wall) => wall.n)),
    Float64Array.from(shells.walls.map((wall) => wall.thk)),
    Int32Array.from(shells.walls.map((wall) => wall.body)),
    Float64Array.from(shells.shellVerts),
    Uint32Array.from(shells.shellTris),
    Float64Array.from(shells.shellThk),
    Int32Array.from(shells.shellSrc),
    Int32Array.from(shells.shellTriSrc),
  );
}

function shellsFrom(set: ShellSet): ShellExtraction {
  const keep = set.wallKeep,
    normal = set.wallNormal,
    thickness = set.wallThickness,
    body = set.wallBody;
  const walls: Wall[] = Array.from(keep, (face, index) => ({
    keep: face,
    n: [normal[3 * index], normal[3 * index + 1], normal[3 * index + 2]],
    thk: thickness[index],
    body: body[index],
  }));
  return {
    walls,
    // eslint-disable-next-line kofem/no-silent-fallback -- the documented "no thin wall" value of ShellExtraction.shellBody
    shellBody: set.shellBody ?? -1,
    shellVerts: Array.from(set.vertices),
    shellTris: Array.from(set.triangles),
    shellThk: Array.from(set.thicknesses),
    shellSrc: Array.from(set.nodeSource),
    shellTriSrc: Array.from(set.triangleSource),
  };
}

function couplingInput({
  ties = [],
  referencePoints = [],
}: CouplingOptions): CouplingInput {
  const offsets = (lists: number[][]): Uint32Array => {
    const out = [0];
    for (const list of lists) out.push(out[out.length - 1] + list.length);
    return Uint32Array.from(out);
  };
  return new CouplingInput(
    ties.map((tie) => tie.name),
    Uint32Array.from(ties.flatMap((tie) => tie.verticesA)),
    offsets(ties.map((tie) => tie.verticesA)),
    Uint32Array.from(ties.flatMap((tie) => tie.verticesB)),
    offsets(ties.map((tie) => tie.verticesB)),
    Float64Array.from(ties.map((tie) => tie.maxSeparation)),
    Uint32Array.from(referencePoints),
  );
}

// The coupling and tie-report getters both Rust model results share.
interface RustCoupledResult {
  readonly couplingRef: Uint32Array;
  readonly couplingOffsets: Uint32Array;
  readonly couplingSolid: Uint32Array;
  readonly couplingMpc: Int32Array;
  readonly couplingWeights: Float64Array;
  readonly couplingDofMask: Uint32Array;
  readonly tieNames: string[];
  readonly tieCoupled: Uint32Array;
  readonly tiePartners: Uint32Array;
  readonly tieShared: Uint32Array;
  readonly tieGap: Float64Array;
  readonly tieDropKind: string[];
  readonly tieDropSide: string[];
  readonly tieDropValues: Float64Array;
  readonly tieProblems: string[];
}

function couplingFrom(result: RustCoupledResult): CouplingSet {
  return {
    ref: Array.from(result.couplingRef),
    offsets: Array.from(result.couplingOffsets),
    solid: Array.from(result.couplingSolid),
    mpc: Array.from(result.couplingMpc),
    weights: Array.from(result.couplingWeights),
    dofMask: Array.from(result.couplingDofMask),
  };
}

function tieSide(side: string): "A" | "B" | "both" {
  if (side === "A" || side === "B" || side === "both") return side;
  throw new Error(`unknown tie surface side "${side}" from the Rust module`);
}

// The drop of report `index`, decoded from the wire form documented on the
// Rust side (kind, side, three numbers whose meaning follows the kind).
function tieDrop(
  result: RustCoupledResult,
  index: number,
): TieCouplingDrop | undefined {
  const values = result.tieDropValues;
  const [first, second] = [values[3 * index], values[3 * index + 1]];
  const kind = result.tieDropKind[index];
  switch (kind) {
    case "":
      return undefined;
    case "no-pool-nodes":
      return { kind, side: tieSide(result.tieDropSide[index]) };
    case "out-of-reach":
      return { kind, searched: first };
    case "beyond-search-distance":
      return { kind, gap: first, reach: second };
    case "too-few-partners":
      return { kind, refs: first, radius: second };
    default:
      throw new Error(`unknown tie drop "${kind}" from the Rust module`);
  }
}

function tieReportsFrom(result: RustCoupledResult): TieCouplingReport[] {
  const coupled = result.tieCoupled,
    partners = result.tiePartners,
    shared = result.tieShared,
    gaps = result.tieGap,
    problems = result.tieProblems;
  return result.tieNames.map((name, index) => {
    const report: TieCouplingReport = {
      name,
      nCoupled: coupled[index],
      nPartners: partners[index],
      nShared: shared[index],
      gap: gaps[index],
    };
    const drop = tieDrop(result, index);
    if (drop) report.drop = drop;
    if (problems[index] !== "") report.problem = problems[index];
    return report;
  });
}

function pairMap(keys: Uint32Array, values: Uint32Array): Map<number, number> {
  return new Map(Array.from(keys, (key, index) => [key, values[index]]));
}

// ── Stages ────────────────────────────────────────────────────────────────────

// Detect thin walls (opposite planar CAD-face pairs) and collapse each to a
// mid-surface facet with its wall thickness, welded at junctions. Returns an
// empty extraction (shellBody = -1) when no thin wall is found.
// `shellBodyIds` names the bodies to idealise as shells (the app passes the
// per-body Shell/Solid choice; omitted, the largest thin-walled body is used).
// Only ONE body is shelled per solve — this extraction carries one shell body
// and its material — so among the requested bodies the one with the largest
// thin wall is used.
export function extractThinWallShells(
  m: ShellizeMesh,
  {
    maxWall = 15,
    shellBodyIds,
  }: { maxWall?: number; shellBodyIds?: Set<number> } = {},
): ShellExtraction {
  return using(meshInput(m), (mesh) =>
    using(
      rustExtractShells(
        mesh,
        shellBodyIds ? Int32Array.from(shellBodyIds) : undefined,
        maxWall,
      ),
      shellsFrom,
    ),
  );
}

// The tets of the shelled body that lie inside a detected thin wall (centroid
// within margin × t/2 of the mid-surface) — what the shells replace when an
// unsplit part is shelled (dev scripts; the app shells whole bodies).
export function shellWallTets(
  m: ShellizeMesh,
  shells: ShellExtraction,
  { margin = 1.0 }: { margin?: number } = {},
): Set<number> {
  return using(meshInput(m), (mesh) =>
    using(
      shellInput(shells),
      (set) => new Set(rustShellWallTets(mesh, set, margin)),
    ),
  );
}

// Every tet of the shelled body. A body some of whose tets lie in no detected
// wall (a curved or small face, a thick block) is refused with the share of it
// the shells would drop.
export function shellBodyTets(
  m: ShellizeMesh,
  shells: ShellExtraction,
): Set<number> {
  return using(meshInput(m), (mesh) =>
    using(shellInput(shells), (set) => new Set(rustShellBodyTets(mesh, set))),
  );
}

// Assemble the coupled node pool (solid nodes, then shell nodes, then
// reference points), remap the solid tets — every tet except the shelled
// body's `wallTets` — and the shell facets onto it, and tie the two domains.
export function buildCoupledModel(
  m: ShellizeMesh,
  shells: ShellExtraction,
  wallTets: Set<number>,
  options: CouplingOptions = {},
): CoupledModel {
  return using(meshInput(m), (mesh) =>
    using(shellInput(shells), (set) =>
      using(couplingInput(options), (input) =>
        using(
          rustCoupledModel(mesh, set, Uint32Array.from(wallTets), input),
          (result) => ({
            pool: Array.from(result.pool),
            tets: Array.from(result.tets),
            tetBody: Array.from(result.tetBody),
            triangles: Array.from(result.triangles),
            thicknesses: Array.from(result.thicknesses),
            coupling: couplingFrom(result),
            solidPool: pairMap(
              result.solidPoolVertices,
              result.solidPoolIndices,
            ),
            shellPool: Array.from(result.shellPool),
            refPool: pairMap(result.refPoolVertices, result.refPoolIndices),
            tieReports: tieReportsFrom(result),
          }),
        ),
      ),
    ),
  );
}

// Preserve 3-D material at planar wall roots before the shell idealisation:
// cut the retained solid a few wall thicknesses into each wall that meets it,
// clip the shells to match, and couple each shell edge to the cut section.
// Returns the clipped mesh, the clipped shells and the coupled model (no ties —
// this runs at mesh time, before any surface is picked).
export function buildShellTransitionModel(
  m: ShellizeMesh,
  shells: ShellExtraction,
): { mesh: ShellizeMesh; shells: ShellExtraction; model: CoupledModel } {
  return using(meshInput(m), (mesh) =>
    using(shellInput(shells), (set) =>
      using(rustShellTransition(mesh, set), (transition) => {
        const model = using(transition.model, (result) => ({
          pool: Array.from(result.pool),
          tets: Array.from(result.tets),
          tetBody: Array.from(result.tetBody),
          triangles: Array.from(result.triangles),
          thicknesses: Array.from(result.thicknesses),
          coupling: couplingFrom(result),
          solidPool: pairMap(result.solidPoolVertices, result.solidPoolIndices),
          shellPool: Array.from(result.shellPool),
          refPool: pairMap(result.refPoolVertices, result.refPoolIndices),
          tieReports: tieReportsFrom(result),
        }));
        return {
          mesh: using(transition.mesh, meshFrom),
          shells: using(transition.shells, shellsFrom),
          model,
        };
      }),
    ),
  );
}

// Pool the solid tet nodes, then the shell nodes (reusing a node shared with a
// tet), then the reference points, and tie the unshared shell nodes on the
// solid boundary by the same rule as the auto-shell path, so a saved mixed
// model reloads with the seam it was meshed with.
export function buildExplicitCoupledModel(
  V: number[], // 3·nNodes, xyz interleaved (store vertex order)
  solidTets: number[], // 4·nSolidTets, store vertex indices
  shellTris: number[], // 3·nShellTris, store vertex indices
  shellThk: number[], // per shell triangle thickness
  options: CouplingOptions = {},
): ExplicitCoupledModel {
  return using(couplingInput(options), (input) =>
    using(
      rustExplicitCoupledModel(
        Float64Array.from(V),
        Uint32Array.from(solidTets),
        Uint32Array.from(shellTris),
        Float64Array.from(shellThk),
        input,
      ),
      (result) => ({
        pool: Array.from(result.pool),
        tets: Array.from(result.tets),
        triangles: Array.from(result.triangles),
        thicknesses: [...shellThk],
        coupling: couplingFrom(result),
        poolOfVertex: pairMap(
          result.poolOfVertexKeys,
          result.poolOfVertexValues,
        ),
        shellPoolIndex: new Set(result.shellPoolIndex),
        tieReports: tieReportsFrom(result),
      }),
    ),
  );
}

// The pool is built in three blocks — solid nodes, then shell mid-surface
// nodes, then reference points — so a pool index says which it is.
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
// offset ~t/2 from the original solid surface). Expanding ring search, so it
// works regardless of the offset magnitude; throws when no shell node lies
// within the searched radius rather than mapping onto an arbitrary one (#378).
export function shellNodeLocator(model: CoupledModel): (p: Vec3) => number {
  const cell = 15;
  const point = (index: number): Vec3 => [
    model.pool[3 * index],
    model.pool[3 * index + 1],
    model.pool[3 * index + 2],
  ];
  const grid = new SpatialGrid(model.shellPool, point, cell);
  const maxRings = 6;
  return (p) => {
    let best = -1,
      bestDistance = Infinity;
    for (let ring = 0; ring <= maxRings && bestDistance === Infinity; ring++)
      for (const index of grid.candidates(p, ring, ring)) {
        const node = point(index);
        const distance =
          (p[0] - node[0]) ** 2 + (p[1] - node[1]) ** 2 + (p[2] - node[2]) ** 2;
        if (distance < bestDistance) {
          bestDistance = distance;
          best = index;
        }
      }
    if (best < 0)
      throw new Error(
        `shellNodeLocator: no shell mid-surface node found within ${maxRings * cell} units of ` +
          `query point (${p[0]}, ${p[1]}, ${p[2]}) — a boundary condition or load on the shelled ` +
          "body could not be mapped onto the shell mesh. The node may lie farther from any thin " +
          "wall than the search radius, or the model may be mis-scaled.",
      );
    return best;
  };
}

// The sentence for a connection that coupled nothing, or undefined when it did
// couple (nodes the two surfaces SHARE already join them).
export function tieCouplingProblem(
  report: TieCouplingReport,
): string | undefined {
  return report.problem;
}

// ── Coupling-set plumbing ─────────────────────────────────────────────────────
// These operate on the wire form only, and also on the couplings the user
// declares (coupling.ts), so they stay on this side of the boundary.

// All six DOFs of a coupling — the engine's kAllDofs.
const ALL_DOF_MASK = 0x3f;

export function couplingMpcCodes(set: CouplingSet): number[] {
  if (set.mpc) return set.mpc;
  return set.ref.map(() => 0);
}

export function couplingDofMasks(set: CouplingSet): number[] {
  if (set.dofMask) return set.dofMask;
  return set.ref.map(() => ALL_DOF_MASK);
}

// Concatenate two CSR coupling sets into one, preserving each set's
// per-reference kind, DOF mask and partner weights.
export function concatCouplings(a: CouplingSet, b: CouplingSet): CouplingSet {
  const ref = [...a.ref, ...b.ref];
  const solid = [...a.solid, ...b.solid];
  const offsets = [...a.offsets];
  const base = a.solid.length;
  for (let k = 1; k < b.offsets.length; k++) offsets.push(base + b.offsets[k]);
  return {
    ref,
    offsets,
    solid,
    mpc: [...couplingMpcCodes(a), ...couplingMpcCodes(b)],
    dofMask: [...couplingDofMasks(a), ...couplingDofMasks(b)],
    weights: [
      ...(a.weights ?? a.solid.map(() => 1)),
      ...(b.weights ?? b.solid.map(() => 1)),
    ],
  };
}

// Drop the dependent couplings whose reference node carries an essential BC.
// A fixed node's motion is prescribed, so it cannot ALSO be the dependent of a
// coupling — the engine refuses that conflict (#377). A KINEMATIC coupling's
// reference is independent, so fixing it is no conflict; a fixed FOOTPRINT
// node would cut the shell/solid transition and is refused.
export function dropCouplingsOnFixedNodes(
  coupling: CouplingSet,
  fixedDofs: Iterable<number>,
): CouplingSet {
  const fixedNodes = new Set<number>();
  for (const d of fixedDofs) fixedNodes.add(Math.floor(d / 6));
  const kinds = couplingMpcCodes(coupling);
  const masks = couplingDofMasks(coupling);
  const weights: number[] = [];
  const ref: number[] = [],
    offsets = [0],
    solid: number[] = [],
    mpc: number[] = [],
    dofMask: number[] = [];
  for (let k = 0; k < coupling.ref.length; k++) {
    if (kinds[k] === 3 && fixedNodes.has(coupling.ref[k]))
      throw new Error(
        "A shell/solid transition node is prescribed. Move the support away from the transition or keep the body Solid.",
      );
    if (kinds[k] !== 2 && fixedNodes.has(coupling.ref[k])) continue;
    ref.push(coupling.ref[k]);
    for (let i = coupling.offsets[k]; i < coupling.offsets[k + 1]; i++) {
      solid.push(coupling.solid[i]);
      weights.push(coupling.weights ? coupling.weights[i] : 1);
    }
    offsets.push(solid.length);
    mpc.push(kinds[k]);
    dofMask.push(masks[k]);
  }
  return { ref, offsets, solid, mpc, dofMask, weights };
}
