// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { Load, SurfaceLoad } from "../store/boundaryRebuild.js";
import { tr } from "../i18n/useLocale.js";
import { boundaryChecksMessages } from "../i18n/messages/boundaryChecks.js";

type ShellNodalLoad = {
  force: [number, number, number];
  moment: [number, number, number];
};

// Work-equivalent nodal loads of one surface load on a shell mesh. The shell
// solver takes only nodal loads, so the traction integral f_i = ∫ N_i·t dS the
// solid engine evaluates over boundary elements must be computed here, with
// the linear translation shape functions of the facet's corners: a uniform
// traction contributes t·A/3 to each node of a facet, and a uniform line load
// q·L/2 to each end of an edge. The drilling part of the OPT membrane's
// boundary field would add small corner moments; Felippa (2003, Table 4)
// shows that lumping without them changes results in the fourth digit:
//   force on facets — uniform traction t = F/ΣA over the loaded region
//   force on edges  — uniform line load q = F/ΣL along the loaded edge
//   pressure        — -p·n̂·A/3 per facet node, n̂ the facet winding normal
//                     (a shell has no outward side; + pushes against n̂)
// The area each face of a surface load stands for, per unit of its own
// (SurfaceLoad.areaScales), one entry per face.
export function faceAreaScales(sl: SurfaceLoad): number[] {
  if (!sl.areaScales)
    // eslint-disable-next-line kofem/no-silent-fallback -- areaScales is optional by contract: absent means every face stands for its own area, which every load but a curved CAD shell face's is
    return sl.faces.map(() => 1);
  if (sl.areaScales.length !== sl.faces.length)
    throw new Error(
      `surface load: ${sl.areaScales.length} area scales for ${sl.faces.length} faces`,
    );
  return sl.areaScales;
}

export function distributeSurfaceLoad(
  sl: SurfaceLoad,
  posOf: (nodeId: number) => [number, number, number],
  at: (nodeId: number) => ShellNodalLoad,
): void {
  if (sl.faces.length === 0)
    throw new Error("surface load: selection contains no faces or edges");
  const scales = faceAreaScales(sl);
  const scaleOf = new Map(sl.faces.map((f, i) => [f, scales[i]]));
  const facets = sl.faces.filter((f) => f.length === 3);
  const edges = sl.faces.filter((f) => f.length === 2);
  if (facets.length + edges.length !== sl.faces.length)
    throw new Error(
      "surface load: a surface load carries a face that is neither a facet (3 nodes) nor an edge (2 nodes)",
    );

  // Area-weighted winding normal: |areaNormal| = A, direction from winding.
  const areaNormal = (f: number[]): [number, number, number] => {
    const [a, b, c] = [posOf(f[0]), posOf(f[1]), posOf(f[2])];
    const ab = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const ac = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    const scale = (scaleOf.get(f) as number) / 2;
    return [
      (ab[1] * ac[2] - ab[2] * ac[1]) * scale,
      (ab[2] * ac[0] - ab[0] * ac[2]) * scale,
      (ab[0] * ac[1] - ab[1] * ac[0]) * scale,
    ];
  };

  if (sl.type === "pressure") {
    if (sl.pressure === undefined)
      throw new Error("surface load: pressure load carries no magnitude");
    if (edges.length > 0)
      throw new Error(
        "surface load: a pressure load needs facets — it cannot act on an edge",
      );
    for (const f of facets) {
      const n = areaNormal(f);
      if (Math.hypot(...n) <= 0)
        throw new Error("surface load: pressure facet has zero area");
      for (const nodeId of f) {
        const acc = at(nodeId).force;
        for (let d = 0; d < 3; d++) acc[d] += (-sl.pressure * n[d]) / 3;
      }
    }
    return;
  }

  if (!sl.force)
    throw new Error(`surface load: ${sl.type} load carries no force vector`);
  if (sl.type === "traction" && edges.length > 0)
    throw new Error(
      "surface load: a traction (per-area) load cannot act on an edge",
    );
  // A group's total force is shared over the whole selection (rebuildSurfaceLoads),
  // and there is no physical rule for splitting one total between an area and a
  // length — the facet share would be arbitrary. Say so instead of distributing
  // over the facets and dropping the edge without a word.
  if (facets.length > 0 && edges.length > 0)
    throw new Error(
      "surface load: one load selects both faces and edges, and a single total force " +
        "has no meaningful split between a loaded area and a loaded edge — put the edge " +
        "selection in its own load group.",
    );

  if (facets.length > 0) {
    const areas = facets.map((f) => {
      const n = areaNormal(f);
      return Math.hypot(n[0], n[1], n[2]);
    });
    const totalArea = areas.reduce((s, a) => s + a, 0);
    if (totalArea <= 0)
      throw new Error("surface load: loaded facets have zero total area");
    for (let i = 0; i < facets.length; i++) {
      // force: share of the TOTAL vector ∝ area; traction: t·A/3 directly.
      const scale =
        sl.type === "force" ? areas[i] / (3 * totalArea) : areas[i] / 3;
      for (const nodeId of facets[i]) {
        const acc = at(nodeId).force;
        for (let d = 0; d < 3; d++) acc[d] += sl.force[d] * scale;
      }
    }
  } else if (edges.length > 0) {
    const lengths = edges.map((e) => {
      const [a, b] = [posOf(e[0]), posOf(e[1])];
      return Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
    });
    const totalLength = lengths.reduce((s, l) => s + l, 0);
    if (totalLength <= 0)
      throw new Error("surface load: loaded edges have zero total length");
    for (let i = 0; i < edges.length; i++) {
      const scale = lengths[i] / (2 * totalLength);
      for (const nodeId of edges[i]) {
        const acc = at(nodeId).force;
        for (let d = 0; d < 3; d++) acc[d] += sl.force[d] * scale;
      }
    }
  }
}

// Nodal loads for the surface load: direct loads (moment groups arrive here as
// equivalent nodal forces; DOFs 3–5 would be true nodal moments) merged with
// the work-equivalent distribution of every surface load.
export function shellPointLoads(
  loads: Load[],
  surfaceLoads: SurfaceLoad[] | undefined,
  posOf: (nodeId: number) => [number, number, number],
  vid: (nodeId: number, context: string) => number,
) {
  const acc = new Map<number, ShellNodalLoad>();
  const atVertex = (vertex: number): ShellNodalLoad => {
    let entry = acc.get(vertex);
    if (!entry) {
      entry = { force: [0, 0, 0], moment: [0, 0, 0] };
      acc.set(vertex, entry);
    }
    return entry;
  };
  for (const load of loads) {
    if (load.dof < 0 || load.dof > 5)
      throw new Error(
        `surface load: load on node ${load.nodeId} names DOF ${load.dof} — valid shell DOFs are 0..5`,
      );
    const entry = atVertex(vid(load.nodeId, "load"));
    if (load.dof <= 2) entry.force[load.dof] += load.value;
    else entry.moment[load.dof - 3] += load.value;
  }
  const atNode = (nodeId: number): ShellNodalLoad =>
    atVertex(vid(nodeId, "surface load face"));
  for (const sl of surfaceLoads ?? []) distributeSurfaceLoad(sl, posOf, atNode);

  return [...acc.entries()].map(([vertex, { force, moment }]) => ({
    vertex,
    ...(force.some((v) => v !== 0) ? { force } : {}),
    ...(moment.some((v) => v !== 0) ? { moment } : {}),
  }));
}

// Point + surface loads → equivalent nodal forces on the pool.
//
// A moment (DOF 3..5) is applied directly where the node has rotational DOFs to
// receive it: a shell node, or a coupling REFERENCE POINT. At a reference point
// that is the couple a surface-to-point coupling exists to carry: the point
// takes M, and the coupling spreads it over the gripped surface as the
// statically equivalent traction. A moment on a face reaches here already as a
// ring of nodal forces (momentToNodalForces); one left on a node without
// rotations (a solid node) has nowhere to act, so it is refused rather than
// dropped (KOF-411), as the solid path refuses it (groupPointLoads).
export function coupledLoads(
  loads: Load[],
  surfaceLoads: SurfaceLoad[] | undefined,
  poolOf: (nodeId: number) => number,
  hasRotations: (poolIndex: number) => boolean,
  posOf: (nodeId: number) => [number, number, number],
): { load_dofs: number[]; load_vals: number[] } {
  const load_dofs: number[] = [];
  const load_vals: number[] = [];
  for (const l of loads) {
    const pi = poolOf(l.nodeId);
    if (l.dof > 2 && !hasRotations(pi)) {
      if (l.value !== 0)
        throw new Error(
          tr(boundaryChecksMessages).momentOnSolidNode(
            l.nodeId,
            l.dof,
            l.value,
          ),
        );
      continue;
    }
    load_dofs.push(6 * pi + l.dof);
    load_vals.push(l.value);
  }
  const surfaceForces = new Map<number, ShellNodalLoad>();
  const atNode = (nodeId: number): ShellNodalLoad => {
    const pi = poolOf(nodeId);
    let entry = surfaceForces.get(pi);
    if (!entry) {
      entry = { force: [0, 0, 0], moment: [0, 0, 0] };
      surfaceForces.set(pi, entry);
    }
    return entry;
  };
  for (const sl of surfaceLoads ?? []) distributeSurfaceLoad(sl, posOf, atNode);
  for (const [pi, { force }] of surfaceForces) {
    for (let d = 0; d < 3; d++) {
      if (force[d] !== 0) {
        load_dofs.push(6 * pi + d);
        load_vals.push(force[d]);
      }
    }
  }
  return { load_dofs, load_vals };
}
