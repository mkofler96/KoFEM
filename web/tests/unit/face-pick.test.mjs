// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Unit test for the face-picking algorithm.
//
// Geometry: a hollow tube with inner radius 5, outer radius 10, height 20.
// 8 circumferential segments, 1 height segment.
// The test verifies that clicking one triangle on the inner mantle surface
// selects ALL inner mantle triangles — and no triangles from the outer mantle
// or the end caps.

import { describe, expect, test } from "bun:test";
import {
  buildBoundaryMeshTopo,
  mapTrianglesToCadFaces,
  pickFaceNodeIds,
  pickPointNodeId,
  nearestReferencePoint,
  toggleFaceSelection,
} from "../../src/lib/facePick.ts";

// ── Geometry helpers ─────────────────────────────────────────────────────────

function ringVerts(radius, height, count) {
  const ring = [];
  for (let index = 0; index < count; index++) {
    const theta = (2 * Math.PI * index) / count;
    ring.push([radius * Math.cos(theta), radius * Math.sin(theta), height]);
  }
  return ring;
}

// Build a pair of triangles (a quad) from 4 vertex indices: bottom-left,
// bottom-right, top-right, top-left (CCW from outside).
function quad(first, second, third, fourth) {
  return [
    [first, second, third],
    [first, third, fourth],
  ];
}

// ── Tube mesh ─────────────────────────────────────────────────────────────────
//
// 4 named faces:
//   faceId 1 — inner mantle  (normal points inward, toward axis)
//   faceId 2 — outer mantle  (normal points outward, away from axis)
//   faceId 3 — top cap       (normal points up, +z)
//   faceId 4 — bottom cap    (normal points down, -z)

const SEGS = 8; // circumferential segments
const INNER_RADIUS = 5;
const OUTER_RADIUS = 10;
const HEIGHT = 20; // height

// Vertex layout (32 vertices total):
//   0..SEGS-1          inner bottom ring
//   SEGS..2*SEGS-1     inner top ring
//   2*SEGS..3*SEGS-1   outer bottom ring
//   3*SEGS..4*SEGS-1   outer top ring

const verts = [
  ...ringVerts(INNER_RADIUS, 0, SEGS), // inner bottom
  ...ringVerts(INNER_RADIUS, HEIGHT, SEGS), // inner top
  ...ringVerts(OUTER_RADIUS, 0, SEGS), // outer bottom
  ...ringVerts(OUTER_RADIUS, HEIGHT, SEGS), // outer top
];

const triangles = [];
const faceIds = [];

// Inner mantle — quads go ccw when viewed from OUTSIDE the tube (which is
// inside the tube opening, so normals point toward the axis = inward).
for (let index = 0; index < SEGS; index++) {
  const next = (index + 1) % SEGS;
  // inner bottom[index], inner bottom[next], inner top[next], inner top[index]
  const tris = quad(index, next, SEGS + next, SEGS + index);
  for (const triangle of tris) {
    triangles.push(triangle);
    faceIds.push(1);
  }
}

// Outer mantle — normals point outward.
for (let index = 0; index < SEGS; index++) {
  const next = (index + 1) % SEGS;
  // outer bottom[index], outer top[index], outer top[next], outer bottom[next]
  const tris = quad(
    2 * SEGS + index,
    3 * SEGS + index,
    3 * SEGS + next,
    2 * SEGS + next,
  );
  for (const triangle of tris) {
    triangles.push(triangle);
    faceIds.push(2);
  }
}

// Top cap — connects inner top ring to outer top ring. Normals point up.
for (let index = 0; index < SEGS; index++) {
  const next = (index + 1) % SEGS;
  // inner top[index], outer top[index], outer top[next], inner top[next]
  const tris = quad(
    SEGS + index,
    3 * SEGS + index,
    3 * SEGS + next,
    SEGS + next,
  );
  for (const triangle of tris) {
    triangles.push(triangle);
    faceIds.push(3);
  }
}

// Bottom cap — connects inner bottom ring to outer bottom ring. Normals point down.
for (let index = 0; index < SEGS; index++) {
  const next = (index + 1) % SEGS;
  // inner bottom[index], inner bottom[next], outer bottom[next], outer bottom[index]
  const tris = quad(index, next, 2 * SEGS + next, 2 * SEGS + index);
  for (const triangle of tris) {
    triangles.push(triangle);
    faceIds.push(4);
  }
}

const getPos = (nodeId) => verts[nodeId];

// Which triangle indices belong to each face?
const innerTriIndices = faceIds
  .map((faceId, index) => (faceId === 1 ? index : -1))
  .filter((index) => index >= 0);
const outerTriIndices = faceIds
  .map((faceId, index) => (faceId === 2 ? index : -1))
  .filter((index) => index >= 0);
const topTriIndices = faceIds
  .map((faceId, index) => (faceId === 3 ? index : -1))
  .filter((index) => index >= 0);

// Which node IDs belong to the inner surface (exclusively)?
const innerNodeIds = new Set();
for (const triIndex of innerTriIndices) {
  for (const nodeId of triangles[triIndex]) innerNodeIds.add(nodeId);
}

// ── Test 1: CAD face ID mode ──────────────────────────────────────────────────

describe("CAD face ID mode", () => {
  const topoWithIds = buildBoundaryMeshTopo(triangles, getPos, faceIds);

  test("clicking an inner triangle selects exactly the inner surface nodes", () => {
    const seedIdx = innerTriIndices[0]; // click the first inner-surface triangle
    const pickedNodeIds = pickFaceNodeIds(seedIdx, topoWithIds);

    // Expected: exactly the inner surface node IDs
    expect(pickedNodeIds.size).toBe(innerNodeIds.size);
    expect(pickedNodeIds).toEqual(innerNodeIds);

    // Sanity: no outer-surface-only or cap-only nodes accidentally included
    const outerNodeIds = new Set();
    for (const triIndex of outerTriIndices)
      for (const nodeId of triangles[triIndex]) outerNodeIds.add(nodeId);
    const outerOnlyNodes = [...outerNodeIds].filter(
      (nodeId) => !innerNodeIds.has(nodeId),
    );
    for (const nodeId of outerOnlyNodes) {
      expect(pickedNodeIds.has(nodeId), `outer-only node ${nodeId}`).toBe(
        false,
      );
    }
  });

  // Clicking a different face picks that face.
  test("clicking an outer triangle selects exactly the outer surface nodes", () => {
    const pickedOuter = pickFaceNodeIds(outerTriIndices[0], topoWithIds);
    const outerNodeIdsFull = new Set();
    for (const triIndex of outerTriIndices)
      for (const nodeId of triangles[triIndex]) outerNodeIdsFull.add(nodeId);

    expect(pickedOuter).toEqual(outerNodeIdsFull);
    const leakedInner = [...innerNodeIds]
      .filter((nodeId) => !outerNodeIdsFull.has(nodeId))
      .filter((nodeId) => pickedOuter.has(nodeId));
    expect(leakedInner).toEqual([]);
  });
});

// ── BFS mode WITHOUT face IDs (bug-fix regression) ───────────────────────────

describe("BFS mode without face IDs", () => {
  const topoNoIds = buildBoundaryMeshTopo(triangles, getPos);

  // The BFS should select exactly the inner surface nodes.
  // Before the bug fix (isFlat = flatCount >= curvedCount), 2 axial neighbours
  // would outvote 1 circumferential neighbour, classifying the seed as "flat".
  // The tight 15° threshold would then prevent traversal around the cylinder.
  test("the inner cylinder surface is reached in full", () => {
    const pickedBFS = pickFaceNodeIds(
      innerTriIndices[Math.floor(SEGS / 2)],
      topoNoIds,
    );
    expect(pickedBFS.size).toBe(innerNodeIds.size);
    expect(pickedBFS).toEqual(innerNodeIds);
  });

  // Click a top-cap triangle — should select only top-cap nodes.
  // The cap is a flat annular ring, all normals pointing +z.
  // The BFS should stay on the cap and not bleed onto the cylindrical mantles.
  // Note: caps share corner nodes with mantles, so "only cap nodes" is too strict —
  // we just verify the selection doesn't include purely inner-mantle-exclusive nodes.
  test("the top cap does not bleed onto inner mantle nodes", () => {
    const topCapNodeIds = new Set();
    for (const triIndex of topTriIndices)
      for (const nodeId of triangles[triIndex]) topCapNodeIds.add(nodeId);

    const pickedTop = pickFaceNodeIds(topTriIndices[0], topoNoIds);
    const innerOnlyNodes = [...innerNodeIds].filter(
      (nodeId) => !topCapNodeIds.has(nodeId),
    );
    for (const nodeId of innerOnlyNodes) {
      expect(pickedTop.has(nodeId), `inner-only node ${nodeId}`).toBe(false);
    }
  });
});

// ── toggleFaceSelection adds, toggles off, and relabels (#264) ───────────────

describe("toggleFaceSelection (#264)", () => {
  const faceA = { nodeIds: [1, 2, 3], axis: "X", isMax: true, label: "" };
  const faceB = { nodeIds: [4, 5, 6], axis: "Y", isMax: false, label: "" };

  test("picks accumulate, toggle off and relabel by position", () => {
    // Picking two distinct faces accumulates both.
    let selection = toggleFaceSelection([], faceA);
    selection = toggleFaceSelection(selection, faceB);
    expect(selection).toHaveLength(2);
    expect(selection[0].label).toBe("Face 1 (3 nodes)");
    expect(selection[1].label).toBe("Face 2 (3 nodes)");

    // Re-picking the first face (same node set, any node order) removes it.
    const faceAReordered = {
      nodeIds: [3, 1, 2],
      axis: "X",
      isMax: true,
      label: "",
    };
    selection = toggleFaceSelection(selection, faceAReordered);
    expect(selection).toHaveLength(1);
    expect(new Set(selection[0].nodeIds)).toEqual(new Set(faceB.nodeIds));
    expect(selection[0].label).toBe("Face 1 (3 nodes)");

    // Toggling the last remaining face off empties the selection.
    selection = toggleFaceSelection(selection, faceB);
    expect(selection).toHaveLength(0);
  });
});

// ── Partial CAD-face coverage (crane-hook whole-body pick) ───────────────────
//
// Face-id coverage is normally PARTIAL: a mesh-time auto-shell model carries
// mid-surface facets that were never on the CAD boundary, and hiding a body
// exposes internal faces that were never surface elements. The mapping used to
// be all-or-nothing — one unmapped triangle dropped CAD picking for the WHOLE
// model, leaving the 89° curved flood fill to walk a swept body end to end. On
// a freshly meshed crane hook (270 of 7636 boundary triangles unmapped) one
// click then selected 2832 of 4438 nodes: "it keeps selecting the whole hook".

describe("partial CAD-face coverage", () => {
  // Netgen's surface elements, minus two triangles on different faces — the
  // stand-in for facets with no CAD face behind them.
  const holeInner = innerTriIndices[0];
  const holeOuter = outerTriIndices[0];
  const surfaceTriangles = [];
  const surfaceFaceIds = [];
  for (let index = 0; index < triangles.length; index++) {
    if (index === holeInner || index === holeOuter) continue;
    surfaceTriangles.push(triangles[index]);
    surfaceFaceIds.push(faceIds[index]);
  }

  const mapped = mapTrianglesToCadFaces(
    triangles,
    surfaceTriangles,
    surfaceFaceIds,
  );
  const sparseTopo = buildBoundaryMeshTopo(triangles, getPos, mapped);

  test("partial coverage still yields a face-id map", () => {
    expect(mapped).toBeDefined();
  });

  test("the unmapped triangles are the only holes in it", () => {
    expect(mapped.filter((faceId) => faceId === undefined)).toHaveLength(2);
  });

  test("every other triangle keeps its CAD face id", () => {
    mapped.forEach((faceId, index) => {
      if (index === holeInner || index === holeOuter) {
        expect(faceId, `triangle ${index}`).toBeUndefined();
      } else {
        expect(faceId, `triangle ${index}`).toBe(faceIds[index]);
      }
    });
  });

  test("surface data from a different mesh yields no map at all", () => {
    expect(
      mapTrianglesToCadFaces(triangles, [[9001, 9002, 9003]], [1]),
    ).toBeUndefined();
  });

  // A triangle that still has a CAD face picks that face exactly, holes or no.
  test("a mapped triangle still selects its CAD face exactly", () => {
    const neighbourPick = pickFaceNodeIds(innerTriIndices[1], sparseTopo);
    const innerMinusHole = new Set();
    for (const triIndex of innerTriIndices)
      if (triIndex !== holeInner)
        for (const nodeId of triangles[triIndex]) innerMinusHole.add(nodeId);
    expect(neighbourPick).toEqual(innerMinusHole);
  });

  // An unmapped triangle floods, but cannot spill into triangles that DO have a
  // CAD face — so it selects itself, and never joins the unmapped triangle on the
  // far side of the tube (which is what matching "everything with no id" did).
  test("an unmapped triangle floods only within its own unmapped patch", () => {
    const holePick = pickFaceNodeIds(holeInner, sparseTopo);
    expect(holePick).toEqual(new Set(triangles[holeInner]));
  });

  test("an unmapped triangle does not reach the unmapped triangle on the outer mantle", () => {
    const holePick = pickFaceNodeIds(holeInner, sparseTopo);
    for (const nodeId of triangles[holeOuter]) {
      expect(holePick.has(nodeId), `outer hole node ${nodeId}`).toBe(false);
    }
  });
});

// ── Point picking ─────────────────────────────────────────────────────────────
//
// A point pick selects ONE node: the corner of the clicked facet nearest the
// click. The candidates are restricted to that facet on purpose — a global
// nearest-node search would happily return a node on the far side of the model
// that projects closer in space, and the user would have selected something they
// cannot see.

describe("point picking", () => {
  const topoWithIds = buildBoundaryMeshTopo(triangles, getPos, faceIds);
  const pointTri = innerTriIndices[0];
  const [cornerA, cornerB, cornerC] = triangles[pointTri];

  // Click exactly on one corner: that corner is the pick.
  test.each([
    ["first", cornerA],
    ["second", cornerB],
    ["third", cornerC],
  ])("a click on the %s corner picks that node", (_label, corner) => {
    const picked = pickPointNodeId(
      getPos(corner),
      pointTri,
      topoWithIds,
      getPos,
    );
    expect(picked, `a click on node ${corner}`).toEqual(new Set([corner]));
  });

  // Click just off a corner, still inside the facet: the same corner wins.
  test("a click 20 % along an edge picks the nearer end", () => {
    const posA = getPos(cornerA);
    const posB = getPos(cornerB);
    const nearA = [
      posA[0] + 0.2 * (posB[0] - posA[0]),
      posA[1] + 0.2 * (posB[1] - posA[1]),
      posA[2] + 0.2 * (posB[2] - posA[2]),
    ];
    expect(pickPointNodeId(nearA, pointTri, topoWithIds, getPos)).toEqual(
      new Set([cornerA]),
    );
  });

  // Every pick is a single node, whatever the click — the invariant the load path
  // depends on (a one-node selection spans no element face, so its load is
  // applied at the node rather than integrated).
  test("a click at the facet centroid still picks exactly one node", () => {
    const centroid = [0, 1, 2].map(
      (axis) =>
        (getPos(cornerA)[axis] +
          getPos(cornerB)[axis] +
          getPos(cornerC)[axis]) /
        3,
    );
    expect(pickPointNodeId(centroid, pointTri, topoWithIds, getPos).size).toBe(
      1,
    );
  });
});

// ── Reference points compete with mesh nodes by distance ─────────────────────
//
// A reference point belongs to no surface, so the ray can only ever report the
// mesh behind it — a marker drawn on the face it couples is ALWAYS behind that
// face, whatever its render order. Which of the two was meant is therefore a
// distance question, and this is the comparison that answers it.

describe("reference points", () => {
  const refA = { nodeId: 900, point: [0, 0, 0] };
  const refB = { nodeId: 901, point: [10, 0, 0] };

  test("the nearer of two reference points wins", () => {
    expect(nearestReferencePoint([9, 0, 0], [refA, refB])?.nodeId).toBe(901);
  });

  test("the nearer of two reference points wins the other way round", () => {
    expect(nearestReferencePoint([1, 0, 0], [refA, refB])?.nodeId).toBe(900);
  });

  test("the squared distance is reported so the caller can compare against a node", () => {
    expect(nearestReferencePoint([3, 4, 0], [refA])?.distSq).toBe(25);
  });

  test("a model with no couplings has no reference point to pick", () => {
    expect(nearestReferencePoint([0, 0, 0], [])).toBeNull();
  });
});

// ── A click inside a flood-fill region toggles it off (KOF-211) ──────────────
//
// Without a CAD face behind the click, the region comes from the flood fill,
// and the flood fill depends on its seed triangle. On a finely tessellated
// cylinder every neighbour is within 15° of the seed, so the seed counts as
// "flat" and the fill grows a ±15° band centred on the click. A second click
// slightly next to the first grows a shifted band: the exact node-set
// comparison saw a new face and added it, so the selection could not be
// cleared. On a coarse cylinder whose facets are split into several
// triangles, an interior seed grows only its facet strip while a seed on a
// strip boundary walks the whole cylinder.

// Two-ring cylinder mantle, no CAD faces: `strips` flat facets around, each
// split into `cols` columns of quads (extra nodes on the chord), `rows` high.
function cylinderMantle(strips, cols, rows) {
  const perLevel = strips * cols;
  const mantleVerts = [];
  for (let level = 0; level <= rows; level++) {
    for (let col = 0; col < perLevel; col++) {
      const strip = Math.floor(col / cols);
      const frac = (col % cols) / cols;
      const theta0 = (2 * Math.PI * strip) / strips;
      const theta1 = (2 * Math.PI * (strip + 1)) / strips;
      mantleVerts.push([
        OUTER_RADIUS *
          ((1 - frac) * Math.cos(theta0) + frac * Math.cos(theta1)),
        OUTER_RADIUS *
          ((1 - frac) * Math.sin(theta0) + frac * Math.sin(theta1)),
        (level * HEIGHT) / rows,
      ]);
    }
  }
  const tris = [];
  for (let level = 0; level < rows; level++) {
    const base = level * perLevel;
    for (let col = 0; col < perLevel; col++) {
      const next = (col + 1) % perLevel;
      tris.push(
        ...quad(
          base + col,
          base + next,
          base + perLevel + next,
          base + perLevel + col,
        ),
      );
    }
  }
  const topo = buildBoundaryMeshTopo(tris, (nodeId) => mantleVerts[nodeId]);
  const picks = tris.map((_, triIndex) => pickFaceNodeIds(triIndex, topo));
  return { verts: mantleVerts, tris, picks };
}

function regionPick(mantle, triIndex) {
  return {
    nodeIds: [...mantle.picks[triIndex]],
    axis: "X",
    isMax: true,
    label: "",
  };
}

// Select at triangle `first`, then click triangle `second`.
function clickTwice(mantle, first, second) {
  const selection = toggleFaceSelection(
    [],
    regionPick(mantle, first),
    "Face",
    mantle.tris[first],
  );
  return toggleFaceSelection(
    selection,
    regionPick(mantle, second),
    "Face",
    mantle.tris[second],
  );
}

describe("deselect a flood-fill region by clicking inside it (KOF-211)", () => {
  // Fine cylinder (48 facets of 7.5°): each click grows a band around itself.
  const fine = cylinderMantle(48, 1, 1);
  const bandA = 0;
  const bandB = 2; // the next facet over, inside band A

  // Coarse cylinder (8 facets, each 2 columns x 3 rows): strip vs whole mantle.
  const coarse = cylinderMantle(8, 2, 3);
  const curvedSeed = coarse.picks.findIndex(
    (pick) => pick.size === coarse.verts.length,
  );
  const flatSeed = coarse.picks.findIndex(
    (pick) => pick.size < coarse.verts.length,
  );

  test("setup: a nearby click grows a different band", () => {
    expect(fine.picks[bandA]).not.toEqual(fine.picks[bandB]);
  });

  test("setup: the second click lies inside the first band", () => {
    for (const nodeId of fine.tris[bandB]) {
      expect(fine.picks[bandA].has(nodeId), `node ${nodeId}`).toBe(true);
    }
  });

  test("a click next to the first, inside its band, deselects it", () => {
    expect(clickTwice(fine, bandA, bandB)).toHaveLength(0);
  });

  test("setup: a strip-boundary seed grows the whole mantle", () => {
    expect(curvedSeed).toBeGreaterThanOrEqual(0);
  });

  test("setup: an interior seed grows only its facet strip", () => {
    expect(flatSeed).toBeGreaterThanOrEqual(0);
  });

  test("a click inside the selected mantle deselects it", () => {
    expect(clickTwice(coarse, curvedSeed, flatSeed)).toHaveLength(0);
  });

  test("a click inside the selected strip deselects it, even if it grows more", () => {
    const strip = coarse.picks[flatSeed];
    const curvedInStrip = coarse.tris.findIndex(
      (triangle, triIndex) =>
        coarse.picks[triIndex].size === coarse.verts.length &&
        triangle.every((nodeId) => strip.has(nodeId)),
    );
    expect(curvedInStrip).toBeGreaterThanOrEqual(0);
    expect(clickTwice(coarse, flatSeed, curvedInStrip)).toHaveLength(0);
  });

  // A click outside the selection still adds a second region.
  test("a click outside the selection adds a region", () => {
    const outside = fine.tris.findIndex(
      (triangle) => !triangle.every((nodeId) => fine.picks[bandA].has(nodeId)),
    );
    expect(clickTwice(fine, bandA, outside)).toHaveLength(2);
  });

  // A whole CAD face is exact: only an identical pick toggles it, so a
  // flood-fill click whose triangle happens to lie on its nodes still adds.
  test("a selected CAD face is not toggled by containment", () => {
    expect(
      toggleFaceSelection(
        [{ ...regionPick(fine, bandA), cadFaceId: 7 }],
        regionPick(fine, bandB),
        "Face",
        fine.tris[bandB],
      ),
    ).toHaveLength(2);
  });
});
