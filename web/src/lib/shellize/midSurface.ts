// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Collapse the detected thin walls to Kirchhoff shell mid-surface facets, one
// thickness per wall, welded where walls meet.

import { getOrInit, pt, type ShellizeMesh, type Vec3 } from "./geometry.js";
import { detectWallPairs, faceProps, type Wall } from "./walls.js";

export interface ShellExtraction {
  walls: Wall[];
  shellBody: number;
  shellVerts: number[]; // 3·nShellNodes
  shellTris: number[]; // 3·nShellTris (local shell indices)
  shellThk: number[]; // per shell tri
  shellSrc: number[]; // source OCC face per shell node (one, for a welded fold node arbitrary)
  shellTriSrc: number[]; // source OCC face per shell TRI — unambiguous, so a BC on a
  // folded face reaches every node of its facets (fold nodes shared with a wall included)
}

// Where a node lies on ONE wall the mid-surface is that wall's face offset t/2
// along −n. A node on the CAD edge where two walls meet lies on both, and must
// land on the LINE where the two mid-planes cross (three walls ⇒ the corner
// point). Solving n_w·Δ = −t_w/2 for every wall w the node belongs to gives that
// point; the walls are applied in face order, each along the direction the
// earlier ones leave free, so every accepted constraint holds exactly.
//
// Offsetting along a single wall's normal instead leaves the node up to t/2 off
// the other wall's mid-plane. That is not just a cosmetic kink in the facets: it
// drags the mid-surface out of the wall it represents, so `shellWallTets` no
// longer finds those wall tets within t/2 of it and they survive the collapse as
// floating slivers of wall-thickness solid — debris that is drawn over the shell
// AND picked up as coupling partners, tying seam shell nodes to material with no
// load path. On the crane hook at 6 mm elements that left 17 fragments carrying
// 900+ of the model's 265 couplings' partner slots (KOF-191).
function midSurfaceOffset(
  wallsOfNode: Set<number>,
  keep: Map<number, Wall>,
): Vec3 {
  const delta: Vec3 = [0, 0, 0];
  const basis: Vec3[] = [];
  for (const fid of [...wallsOfNode].sort((a, b) => a - b)) {
    const wall = keep.get(fid);
    if (!wall)
      throw new Error(`mid-surface offset asked for unknown wall face ${fid}`);
    const residual: Vec3 = [wall.n[0], wall.n[1], wall.n[2]];
    for (const used of basis) {
      const proj =
        residual[0] * used[0] + residual[1] * used[1] + residual[2] * used[2];
      residual[0] -= proj * used[0];
      residual[1] -= proj * used[1];
      residual[2] -= proj * used[2];
    }
    const len = Math.hypot(residual[0], residual[1], residual[2]);
    // Nothing left to move along ⇒ this wall's mid-plane is (near) parallel to
    // one already enforced, so it is already satisfied to within t/2·sin(angle).
    if (len < 0.2) continue;
    const dir: Vec3 = [residual[0] / len, residual[1] / len, residual[2] / len];
    const along =
      wall.n[0] * delta[0] + wall.n[1] * delta[1] + wall.n[2] * delta[2];
    const step =
      (-wall.thk / 2 - along) /
      (wall.n[0] * dir[0] + wall.n[1] * dir[1] + wall.n[2] * dir[2]);
    delta[0] += step * dir[0];
    delta[1] += step * dir[1];
    delta[2] += step * dir[2];
    basis.push(dir);
  }
  return delta;
}

// Collapse the kept wall faces to mid-surface facets (offset to the mid-plane of
// every wall the node lies on) and weld mid-surface nodes that came from the SAME
// original mesh node. Where two walls meet at a CAD edge they share Netgen's edge
// nodes, so joining nodes by original id fuses the walls exactly — independent of
// mesh resolution (a spatial tolerance over-welds a fine mesh and under-welds a
// coarse one).
function collapseWallsToMidSurface(
  m: ShellizeMesh,
  walls: Wall[],
): Pick<
  ShellExtraction,
  "shellVerts" | "shellTris" | "shellThk" | "shellSrc" | "shellTriSrc"
> {
  const keep = new Map(walls.map((w) => [w.keep, w]));

  // Every kept wall each node lies on — a junction node belongs to more than one.
  const wallsOfNode = new Map<number, Set<number>>();
  for (let t = 0; t < m.surfFace.length; t++) {
    if (!keep.has(m.surfFace[t])) continue;
    for (let k = 0; k < 3; k++)
      getOrInit(wallsOfNode, m.surfTri[3 * t + k], () => new Set<number>()).add(
        m.surfFace[t],
      );
  }

  const rawV: number[] = [],
    rawT: number[] = [],
    rawThk: number[] = [],
    rawTriSrc: number[] = [],
    rawSrc: number[] = [],
    rawOrig: number[] = [];
  const nm = new Map<string, number>();
  const addN = (fid: number, oi: number, p: Vec3) => {
    const key = `${fid}:${oi}`;
    let id = nm.get(key);
    if (id !== undefined) return id;
    id = rawV.length / 3;
    nm.set(key, id);
    rawV.push(p[0], p[1], p[2]);
    rawSrc.push(fid);
    rawOrig.push(oi);
    return id;
  };
  const offsetOfNode = new Map<number, Vec3>();
  for (const [oi, nodeWalls] of wallsOfNode)
    offsetOfNode.set(oi, midSurfaceOffset(nodeWalls, keep));
  for (let t = 0; t < m.surfFace.length; t++) {
    const wall = keep.get(m.surfFace[t]);
    if (!wall) continue;
    const nn = [
      m.surfTri[3 * t],
      m.surfTri[3 * t + 1],
      m.surfTri[3 * t + 2],
    ].map((oi) => {
      const pos = pt(m.V, oi);
      const delta = offsetOfNode.get(oi);
      if (!delta)
        throw new Error(
          `mid-surface offset missing for mesh node ${oi} on wall face ${wall.keep}`,
        );
      return addN(wall.keep, oi, [
        pos[0] + delta[0],
        pos[1] + delta[1],
        pos[2] + delta[2],
      ]);
    });
    rawT.push(nn[0], nn[1], nn[2]);
    rawThk.push(wall.thk);
    rawTriSrc.push(wall.keep);
  }

  const nR = rawV.length / 3;
  const rep = new Int32Array(nR).map((_, i) => i);
  const find = (x: number): number => {
    while (rep[x] !== x) {
      rep[x] = rep[rep[x]];
      x = rep[x];
    }
    return x;
  };
  const byOrig = new Map<number, number[]>();
  for (let i = 0; i < nR; i++) getOrInit(byOrig, rawOrig[i], () => []).push(i);
  for (const [, group] of byOrig)
    for (let k = 1; k < group.length; k++) {
      const rootA = find(group[0]),
        rootB = find(group[k]);
      if (rootA !== rootB) rep[Math.max(rootA, rootB)] = Math.min(rootA, rootB);
    }
  const comp = new Map<number, number>();
  const shellVerts: number[] = [],
    shellSrc: number[] = [];
  const cid = (i: number) => {
    const root = find(i);
    let compact = comp.get(root);
    if (compact === undefined) {
      compact = shellVerts.length / 3;
      comp.set(root, compact);
      shellVerts.push(rawV[3 * root], rawV[3 * root + 1], rawV[3 * root + 2]);
      shellSrc.push(rawSrc[root]);
    }
    return compact;
  };
  const shellTris: number[] = [],
    shellThk: number[] = [],
    shellTriSrc: number[] = [];
  for (let t = 0; t < rawT.length / 3; t++) {
    const triA = cid(rawT[3 * t]),
      triB = cid(rawT[3 * t + 1]),
      triC = cid(rawT[3 * t + 2]);
    if (triA === triB || triB === triC || triA === triC) continue;
    shellTris.push(triA, triB, triC);
    shellThk.push(rawThk[t]);
    shellTriSrc.push(rawTriSrc[t]);
  }
  return { shellVerts, shellTris, shellThk, shellSrc, shellTriSrc };
}

// Detect thin walls (opposite planar CAD-face pairs) and collapse each to a
// mid-surface facet with its wall thickness; weld walls at their junctions.
// Returns an empty extraction (shellBody = -1) when no thin walls are found, so
// the caller can fall back to the all-solid solve.
// `shellBodyIds` names the bodies to idealise as shells (the app passes the
// per-body Shell/Solid choice; the showcase generator omits it to let the largest
// thin-walled body be picked automatically). Only ONE body is shelled per solve —
// the coupled solver takes a single shell material (#376) — so among the requested
// bodies the one with the largest thin wall is used.
export function extractThinWallShells(
  m: ShellizeMesh,
  {
    maxWall = 15,
    shellBodyIds,
  }: { maxWall?: number; shellBodyIds?: Set<number> } = {},
): ShellExtraction {
  const empty: ShellExtraction = {
    walls: [],
    shellBody: -1,
    shellVerts: [],
    shellTris: [],
    shellThk: [],
    shellSrc: [],
    shellTriSrc: [],
  };
  if (shellBodyIds && shellBodyIds.size === 0) return empty; // user chose all-solid
  const faces = faceProps(m);
  if (faces.length === 0) return empty;
  const allWalls = detectWallPairs(faces, maxWall).filter(
    (w) => !shellBodyIds || shellBodyIds.has(w.body),
  );
  if (allWalls.length === 0) return empty;
  // Shell exactly ONE body — the one carrying the largest thin wall. detectWallPairs
  // matches opposite faces on any body, so a thick flat block elsewhere can also
  // pair up; collapsing such a wall would lay shell facets on top of a body that
  // stays solid (double representation), corrupting the coupling. The crane hook
  // picked up a stray 5 mm "wall" on the solid hook this way — 569 shell triangles
  // glued onto solid tets. Keep only walls on the shelled body.
  const shellBody = allWalls[0].body;
  const walls = allWalls.filter((w) => w.body === shellBody);
  return {
    walls,
    shellBody,
    ...collapseWallsToMidSurface(m, walls),
  };
}
