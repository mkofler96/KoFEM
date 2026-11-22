// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Support reactions after a static solve (KOF-387). The Rust module computes
// the nodal reactions K·u − f of each path and sums them per support
// (crates/kofem-fem/src/reactions.rs); this module builds what it reads — which
// support holds each solver DOF — and reads its result back.

import type { Constraint, SolveModel } from "../../workers/solverTypes.js";
import { buildVertexIndexer } from "../solveMeshPacking.js";

export type Vec3 = [number, number, number];

// The resultant reaction of one support: the force, and the moment about the
// centroid of the vertices it holds. `support` is the index of its BC group.
export interface SupportReaction {
  support: number;
  force: Vec3;
  moment: Vec3;
  centroid: Vec3;
  // Vertices the support holds in the solve; 0 when none of its nodes reached
  // it (an empty group, or one whose faces the mesh no longer has).
  vertices: number;
}

export interface ReactionSummary {
  supports: SupportReaction[];
  // Σ of the applied nodal forces, N.
  applied: Vec3;
  // Σ of the applied forces on held DOFs: load that goes straight into a
  // support without loading the structure.
  appliedOnSupports: Vec3;
}

// Which support holds each solver DOF: 6 per solver vertex, the BC group
// index or −1, and how many supports there are.
export interface SupportOwners {
  owners: Int32Array;
  supports: number;
}

// The DOFs of the solver vertices that each support's constraints reach.
// `vertexOf` maps a constraint's node to its solver vertex, as the path that
// builds the solve maps it. A DOF two supports name belongs to the first.
// Constraints without a group (none in the app; tests and old fixtures)
// belong to no support.
export function supportOwners(
  constraints: readonly Constraint[],
  vertexCount: number,
  vertexOf: (nodeId: number) => number,
): SupportOwners {
  const owners = new Int32Array(6 * vertexCount).fill(-1);
  let supports = 0;
  for (const constraint of constraints) {
    const { group } = constraint;
    if (group === undefined) continue;
    if (!Number.isInteger(group) || group < 0)
      throw new Error(
        `support reactions: constraint on node ${constraint.nodeId} names support ${group}`,
      );
    if (constraint.dof < 0 || constraint.dof > 5)
      throw new Error(
        `support reactions: constraint on node ${constraint.nodeId} names DOF ${constraint.dof}`,
      );
    const vertex = vertexOf(constraint.nodeId);
    if (!Number.isInteger(vertex) || vertex < 0 || vertex >= vertexCount)
      throw new Error(
        `support reactions: node ${constraint.nodeId} maps to vertex ${vertex}, but the solve has ${vertexCount}`,
      );
    const dof = 6 * vertex + constraint.dof;
    if (owners[dof] === -1) owners[dof] = group;
    supports = Math.max(supports, group + 1);
  }
  return { owners, supports };
}

// The owners of a solve whose vertices are the payload's nodes, in order (the
// explicit shell path).
export function payloadSupportOwners(
  payload: Pick<SolveModel, "nodes" | "constraints">,
): SupportOwners {
  const vid = buildVertexIndexer(payload.nodes);
  return supportOwners(payload.constraints, payload.nodes.length, (nodeId) =>
    vid(nodeId, "support reaction"),
  );
}

// Values per support in the Rust result.
const STRIDE = 10;

const vec3 = (flat: Float64Array, at: number): Vec3 => [
  flat[at],
  flat[at + 1],
  flat[at + 2],
];

// The Rust `supportReactions` result: per support force, moment, centroid and
// vertex count, then the applied force and the applied force on supports.
export function parseReactions(
  flat: Float64Array,
  supports: number,
): ReactionSummary {
  if (flat.length !== STRIDE * supports + 6)
    throw new Error(
      `support reactions: ${flat.length} values for ${supports} supports; expected ${STRIDE * supports + 6}`,
    );
  const list: SupportReaction[] = [];
  for (let support = 0; support < supports; support++) {
    const at = STRIDE * support;
    list.push({
      support,
      force: vec3(flat, at),
      moment: vec3(flat, at + 3),
      centroid: vec3(flat, at + 6),
      vertices: flat[at + 9],
    });
  }
  const tail = STRIDE * supports;
  return {
    supports: list,
    applied: vec3(flat, tail),
    appliedOnSupports: vec3(flat, tail + 3),
  };
}

// A Rust model that sums a solution's reactions per support.
export interface ReactionModel<Solution> {
  supportReactions(
    solution: Solution,
    forces: Float64Array,
    owners: Int32Array,
    supports: number,
  ): Float64Array;
}

// The summary of `solution`, or null for a model without supports.
export function readReactions<Solution>(
  model: ReactionModel<Solution>,
  solution: Solution,
  forces: Float64Array,
  owners: SupportOwners,
): ReactionSummary | null {
  if (owners.supports === 0) return null;
  return parseReactions(
    model.supportReactions(solution, forces, owners.owners, owners.supports),
    owners.supports,
  );
}

const norm = (v: readonly number[]) => Math.hypot(v[0], v[1], v[2]);

// Relative imbalance below which reactions and loads count as balanced: well
// above the solver tolerance (1e-8 and tighter), well below anything a user
// would read as a mismatch.
export const BALANCE_TOLERANCE = 1e-3;

export interface ReactionBalance {
  // Σ of every support's reaction force.
  reaction: Vec3;
  applied: Vec3;
  // applied + reaction: zero when the supports carry the whole load.
  difference: Vec3;
  balanced: boolean;
  // Part of the load sits on held DOFs and goes straight into a support.
  loadOnSupports: boolean;
}

export function reactionBalance(summary: ReactionSummary): ReactionBalance {
  const reaction: Vec3 = [0, 0, 0];
  let largest = norm(summary.applied);
  for (const support of summary.supports) {
    for (let axis = 0; axis < 3; axis++) reaction[axis] += support.force[axis];
    largest = Math.max(largest, norm(support.force));
  }
  const difference: Vec3 = [
    summary.applied[0] + reaction[0],
    summary.applied[1] + reaction[1],
    summary.applied[2] + reaction[2],
  ];
  // With no load and no reaction at all there is nothing to balance.
  const scale = largest === 0 ? 1 : largest;
  return {
    reaction,
    applied: summary.applied,
    difference,
    balanced: norm(difference) <= BALANCE_TOLERANCE * scale,
    loadOnSupports: norm(summary.appliedOnSupports) > BALANCE_TOLERANCE * scale,
  };
}
