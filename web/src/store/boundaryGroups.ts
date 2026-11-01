// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// The named BC / load group model — the primary source of truth for supports
// and loads — and its pure helpers. No Zustand: the slices that own these
// groups (boundarySlice, tieSlice, couplingSlice) and the solver-array builders
// (boundaryRebuild) all read the same definitions from here.

import type { PickGeometry } from "../lib/facePick";

export interface BcFaceEntry {
  id: number;
  label: string; // e.g. "Face 1"
  nodeIds: number[];
  // What was picked. Only "point" changes how the solver applies the group: a
  // single node spans no element face, so a load on it cannot be integrated as
  // a traction and is applied at the node instead (rebuildLoads). Absent on
  // entries saved before point picking existed, which were faces or edges —
  // both integrable — so absence reads correctly as "not a point".
  geometry?: PickGeometry;
  // The CAD face this entry is, when it was picked as one whole CAD face (the
  // mesh's surfaceFaceIds numbering). It is what lets the entry outlive its
  // mesh: a re-mesh re-resolves `nodeIds` from this face of the new mesh
  // (lib/remeshGroups) instead of dropping the group. Absent on edge, node and
  // flood-fill picks, whose node sets mean nothing on another mesh.
  cadFaceId?: number;
}

export interface NamedBcGroup {
  id: number;
  name: string; // e.g. "BC1"
  dofs: number[];
  value: number;
  faces: BcFaceEntry[];
}

// A load group's physical kind. "force" and "pressure" are applied to the solver
// as work-equivalent surface tractions (SurfaceLoad); "moment" is still lumped to
// equivalent nodal forces (rebuildLoads). For backward-compat with saved analyses
// that predate this field, `kind` is optional and inferred from `dof` via
// loadKind().
export type LoadKind = "force" | "moment" | "pressure";

export interface NamedLoadGroup {
  id: number;
  name: string; // e.g. "Load1"
  dof: number; // force: 0=Fx,1=Fy,2=Fz · moment: 3=Mx,4=My,5=Mz · pressure: unused
  totalForce: number; // force/moment magnitude (N, N·mm), or pressure magnitude (MPa)
  // Componentwise force [Fx,Fy,Fz] (N) or moment [Mx,My,Mz] (N·mm) vector
  // (issues #219, #190). Present on force/moment groups created via the
  // componentwise UI, where it is the source of truth and supersedes
  // dof/totalForce. Absent on pressure groups and on payloads saved before
  // componentwise input existed — those reconstruct the vector from dof +
  // totalForce via loadComponents().
  components?: [number, number, number];
  faces: BcFaceEntry[];
  kind?: LoadKind;
}

// Physical kind of a load group, defaulting from `dof` for older payloads that
// have no explicit `kind` (dof ≤ 2 ⇒ force, dof ≥ 3 ⇒ moment).
export function loadKind(g: NamedLoadGroup): LoadKind {
  return g.kind ?? (g.dof <= 2 ? "force" : "moment");
}

// The force [Fx,Fy,Fz] (N) or moment [Mx,My,Mz] (N·mm) vector of a load group.
// Uses the explicit componentwise vector when present, else reconstructs the
// single-axis vector from the legacy dof + totalForce (force: axis 0–2; moment:
// axis dof−3). Pressure groups have no vector and return zeros.
export function loadComponents(g: NamedLoadGroup): [number, number, number] {
  if (g.components) return g.components;
  const vec: [number, number, number] = [0, 0, 0];
  const kind = loadKind(g);
  if (kind === "force" && g.dof >= 0 && g.dof <= 2) vec[g.dof] = g.totalForce;
  else if (kind === "moment" && g.dof >= 3 && g.dof <= 5)
    vec[g.dof - 3] = g.totalForce;
  return vec;
}

// Legacy single-axis summary (primary axis + signed magnitude) of a componentwise
// vector, stored alongside `components` so older readers and the pre-flight
// fallback still see a sensible dof/totalForce. For a single non-zero component
// this reproduces the vector exactly; for a general vector it names the first
// non-zero axis. `components` remains the source of truth.
export function summarizeComponents(
  components: [number, number, number],
  kind: LoadKind,
): { dof: number; totalForce: number } {
  const found = components.findIndex((value) => value !== 0);
  const axis = found < 0 ? 0 : found;
  return {
    dof: kind === "moment" ? axis + 3 : axis,
    totalForce: components[axis],
  };
}

// Mint a committed face entry from a picked one, taking the next id. Written
// once because every group type creates entries the same way, and a copy that
// forgets to carry a field — `geometry` is the one that matters, since it is
// what routes a load to its nodes rather than to a surface integral — fails
// only in the solve, far from here.
export function faceEntry(
  face: Omit<BcFaceEntry, "id">,
  nextId: () => number,
): BcFaceEntry {
  return { ...face, id: nextId() };
}
