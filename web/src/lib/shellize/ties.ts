// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Tie connections the user declared between solid bodies, turned into
// distributing couplings — with a report of what each one contributed.

import { SpatialGrid } from "../spatialGrid.js";
import { concatCouplings, type CouplingSet } from "./couplingSet.js";
import { dist2, type Vec3 } from "./geometry.js";
import { autoDetectCouplings, partnerSearchRadius } from "./partners.js";

// One tie connection, as the coupled builders need it: the two surfaces the user
// picked, given as STORE VERTEX INDICES (the builder maps them to pool nodes),
// and how far the tie reaches. `maxSeparation` is the connection's search
// distance, or Infinity when it couples the full surface.
export interface TieSurfaces {
  name: string;
  verticesA: number[];
  verticesB: number[];
  maxSeparation: number;
}

// Why a tie connection ended up coupling nothing. The all-solid weld path already
// refuses a connection that joins nothing (solver.worker: "connected no nodes"),
// because an assembly that stays split solves to a plausible-looking but
// structurally wrong shape — the couplings are the load path. The coupled path
// used to drop the same connection silently (KOF-203); it now says which of the
// four ways it failed, since each has a different fix.
export type TieCouplingDrop =
  // One or both picked surfaces contributed no node to the solved pool.
  | { kind: "no-pool-nodes"; side: "A" | "B" | "both" }
  // The two surfaces never saw each other, even after widening the search.
  | { kind: "out-of-reach"; searched: number }
  // They do meet, but no closer than the connection's own search distance.
  | { kind: "beyond-search-distance"; gap: number; reach: number }
  // In range, but no reference found the three partners an RBE3 needs.
  | { kind: "too-few-partners"; refs: number; radius: number };

// What one tie connection actually contributed to the coupled model.
export interface TieCouplingReport {
  name: string;
  nCoupled: number; // reference nodes that got a distributing coupling
  nPartners: number; // partner slots those references distribute onto
  nShared: number; // nodes the two surfaces already have in common
  gap: number; // measured closest approach, 0 when never measured
  drop?: TieCouplingDrop;
}

// The sentence for a connection that coupled nothing, or undefined when it did
// couple. Nodes the two surfaces SHARE are already rigidly joined through the
// common pool DOFs, so a connection that only shares is connected, not dropped.
export function tieCouplingProblem(
  report: TieCouplingReport,
): string | undefined {
  if (report.nCoupled > 0 || report.nShared > 0 || !report.drop)
    return undefined;
  const head = `Tie "${report.name}" coupled no nodes`;
  const drop = report.drop;
  switch (drop.kind) {
    case "no-pool-nodes":
      return (
        `${head} — ${drop.side === "both" ? "neither picked surface has a node" : `picked surface ${drop.side} has no node`} ` +
        "in the solved model. Re-pick its surfaces after remeshing, or " +
        "mark the body Solid if the tie lands on a wall that was idealised as shell."
      );
    case "out-of-reach":
      return (
        `${head} — its two surfaces are more than ${drop.searched.toFixed(4)} mm apart. ` +
        "They are not the surfaces that touch; re-pick them."
      );
    case "beyond-search-distance":
      return (
        `${head} — its surfaces come no closer than ${drop.gap.toFixed(4)} mm, ` +
        `beyond its ${drop.reach.toFixed(4)} mm search distance. Increase the ` +
        "distance, or couple the full surface."
      );
    case "too-few-partners":
      return (
        `${head} — none of its ${drop.refs} in-range reference node(s) found the ` +
        `three partners a distributing coupling needs within ${drop.radius.toFixed(4)} mm. ` +
        "Refine the mesh on the other surface, or pick more of it."
      );
    // TieCouplingDrop is a closed union, so this is unreachable. The `never`
    // binding turns adding a drop kind without a message into a compile error,
    // rather than a connection that coupled nothing and reports no reason.
    default: {
      const unhandled: never = drop;
      throw new Error(
        `Cannot say why tie "${report.name}" coupled nothing: unhandled drop ${JSON.stringify(unhandled)}`,
      );
    }
  }
}

// Distance from each ref node to its nearest master node, for the refs that have
// one within `reach`. Grid cells are `reach` wide, so the 27-cell scan sees every
// candidate in range.
function nearestMasterDistances(
  ppt: (i: number) => Vec3,
  masters: number[],
  refs: number[],
  reach: number,
): Map<number, number> {
  const out = new Map<number, number>();
  if (masters.length === 0 || refs.length === 0 || !(reach > 0)) return out;
  const grid = new SpatialGrid(masters, ppt, reach);

  const reach2 = reach * reach;
  for (const gi of refs) {
    const pos = ppt(gi);
    let best = Infinity;
    for (const pi of grid.candidates(pos, 1)) {
      const candidate = dist2(pos, ppt(pi));
      if (candidate < best) best = candidate;
    }
    if (best <= reach2) out.set(gi, Math.sqrt(best));
  }
  return out;
}

// One tie connection mapped onto pool nodes: surface A becomes the coupling
// partners, surface B the references.
export interface PoolTie {
  name: string;
  masters: number[];
  refs: number[];
  reach: number;
}

// Distributing (RBE3) tie of the two surfaces of one connection — two solid
// bodies that touch across a clearance (a pin in a hook eye). The nodes of
// surface B become the references; each distributes onto the surface-A nodes
// around it, transmitting force AND moment across the clearance without merging
// the meshes.
//
// This used to be detected automatically: the bodies were split by label, the
// one with the most nodes declared "master", and every other body's interface
// band slaved to it. That guessed at the modelling intent — which parts are
// joined, and over how much of their surface — from geometry alone, and had no
// way to be inspected or corrected. Which surfaces are tied is now stated
// explicitly (a tie connection in the Constraints panel), and this reads it.
//
// Two distances, both derived rather than assumed:
//   gap    — the measured closest approach of the two picked surfaces, found by
//            doubling the search until they see each other, because the
//            clearance of a fit is a property of the CAD.
//   radius — how far a reference reaches for its partners (partnerSearchRadius):
//            at least one element, so a coarse mesh still finds the three
//            partners an RBE3 needs.
// A "within distance" connection additionally keeps only the references within
// its search distance of the other surface, which is what limits the tie to the
// part of the surface that actually touches.
//
// Every connection gets a report, whether or not it coupled: a connection the
// user declared and that produced nothing is a missing load path, and the caller
// refuses it rather than solving a split assembly (KOF-203).
export function tieCouplings(
  ppt: (i: number) => Vec3,
  ties: PoolTie[],
  medEdge: number,
  maxCoupledNodes: number,
): { coupling: CouplingSet; reports: TieCouplingReport[] } {
  let all: CouplingSet = { ref: [], offsets: [0], solid: [] };
  const reports: TieCouplingReport[] = [];
  for (const tie of ties) {
    // Nodes the two surfaces share are already rigidly joined through the common
    // pool DOFs, and a coupling reference must not also be a partner.
    const refSet = new Set(tie.refs);
    const shared = new Set(tie.masters.filter((pi) => refSet.has(pi)));
    const masters = tie.masters.filter((pi) => !shared.has(pi));
    const refs = tie.refs.filter((pi) => !shared.has(pi));
    const base: TieCouplingReport = {
      name: tie.name,
      nCoupled: 0,
      nPartners: 0,
      nShared: shared.size,
      gap: 0,
    };
    const dropped = (drop: TieCouplingDrop, gap = 0): void => {
      reports.push({ ...base, gap, drop });
    };
    if (masters.length === 0 || refs.length === 0) {
      dropped({
        kind: "no-pool-nodes",
        side: masters.length === 0 ? (refs.length === 0 ? "both" : "A") : "B",
      });
      continue;
    }

    let distances = new Map<number, number>();
    let searched = 0;
    for (
      let reach = Math.max(2 * medEdge, 1e-9), doublings = 0;
      doublings <= 6 && distances.size === 0;
      reach *= 2, doublings++
    ) {
      searched = reach;
      distances = nearestMasterDistances(ppt, masters, refs, reach);
    }
    if (distances.size === 0) {
      dropped({ kind: "out-of-reach", searched });
      continue;
    }

    const gap = Math.min(...distances.values());
    const kept = [...distances]
      .filter(([, distance]) => distance <= tie.reach)
      .map(([pi]) => pi);
    if (kept.length === 0) {
      dropped({ kind: "beyond-search-distance", gap, reach: tie.reach }, gap);
      continue;
    }

    const radius = partnerSearchRadius(medEdge, gap);
    const one = autoDetectCouplings(
      ppt,
      masters,
      kept,
      radius,
      maxCoupledNodes,
    );
    if (one.ref.length === 0) {
      dropped({ kind: "too-few-partners", refs: kept.length, radius }, gap);
      continue;
    }
    all = concatCouplings(all, one);
    reports.push({
      ...base,
      gap,
      nCoupled: one.ref.length,
      nPartners: one.solid.length,
    });
  }
  return {
    coupling: { ref: all.ref, offsets: all.offsets, solid: all.solid },
    reports,
  };
}

// Map a connection's two picked surfaces from store vertex indices onto pool
// nodes. A vertex with no pool node is skipped: on the auto-shell path the thin
// walls a picked surface covered were replaced by mid-surface shell nodes, which
// the seam coupling already ties. A surface left with NO pool node is reported as
// a dropped tie rather than skipped silently — the seam ties that shell back to
// its own retained solid, not to the body on the other side of this connection.
export function tiesToPool(
  ties: TieSurfaces[],
  poolOfVertex: (vi: number) => number | undefined,
): PoolTie[] {
  const toPool = (vertices: number[]): number[] => {
    const out: number[] = [];
    for (const vi of vertices) {
      const pi = poolOfVertex(vi);
      if (pi !== undefined) out.push(pi);
    }
    return out;
  };
  return ties.map((tie) => ({
    name: tie.name,
    masters: toPool(tie.verticesA),
    refs: toPool(tie.verticesB),
    reach: tie.maxSeparation,
  }));
}
