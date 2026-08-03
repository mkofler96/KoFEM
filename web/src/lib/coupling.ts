// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Surface-to-point coupling (KOF-208): a picked surface is idealised to a single
// REFERENCE POINT, so a bolt, a bearing or a screw connection is stated as the
// one point it acts through instead of being smeared over the nodes of a hole.
//
// The engine half landed first (engine/cpp/shell_core.cpp); this is the model
// side that feeds it. Two kinds, and the choice between them is a modelling
// decision, not a detail:
//
//   distributing (RBE3) — the reference point is DEPENDENT: it follows the
//                         weighted average of the coupled nodes. It adds no
//                         stiffness, so the gripped surface stays flexible —
//                         but the point can only be LOADED, never fixed,
//                         driven, or coupled onward.
//   kinematic (RBE2)    — the coupled nodes are dependent and follow the point
//                         rigidly, u_i = u_R + θ_R × r_i. The point stays
//                         independent, so it can be fixed, loaded or tied to
//                         another point; the price is that the surface it grips
//                         becomes rigid.
//
// The DOF mask selects which of the reference point's six DOFs a KINEMATIC
// coupling ties. On a surface of solid nodes it does almost nothing (solid nodes
// have no rotational DOF to tie, and the point's rotation already reaches them
// through θ_R × r); it earns its keep on a point-to-point coupling, where
// x,y,z alone is a spherical joint and all six is a rigid link.

// ── Model types ───────────────────────────────────────────────────────────────

export type CouplingKind = "distributing" | "kinematic";

export interface CouplingNode {
  id: number;
  x: number;
  y: number;
  z: number;
}

export interface CouplingElement {
  type: string;
  nodeIds: number[];
}

// The structural minimum of a coupling the solver needs. The store's
// CouplingGroup (boundarySlice) satisfies it, and so does the solve payload.
export interface CouplingDefinition {
  name: string;
  kind: CouplingKind;
  // Tied DOFs (0..2 translations, 3..5 rotations) of a kinematic coupling.
  // Ignored by a distributing coupling, which always ties all six.
  dofs: number[];
  // The reference point, as a node in the model's own node numbering. It is a
  // real node (created with the coupling, removed with it), so a BC or a load
  // reaches it through exactly the machinery every other node uses.
  refNodeId: number;
  // The coupled surface.
  faces: { nodeIds: number[] }[];
}

// All six DOFs — what a coupling with no explicit mask ties.
export const ALL_DOFS = [0, 1, 2, 3, 4, 5];

// Engine `mpc` kind code (solve_coupled): 0 distributing RBE3, 2 kinematic RBE2.
// 1 is the shell-to-solid relaxed MPC, which is not a user-declared coupling.
export function couplingMpcCode(kind: CouplingKind): number {
  return kind === "kinematic" ? 2 : 0;
}

// Bit c of the engine's dof_mask selects DOF c of every coupled node.
export function couplingDofMask(kind: CouplingKind, dofs: number[]): number {
  if (kind !== "kinematic") return 0x3f; // distributing ties all six
  let mask = 0;
  for (const dof of dofs) mask |= 1 << dof;
  return mask;
}

// The coupled nodes of one coupling, de-duplicated. A surface picked in two
// faces that overlap would otherwise offer the same node twice, and a kinematic
// coupling eliminating the same DOF twice is an error the engine refuses.
export function coupledNodeIds(coupling: CouplingDefinition): number[] {
  const ids = new Set<number>();
  for (const face of coupling.faces)
    for (const nodeId of face.nodeIds) ids.add(nodeId);
  ids.delete(coupling.refNodeId);
  return [...ids];
}

// ── Reference point placement ─────────────────────────────────────────────────

export interface ReferencePointOption {
  // What the position means, for the panel's dropdown.
  label: string;
  point: [number, number, number];
}

type Vec3 = [number, number, number];

function sub(a: Vec3, b: Vec3): Vec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

function dot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function cross(a: Vec3, b: Vec3): Vec3 {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}

// Component-wise mean. Summed first and divided once: dividing each term by the
// count instead accumulates rounding, so the centre of a face whose coordinates
// average exactly comes back a few ulp off — visible as 1.9999999999999998 in a
// coordinate box the user is meant to read and re-type.
function centroidOf(points: Vec3[]): Vec3 {
  const total: Vec3 = [0, 0, 0];
  for (const point of points) {
    total[0] += point[0];
    total[1] += point[1];
    total[2] += point[2];
  }
  return [
    total[0] / points.length,
    total[1] / points.length,
    total[2] / points.length,
  ];
}

// Eigenvector of the smallest eigenvalue of a symmetric 3×3 matrix, by cyclic
// Jacobi rotations. The matrix is tiny and the sweep converges in a handful of
// passes, so this is exact enough to fit an axis and needs no linear-algebra
// dependency.
function smallestEigenvector(matrix: number[][]): Vec3 {
  const work = matrix.map((row) => [...row]);
  // Accumulated rotations; its columns are the eigenvectors.
  const vectors = [
    [1, 0, 0],
    [0, 1, 0],
    [0, 0, 1],
  ];
  for (let sweep = 0; sweep < 24; sweep++) {
    let offDiagonal = 0;
    for (let p = 0; p < 3; p++)
      for (let q = p + 1; q < 3; q++) offDiagonal += work[p][q] * work[p][q];
    if (offDiagonal < 1e-30) break;
    for (let p = 0; p < 3; p++)
      for (let q = p + 1; q < 3; q++) {
        if (Math.abs(work[p][q]) < 1e-30) continue;
        // Standard cyclic-Jacobi rotation (Golub & Van Loan, Matrix
        // Computations §8.4): θ = (a_qq − a_pp)/(2·a_pq), and the smaller root
        // t = sign(θ)/(|θ| + √(θ²+1)) keeps the rotation angle under 45°.
        // θ = 0 is the symmetric case, where either root serves; take +.
        const theta = (work[q][q] - work[p][p]) / (2 * work[p][q]);
        const tan =
          (theta < 0 ? -1 : 1) /
          (Math.abs(theta) + Math.sqrt(theta * theta + 1));
        const cos = 1 / Math.sqrt(tan * tan + 1);
        const sin = tan * cos;
        for (let k = 0; k < 3; k++) {
          const kp = work[k][p],
            kq = work[k][q];
          work[k][p] = cos * kp - sin * kq;
          work[k][q] = sin * kp + cos * kq;
        }
        for (let k = 0; k < 3; k++) {
          const pk = work[p][k],
            qk = work[q][k];
          work[p][k] = cos * pk - sin * qk;
          work[q][k] = sin * pk + cos * qk;
        }
        for (let k = 0; k < 3; k++) {
          const kp = vectors[k][p],
            kq = vectors[k][q];
          vectors[k][p] = cos * kp - sin * kq;
          vectors[k][q] = sin * kp + cos * kq;
        }
      }
  }
  let best = 0;
  for (let i = 1; i < 3; i++) if (work[i][i] < work[best][best]) best = i;
  return [vectors[0][best], vectors[1][best], vectors[2][best]];
}

// The element boundary faces lying entirely on a picked node set — the same
// membership test the surface loads use, so "the picked surface" means one
// thing across the app. Triangles only: the axis fit needs facet normals, and a
// hex face is split into its two triangles by the caller's winding either way.
function pickedTriangles(
  nodeIds: Set<number>,
  elements: CouplingElement[],
): [number, number, number][] {
  const TET_FACES = [
    [0, 1, 2],
    [0, 1, 3],
    [0, 2, 3],
    [1, 2, 3],
  ];
  const HEX_FACES = [
    [0, 1, 2, 3],
    [4, 5, 6, 7],
    [0, 1, 5, 4],
    [1, 2, 6, 5],
    [2, 3, 7, 6],
    [3, 0, 4, 7],
  ];
  const seen = new Set<string>();
  const tris: [number, number, number][] = [];
  const add = (a: number, b: number, c: number) => {
    const key = [a, b, c].sort((x, y) => x - y).join(",");
    if (seen.has(key)) return;
    seen.add(key);
    tris.push([a, b, c]);
  };
  for (const el of elements) {
    if (el.type === "CTRIA3") {
      if (el.nodeIds.every((n) => nodeIds.has(n)))
        add(el.nodeIds[0], el.nodeIds[1], el.nodeIds[2]);
      continue;
    }
    const local =
      el.type === "CTETRA" ? TET_FACES : el.type === "CHEXA" ? HEX_FACES : null;
    if (!local) continue;
    for (const face of local) {
      const verts = face.map((i) => el.nodeIds[i]);
      if (!verts.every((n) => nodeIds.has(n))) continue;
      add(verts[0], verts[1], verts[2]);
      if (verts.length === 4) add(verts[0], verts[2], verts[3]);
    }
  }
  return tris;
}

// Axis of the cylinder a picked surface lies on, or null when it is not one.
//
// Every normal of a cylinder is perpendicular to its axis, so the axis is the
// direction â that minimises Σ A·(n̂·â)² — the smallest eigenvector of the
// area-weighted normal covariance Σ A·n̂n̂ᵀ. Fitting the POSITIONS instead cannot
// do this: for a cylinder of radius R and length L the position covariance has
// eigenvalues L²/12 along the axis and R²/2 across it, so which one is smallest
// flips between a long tube and a short bore — the axis would be found for one
// and lost for the other.
//
// The fit is then CHECKED rather than trusted: the radial distances of the
// picked nodes from the fitted axis must agree to within `tolerance` of their
// mean. A flat face or a fillet passes the eigen-solve just as happily as a bore
// does, and offering "axis end" positions on one would place the reference point
// somewhere with no meaning.
function fitCylinderAxis(
  points: Vec3[],
  triangles: [number, number, number][],
  positionOf: (nodeId: number) => Vec3 | undefined,
  tolerance: number,
): { axis: Vec3; centre: Vec3 } | null {
  if (points.length < 6 || triangles.length < 2) return null;

  const cov = [
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0],
  ];
  let totalArea = 0;
  for (const [ia, ib, ic] of triangles) {
    const cornerA = positionOf(ia),
      cornerB = positionOf(ib),
      cornerC = positionOf(ic);
    if (!cornerA || !cornerB || !cornerC) continue;
    const normal = cross(sub(cornerB, cornerA), sub(cornerC, cornerA));
    const twiceArea = Math.hypot(normal[0], normal[1], normal[2]);
    if (twiceArea < 1e-20) continue;
    const area = 0.5 * twiceArea;
    const unit: Vec3 = [
      normal[0] / twiceArea,
      normal[1] / twiceArea,
      normal[2] / twiceArea,
    ];
    totalArea += area;
    for (let i = 0; i < 3; i++)
      for (let j = 0; j < 3; j++) cov[i][j] += area * unit[i] * unit[j];
  }
  if (totalArea < 1e-20) return null;

  const axis = smallestEigenvector(cov);
  const len = Math.hypot(axis[0], axis[1], axis[2]);
  if (len < 1e-12) return null;
  const unitAxis: Vec3 = [axis[0] / len, axis[1] / len, axis[2] / len];

  const centre = centroidOf(points);

  // Radial spread about the fitted axis — constant on a cylinder, wildly
  // uneven on anything else.
  const radii = points.map((point) => {
    const offset = sub(point, centre);
    const along = dot(offset, unitAxis);
    return Math.hypot(
      offset[0] - along * unitAxis[0],
      offset[1] - along * unitAxis[1],
      offset[2] - along * unitAxis[2],
    );
  });
  const mean = radii.reduce((sum, r) => sum + r, 0) / radii.length;
  if (mean < 1e-12) return null;
  const variance =
    radii.reduce((sum, r) => sum + (r - mean) ** 2, 0) / radii.length;
  if (Math.sqrt(variance) / mean > tolerance) return null;

  return { axis: unitAxis, centre };
}

// Where a coupling's reference point may sit, given the surface it grips.
//
// Always the centre of the selection — the mean of its nodes, which for a full
// bore is its mid-axis point and for a picked rim is the centre of the ring.
// When the selection is a cylinder (a bolt hole, a bearing seat), the two ends
// of its axis are offered as well: KOF-208's "up and down centre", the positions
// a bolt head and a nut actually occupy. Any other position is typed in as
// coordinates, which is why this list is a starting point and not a constraint.
export function referencePointOptions(
  faces: { nodeIds: number[] }[],
  nodes: CouplingNode[],
  elements: CouplingElement[],
  { cylinderTolerance = 0.12 }: { cylinderTolerance?: number } = {},
): ReferencePointOption[] {
  const nodeIds = new Set<number>();
  for (const face of faces) for (const id of face.nodeIds) nodeIds.add(id);
  if (nodeIds.size === 0) return [];

  const byId = new Map(nodes.map((n) => [n.id, n]));
  const positionOf = (id: number): Vec3 | undefined => {
    const n = byId.get(id);
    return n ? [n.x, n.y, n.z] : undefined;
  };
  const points: Vec3[] = [];
  for (const id of nodeIds) {
    const position = positionOf(id);
    if (position) points.push(position);
  }
  if (points.length === 0) return [];

  const centroid = centroidOf(points);
  const options: ReferencePointOption[] = [
    { label: "Selection centre", point: centroid },
  ];

  const fit = fitCylinderAxis(
    points,
    pickedTriangles(nodeIds, elements),
    positionOf,
    cylinderTolerance,
  );
  if (!fit) return options;

  let lo = Infinity,
    hi = -Infinity;
  for (const point of points) {
    const along = dot(sub(point, fit.centre), fit.axis);
    if (along < lo) lo = along;
    if (along > hi) hi = along;
  }
  if (!(hi > lo)) return options;

  const at = (along: number): Vec3 => [
    fit.centre[0] + along * fit.axis[0],
    fit.centre[1] + along * fit.axis[1],
    fit.centre[2] + along * fit.axis[2],
  ];
  // Name the two ends by the axis direction rather than "up"/"down": the fitted
  // axis has no preferred sign, and a bore drilled along −Z would have its ends
  // labelled backwards by any fixed naming.
  options.push(
    { label: "Axis end (−)", point: at(lo) },
    { label: "Axis end (+)", point: at(hi) },
  );
  return options;
}

// ── Solver-facing coupling set ────────────────────────────────────────────────

// The CSR coupling set solve_coupled takes: coupling k ties `ref[k]` to
// `solid[offsets[k] .. offsets[k+1])`, with `mpc[k]` selecting the kind and
// `dofMask[k]` the DOFs a kinematic coupling ties.
export interface ReferenceCouplingSet {
  ref: number[];
  offsets: number[];
  solid: number[];
  mpc: number[];
  dofMask: number[];
}

// Build the coupling set from the model's couplings, over pool node indices.
//
// `poolOf` resolves a store node id to its index in the coupled node pool; it
// throws when a node is not in the pool, which is the right outcome — a coupling
// naming a node the solve does not carry is a broken model, not something to
// quietly drop.
export function buildReferenceCouplings(
  couplings: CouplingDefinition[],
  poolOf: (nodeId: number, context: string) => number,
): ReferenceCouplingSet {
  const ref: number[] = [];
  const offsets = [0];
  const solid: number[] = [];
  const mpc: number[] = [];
  const dofMask: number[] = [];

  // A DOF can be eliminated by only one constraint, so a node coupled by two
  // KINEMATIC couplings is a modelling error the engine refuses deep inside the
  // reduction. Catch it here, where the coupling that caused it can be named.
  const kinematicOwner = new Map<number, string>();

  for (const coupling of couplings) {
    const coupled = coupledNodeIds(coupling);
    if (coupled.length === 0)
      throw new Error(
        `Coupling "${coupling.name}" grips no node — pick the surface it couples to ` +
          "its reference point, or delete the coupling.",
      );
    if (coupling.kind === "distributing" && coupled.length < 3)
      throw new Error(
        `Coupling "${coupling.name}" is distributing but grips only ${coupled.length} ` +
          "node(s); an RBE3 average needs at least 3. Pick a larger surface, or make " +
          "the coupling kinematic.",
      );
    const mask = couplingDofMask(coupling.kind, coupling.dofs);
    if (mask === 0)
      throw new Error(
        `Coupling "${coupling.name}" is kinematic but ties no DOF at all — select at ` +
          "least one of Ux…Rz.",
      );

    const refPool = poolOf(coupling.refNodeId, `coupling "${coupling.name}"`);
    for (const nodeId of coupled) {
      if (coupling.kind === "kinematic") {
        const owner = kinematicOwner.get(nodeId);
        if (owner !== undefined)
          throw new Error(
            `Node ${nodeId} is gripped by both kinematic couplings "${owner}" and ` +
              `"${coupling.name}" — a DOF can be eliminated by only one constraint. ` +
              "Make one of them distributing, or pick surfaces that do not overlap.",
          );
        kinematicOwner.set(nodeId, coupling.name);
      }
      solid.push(poolOf(nodeId, `coupling "${coupling.name}" surface`));
    }
    ref.push(refPool);
    offsets.push(solid.length);
    mpc.push(couplingMpcCode(coupling.kind));
    dofMask.push(mask);
  }

  return { ref, offsets, solid, mpc, dofMask };
}

// Reference-point node ids of a model's couplings — the nodes that carry six
// DOFs without belonging to any element, so the solve path knows to put them in
// the pool and the load path knows a moment on them is a real moment.
export function referencePointIds(
  couplings: CouplingDefinition[],
): Set<number> {
  return new Set(couplings.map((coupling) => coupling.refNodeId));
}
