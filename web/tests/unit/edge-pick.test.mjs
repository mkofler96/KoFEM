// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Unit test for the edge-picking algorithm (#386).
//
// A flat shell sheet is one face-pick region, so grabbing its rim needs edge
// picking. These tests verify:
//   - boundary edges are the mesh edges used by exactly one facet
//   - clicking near a straight rim selects that whole side and stops at corners
//   - clicking an interior triangle falls back to the nearest rim edge
//   - clicking a smoothly-tessellated closed loop selects the whole loop

import { describe, expect, test } from "bun:test";
import {
  boundaryEdgesWithin,
  buildBoundaryMeshTopo,
  extractBoundaryEdges,
  pickEdgeNodeIds,
  pickFaceNodeIds,
} from "../../src/lib/facePick.ts";
import {
  plateWithHoleShellMesh,
  nodesWhere,
} from "../../../examples/validation/lib/mesh.mjs";

// ── Grid-plate mesh ─────────────────────────────────────────────────────────
//
// NX×NY quad grid split into two triangles per cell, lying flat in z = 0.
// Node id = row*(NX+1) + col at position (col, row, 0). The boundary is the
// outer rectangle: bottom (row=0), top (row=NY), left (col=0), right (col=NX).

const NX = 4;
const NY = 3;
const nid = (col, row) => row * (NX + 1) + col;

const gridPos = [];
for (let row = 0; row <= NY; row++) {
  for (let col = 0; col <= NX; col++) gridPos[nid(col, row)] = [col, row, 0];
}

// Triangle order: cells in (row outer, col inner), triangle A then B per cell.
// triIdx(cell A) = 2*(row*NX + col), triIdx(cell B) = 2*(row*NX + col) + 1.
const gridTris = [];
for (let row = 0; row < NY; row++) {
  for (let col = 0; col < NX; col++) {
    const v00 = nid(col, row),
      v10 = nid(col + 1, row),
      v01 = nid(col, row + 1),
      v11 = nid(col + 1, row + 1);
    gridTris.push([v00, v10, v11]); // A
    gridTris.push([v00, v11, v01]); // B
  }
}
const triA = (col, row) => 2 * (row * NX + col);
const gridGetPos = (nodeId) => gridPos[nodeId];
const gridTopo = buildBoundaryMeshTopo(gridTris, gridGetPos);

// Click the midpoint of the bottom edge of cell (2,0) — triangle A.
const bottomExpected = new Set([
  nid(0, 0),
  nid(1, 0),
  nid(2, 0),
  nid(3, 0),
  nid(4, 0),
]);

// ── Boundary-edge extraction (used-once) ─────────────────────────────────────

describe("boundary edges = edges used by exactly one facet", () => {
  const gridBoundary = extractBoundaryEdges(gridTopo);

  test("boundary-edge count matches the rectangle perimeter", () => {
    // Rectangle perimeter: NX bottom + NX top + NY left + NY right segments.
    expect(gridBoundary).toHaveLength(2 * NX + 2 * NY);
  });

  test("interior node is not on any boundary edge", () => {
    const gridBoundaryNodes = new Set(gridBoundary.flat());
    // Interior nodes (not on any rim) must not appear in any boundary edge.
    expect(gridBoundaryNodes.has(nid(2, 1))).toBe(false);
  });
});

// ── Straight rim pick stops at corners ───────────────────────────────────────

describe("clicking a straight rim selects that side only", () => {
  test("bottom rim: exactly the bottom row selected", () => {
    const bottomPick = pickEdgeNodeIds(
      [2.5, 0, 0],
      triA(2, 0),
      gridTopo,
      gridGetPos,
    );
    expect(bottomPick).toEqual(bottomExpected);
  });

  test("bottom rim: does not turn up a side (no left/right-only node)", () => {
    const bottomPick = pickEdgeNodeIds(
      [2.5, 0, 0],
      triA(2, 0),
      gridTopo,
      gridGetPos,
    );
    expect(bottomPick.has(nid(0, 1))).toBe(false);
    expect(bottomPick.has(nid(4, 1))).toBe(false);
  });

  // Click the left edge (cell (0,1) triangle B carries the left rim segment).
  test("left rim: exactly the left column selected", () => {
    const leftExpected = new Set([nid(0, 0), nid(0, 1), nid(0, 2), nid(0, 3)]);
    const leftPick = pickEdgeNodeIds(
      [0, 1.5, 0],
      triA(0, 1) + 1, // triangle B of cell (0,1)
      gridTopo,
      gridGetPos,
    );
    expect(leftPick).toEqual(leftExpected);
  });
});

// ── Interior click falls back to the nearest rim ─────────────────────────────

describe("interior-triangle click falls back to nearest rim edge", () => {
  // Cell (2,1) is fully interior (no boundary edge); a click near the bottom rim
  // should still grab the bottom row via the global nearest-edge fallback.
  test("interior click near bottom selects the bottom row", () => {
    const fallbackPick = pickEdgeNodeIds(
      [2.5, 0, 0],
      triA(2, 1),
      gridTopo,
      gridGetPos,
    );
    expect(fallbackPick).toEqual(bottomExpected);
  });
});

// ── Fan mesh (closed smooth loop) ────────────────────────────────────────────
//
// A center node fanned out to N rim nodes on a circle. Every rim edge is used
// by one triangle (boundary); every spoke is shared by two (interior). The rim
// is a regular N-gon whose per-vertex turn (360/N) is below EDGE_TURN_LIMIT for
// N = 16, so one click should walk the whole loop.

describe("smooth closed loop selects the whole rim", () => {
  const SEGS = 16;
  const RADIUS = 10;
  const fanPos = [[0, 0, 0]];
  for (let index = 0; index < SEGS; index++) {
    const theta = (2 * Math.PI * index) / SEGS;
    fanPos.push([RADIUS * Math.cos(theta), RADIUS * Math.sin(theta), 0]);
  }
  const fanTris = [];
  for (let index = 0; index < SEGS; index++) {
    fanTris.push([0, 1 + index, 1 + ((index + 1) % SEGS)]);
  }
  const fanGetPos = (nodeId) => fanPos[nodeId];
  const fanTopo = buildBoundaryMeshTopo(fanTris, fanGetPos);

  test("fan: boundary edge count equals rim segment count", () => {
    expect(extractBoundaryEdges(fanTopo)).toHaveLength(SEGS);
  });

  // Click the rim segment carried by triangle 0 ([0, 1, 2]) — midpoint of nodes 1,2.
  const mid = [
    (fanPos[1][0] + fanPos[2][0]) / 2,
    (fanPos[1][1] + fanPos[2][1]) / 2,
    0,
  ];

  test("fan: all rim nodes selected", () => {
    const rimExpected = new Set();
    for (let index = 1; index <= SEGS; index++) rimExpected.add(index);
    expect(pickEdgeNodeIds(mid, 0, fanTopo, fanGetPos)).toEqual(rimExpected);
  });

  test("fan: center node not selected", () => {
    expect(pickEdgeNodeIds(mid, 0, fanTopo, fanGetPos).has(0)).toBe(false);
  });
});

// ── Closed solid boundary has no pickable edges ──────────────────────────────

describe("closed manifold surface yields no boundary edges", () => {
  // A tetrahedron's surface is closed — every edge is shared by two facets.
  const tetPos = [
    [0, 0, 0],
    [1, 0, 0],
    [0, 1, 0],
    [0, 0, 1],
  ];
  const tetTris = [
    [0, 1, 2],
    [0, 1, 3],
    [0, 2, 3],
    [1, 2, 3],
  ];
  const tetTopo = buildBoundaryMeshTopo(tetTris, (nodeId) => tetPos[nodeId]);

  test("closed surface: no boundary edges", () => {
    expect(extractBoundaryEdges(tetTopo)).toHaveLength(0);
  });

  test("closed surface: edge pick returns empty", () => {
    expect(
      pickEdgeNodeIds([0.5, 0.5, 0], 0, tetTopo, (nodeId) => tetPos[nodeId])
        .size,
    ).toBe(0);
  });
});

// ── The real plate-with-hole shell mesh (#386 target case) ───────────────────
//
// The structured shell mesh the plate-with-hole-shell example used to ship: an
// annulus from the hole rim out to a square outer boundary. It reproduces the
// motivating problem — a flat shell is one face-pick region — and proves edge
// picking grabs the rim (the pulled right edge) instead of the whole plate.

describe("real plate-with-hole shell mesh", () => {
  const HOLE_R = 1000;
  const HALF_W = 10000;
  const NTH = 64;
  const shell = plateWithHoleShellMesh(HOLE_R, HALF_W, 12, NTH, 2);
  const shellGetPos = (nodeId) => shell.vertices[nodeId];
  const shellTopo = buildBoundaryMeshTopo(shell.triangles, shellGetPos);
  const shellBoundary = extractBoundaryEdges(shellTopo);

  const midOf = (edge) => [
    (shellGetPos(edge[0])[0] + shellGetPos(edge[1])[0]) / 2,
    (shellGetPos(edge[0])[1] + shellGetPos(edge[1])[1]) / 2,
    0,
  ];
  const ownerTri = (edge) =>
    shellTopo.edgeToTris.get(
      edge[0] < edge[1] ? `${edge[0]},${edge[1]}` : `${edge[1]},${edge[0]}`,
    )[0];

  // Click the outer right edge near y = 0 — the pulled edge of the saved analysis.
  const rightEdges = shellBoundary.filter(
    (edge) =>
      shellGetPos(edge[0])[0] >= HALF_W - 1e-6 &&
      shellGetPos(edge[1])[0] >= HALF_W - 1e-6,
  );
  const rightSeed = rightEdges.reduce((best, edge) =>
    Math.abs(midOf(edge)[1]) < Math.abs(midOf(best)[1]) ? edge : best,
  );
  const rightPick = pickEdgeNodeIds(
    midOf(rightSeed),
    ownerTri(rightSeed),
    shellTopo,
    shellGetPos,
  );

  test("boundary loops are the hole rim + outer square", () => {
    // Boundary = inner hole rim + outer square, NTH segments each.
    expect(shellBoundary).toHaveLength(2 * NTH);
  });

  // Face picking a flat plate flood-fills the whole sheet — the exact problem
  // edge picking exists to work around.
  test("face pick selects the whole flat plate", () => {
    const wholePlate = pickFaceNodeIds(0, shellTopo);
    expect(wholePlate.size).toBe(shell.vertices.length);
  });

  test("edge pick reproduces the generator's pulled right edge", () => {
    // The generator defines the pulled edge as exactly the nodes at x = +b.
    const pulledEdge = new Set(
      nodesWhere(shell.vertices, (xCoord) => xCoord >= HALF_W - 1e-6),
    );
    expect(rightPick).toEqual(pulledEdge);
  });

  test("the pulled edge is a small fraction of the plate", () => {
    expect(rightPick.size).toBeGreaterThan(2);
    expect(rightPick.size).toBeLessThan(shell.vertices.length * 0.1);
  });

  // Click a hole-rim segment — the smooth loop is walked whole.
  test("edge pick walks the whole hole rim", () => {
    const rimEdges = shellBoundary.filter((edge) => {
      const radius0 = Math.hypot(
        shellGetPos(edge[0])[0],
        shellGetPos(edge[0])[1],
      );
      const radius1 = Math.hypot(
        shellGetPos(edge[1])[0],
        shellGetPos(edge[1])[1],
      );
      return (
        Math.abs(radius0 - HOLE_R) < 1e-6 && Math.abs(radius1 - HOLE_R) < 1e-6
      );
    });
    const holeRimPick = pickEdgeNodeIds(
      midOf(rimEdges[0]),
      ownerTri(rimEdges[0]),
      shellTopo,
      shellGetPos,
    );
    const holeRim = new Set(
      nodesWhere(
        shell.vertices,
        (xCoord, yCoord) =>
          Math.abs(Math.hypot(xCoord, yCoord) - HOLE_R) < 1e-6,
      ),
    );
    expect(holeRimPick).toEqual(holeRim);
  });
});

// ── Edge highlight segments (KOF-356) ───────────────────────────────────────
//
// A picked edge is a node set on the rim, which spans no triangle, so the face
// overlay draws nothing for it. The viewport draws it as a line instead: the
// boundary edges whose two nodes are both in the picked set.

describe("edge highlight segments", () => {
  test("a picked bottom rim draws exactly its rim segments", () => {
    const segments = boundaryEdgesWithin([...bottomExpected], gridTopo);
    expect(segments).toHaveLength(NX);
    for (const [a, b] of segments) {
      expect(bottomExpected.has(a) && bottomExpected.has(b)).toBe(true);
    }
  });

  test("an interior edge between two picked nodes is not drawn", () => {
    // nid(0,0)–nid(1,1) is an interior diagonal; nid(0,0)–nid(1,0) is rim.
    const segments = boundaryEdgesWithin(
      [nid(0, 0), nid(1, 0), nid(1, 1)],
      gridTopo,
    );
    expect(segments).toEqual([[nid(0, 0), nid(1, 0)]]);
  });

  test("a node set with no rim edge draws nothing", () => {
    expect(boundaryEdgesWithin([nid(2, 1)], gridTopo)).toEqual([]);
  });
});
