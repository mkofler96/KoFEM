// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Unit tests for src/lib/densityField.ts — the topology-optimization density
// result → viewport geometry helpers (KOF-233): the solver-order element
// mapping, the visibility threshold count, the grayscale ramp, and the
// boundary-surface extraction of the retained element set.
//
// The surface extraction is the delicate part: a face shared by two kept
// elements is interior and must NOT be drawn, or the emerged shape fills with
// hidden internal triangles; a face kept by exactly one element is on the
// surface and is drawn once. Two tets sharing a face exercise both cases.

import { describe, expect, test } from "bun:test";
import {
  orderedDesignElements,
  visibleElementCount,
  densityColor,
  buildDensitySurface,
  buildSmoothDensitySurface,
  levelSetField,
  nodalDensity,
  buildDensityStl,
  buildSmoothDensityStl,
  densityStlFileName,
} from "../../src/lib/densityField.ts";

// Two tets sharing the triangular face {1,2,3}.
const nodes = [
  { id: 0, x: 0, y: 0, z: 0 },
  { id: 1, x: 1, y: 0, z: 0 },
  { id: 2, x: 0, y: 1, z: 0 },
  { id: 3, x: 0, y: 0, z: 1 },
  { id: 4, x: 1, y: 1, z: 1 },
];
const tetA = { id: 10, type: "CTETRA", nodeIds: [0, 1, 2, 3], propertyId: 1 };
const tetB = { id: 11, type: "CTETRA", nodeIds: [1, 2, 3, 4], propertyId: 1 };
const twoTets = [tetA, tetB];

// Unit cube as eight nodes, for the CHEXA cases.
const cubeNodes = [
  [0, 0, 0],
  [1, 0, 0],
  [1, 1, 0],
  [0, 1, 0],
  [0, 0, 1],
  [1, 0, 1],
  [1, 1, 1],
  [0, 1, 1],
].map(([x, y, z], id) => ({ id, x, y, z }));

function present(value, what) {
  if (value === null || value === undefined) {
    throw new Error(`${what} is missing`);
  }
  return value;
}

describe("orderedDesignElements", () => {
  test("orders tets, then hexes, then shell facets", () => {
    const hex = {
      id: 20,
      type: "CHEXA",
      nodeIds: [0, 1, 2, 3, 4, 5, 6, 7],
      propertyId: 1,
    };
    const shell = { id: 21, type: "CTRIA3", nodeIds: [0, 1, 2], propertyId: 1 };
    const ordered = orderedDesignElements([hex, tetA, shell, tetB]);
    expect(ordered).toHaveLength(4);
    expect(ordered[0].id).toBe(tetA.id);
    expect(ordered[1].id).toBe(tetB.id);
    expect(ordered[2].id).toBe(hex.id);
    expect(ordered[3].id).toBe(shell.id);
  });
});

describe("buildDensitySurface of a shell facet", () => {
  const shellNodes = [
    { id: 0, x: 0, y: 0, z: 0 },
    { id: 1, x: 1, y: 0, z: 0 },
    { id: 2, x: 0, y: 1, z: 0 },
  ];
  const shell = { id: 30, type: "CTRIA3", nodeIds: [0, 1, 2], propertyId: 1 };

  test("a shell facet above the threshold is drawn as one triangle", () => {
    const kept = buildDensitySurface(
      shellNodes,
      [shell],
      new Float64Array([0.9]),
      0.5,
    );
    expect(kept).not.toBeNull();
    expect(kept?.triangleCount).toBe(1);
  });

  test("a shell facet below the threshold is dropped", () => {
    expect(
      buildDensitySurface(shellNodes, [shell], new Float64Array([0.1]), 0.5),
    ).toBeNull();
  });
});

describe("visibleElementCount", () => {
  const density = new Float64Array([0.2, 0.6, 0.9, 0.5]);

  test("counts density >= threshold (0.5)", () => {
    expect(visibleElementCount(density, 0.5)).toBe(3);
  });

  test("at 0 keeps every element", () => {
    expect(visibleElementCount(density, 0)).toBe(4);
  });

  test("above the max keeps none", () => {
    expect(visibleElementCount(density, 1.01)).toBe(0);
  });
});

describe("densityColor", () => {
  test("maps full density to a darker grey than empty", () => {
    const low = densityColor(0);
    const high = densityColor(1);
    expect(high.r).toBeLessThan(low.r);
    expect(high.g).toBeLessThan(low.g);
    expect(high.b).toBeLessThan(low.b);
  });
});

describe("buildDensitySurface: interior face dropped, boundary faces kept", () => {
  test("both tets kept: shared face dropped, 6 boundary triangles", () => {
    // Both tets kept: the shared face is interior, so 3 + 3 = 6 boundary tris.
    const bothKept = buildDensitySurface(
      nodes,
      twoTets,
      new Float64Array([0.9, 0.9]),
      0.5,
    );
    expect(bothKept).not.toBeNull();
    expect(bothKept?.triangleCount).toBe(6);
  });

  test("buffers are triangleCount*9 long and consistent", () => {
    const bothKept = present(
      buildDensitySurface(nodes, twoTets, new Float64Array([0.9, 0.9]), 0.5),
      "surface",
    );
    expect(bothKept.positions).toHaveLength(bothKept.triangleCount * 9);
    expect(bothKept.normals).toHaveLength(bothKept.triangleCount * 9);
    expect(bothKept.colors).toHaveLength(bothKept.triangleCount * 9);
  });

  test("one tet kept: all four faces drawn (4 triangles)", () => {
    // Only tet A kept: all four of its faces are on the surface.
    const oneKept = buildDensitySurface(
      nodes,
      twoTets,
      new Float64Array([0.9, 0.1]),
      0.5,
    );
    expect(oneKept).not.toBeNull();
    expect(oneKept?.triangleCount).toBe(4);
  });

  test("all elements below threshold: null", () => {
    expect(
      buildDensitySurface(nodes, twoTets, new Float64Array([0.1, 0.1]), 0.5),
    ).toBeNull();
  });

  test("density length mismatch: null (stale guard)", () => {
    // Stale density (length != element count) gives null, never a mismatched draw.
    expect(
      buildDensitySurface(nodes, twoTets, new Float64Array([0.9]), 0.5),
    ).toBeNull();
  });
});

describe("smooth boundary: nodal field and isosurface", () => {
  // One tet, field 1 at node 0 and 0 elsewhere, level 0.5.
  const field = new Float64Array([1, 0, 0, 0, 0]);

  test("nodalDensity: volume-weighted average at shared nodes", () => {
    // Two tets share face {1,2,3}; density 1 and 0 gives the three shared
    // nodes a volume-weighted average, the private ones keep their own.
    const volA = 1 / 6;
    const volB = 1 / 3; // tetB = (1,0,0),(0,1,0),(0,0,1),(1,1,1): volume 1/3
    const nodal = present(
      nodalDensity(nodes, twoTets, new Float64Array([1, 0])),
      "nodal density",
    );
    const shared = volA / (volA + volB);
    expect(Math.abs(nodal[0] - 1)).toBeLessThan(1e-12);
    expect(Math.abs(nodal[4])).toBeLessThan(1e-12);
    for (const index of [1, 2, 3]) {
      expect(Math.abs(nodal[index] - shared), `node ${index}`).toBeLessThan(
        1e-12,
      );
    }
  });

  test("nodalDensity: stale density gives null", () => {
    expect(nodalDensity(nodes, twoTets, new Float64Array([1]))).toBeNull();
  });

  test("levelSetField maps phi = -1, 0, 1 to 0, 0.5, 1", () => {
    const levelSet = levelSetField(new Float64Array([-1, 0, 1]));
    expect(levelSet[0]).toBe(0);
    expect(levelSet[1]).toBe(0.5);
    expect(levelSet[2]).toBe(1);
  });

  describe("single tet corner", () => {
    // The iso triangle through the three edge midpoints of node 0, plus the
    // three boundary faces through node 0 clipped to their corner triangles.
    const one = buildSmoothDensitySurface(nodes, [tetA], field, 0.5);

    test("1 iso + 3 cap triangles", () => {
      expect(one).not.toBeNull();
      expect(one?.triangleCount).toBe(4);
    });

    test("iso triangle passes through the edge midpoints", () => {
      // The first triangle is the iso triangle: its vertices are the midpoints
      // (0.5,0,0), (0,0.5,0), (0,0,0.5).
      const surface = present(one, "surface");
      for (const vertex of [0, 1, 2]) {
        const point = surface.positions.slice(3 * vertex, 3 * vertex + 3);
        expect(
          Math.abs(point[0] + point[1] + point[2] - 0.5),
          `vertex ${vertex} coordinate sum`,
        ).toBeLessThan(1e-6);
        expect(
          [...point].filter((coord) => Math.abs(coord) < 1e-9),
          `vertex ${vertex} zero coordinates`,
        ).toHaveLength(2);
      }
    });

    test("iso normal points out of the material (away from node 0)", () => {
      const normal = present(one, "surface").normals.slice(0, 3);
      expect(normal[0], `normal ${Array.from(normal)}`).toBeGreaterThan(0);
      expect(normal[1], `normal ${Array.from(normal)}`).toBeGreaterThan(0);
      expect(normal[2], `normal ${Array.from(normal)}`).toBeGreaterThan(0);
    });
  });

  test("nothing inside: null", () => {
    expect(buildSmoothDensitySurface(nodes, [tetA], field, 1.5)).toBeNull();
  });

  test("stale field (length != nodes): null", () => {
    expect(
      buildSmoothDensitySurface(nodes, [tetA], new Float64Array(2), 0.5),
    ).toBeNull();
  });

  // Watertightness on a Kuhn-split 4x4x4 cube grid: the boundary of {f >= level}
  // must be a closed surface — every edge shared by exactly two triangles — both
  // for a ball inside the domain (isosurface only) and one cut by the domain
  // boundary (isosurface + caps).
  describe("watertightness on a Kuhn-split cube grid", () => {
    const cells = 4;
    const gridNodes = [];
    const nodeId = (ix, iy, iz) => ix + (cells + 1) * (iy + (cells + 1) * iz);
    for (let iz = 0; iz <= cells; iz++)
      for (let iy = 0; iy <= cells; iy++)
        for (let ix = 0; ix <= cells; ix++)
          gridNodes.push({ id: nodeId(ix, iy, iz), x: ix, y: iy, z: iz });
    const gridTets = [];
    const kuhn = [
      [0, 1, 2, 6],
      [0, 1, 5, 6],
      [0, 4, 5, 6],
      [0, 4, 7, 6],
      [0, 3, 7, 6],
      [0, 3, 2, 6],
    ];
    for (let iz = 0; iz < cells; iz++)
      for (let iy = 0; iy < cells; iy++)
        for (let ix = 0; ix < cells; ix++) {
          const corner = [
            nodeId(ix, iy, iz),
            nodeId(ix + 1, iy, iz),
            nodeId(ix + 1, iy + 1, iz),
            nodeId(ix, iy + 1, iz),
            nodeId(ix, iy, iz + 1),
            nodeId(ix + 1, iy, iz + 1),
            nodeId(ix + 1, iy + 1, iz + 1),
            nodeId(ix, iy + 1, iz + 1),
          ];
          for (const tet of kuhn)
            gridTets.push({
              id: gridTets.length,
              type: "CTETRA",
              nodeIds: tet.map((corner_) => corner[corner_]),
              propertyId: 1,
            });
        }
    const closed = (surface) => {
      const key = (offset) =>
        Array.from(surface.positions.slice(offset, offset + 3))
          .map((coord) => coord.toFixed(5))
          .join(",");
      const edges = new Map();
      for (let tri = 0; tri < surface.triangleCount; tri++) {
        const verts = [0, 1, 2].map((corner) => key(9 * tri + 3 * corner));
        for (let corner = 0; corner < 3; corner++) {
          const edge = [verts[corner], verts[(corner + 1) % 3]]
            .sort()
            .join("|");
          edges.set(edge, (edges.get(edge) ?? 0) + 1);
        }
      }
      return [...edges.values()].every((count) => count === 2);
    };
    const ball = (cx, cy, cz, radius) =>
      new Float64Array(
        gridNodes.map(
          (node) => radius - Math.hypot(node.x - cx, node.y - cy, node.z - cz),
        ),
      );

    test("ball inside the domain: closed isosurface", () => {
      const inner = buildSmoothDensitySurface(
        gridNodes,
        gridTets,
        ball(2, 2, 2, 1.3),
        0,
      );
      expect(inner).not.toBeNull();
      expect(closed(present(inner, "surface"))).toBe(true);
    });

    test("ball cut by the domain boundary: closed (isosurface + caps)", () => {
      const cut = buildSmoothDensitySurface(
        gridNodes,
        gridTets,
        ball(0.2, 0.3, 0.1, 2.4),
        0,
      );
      expect(cut).not.toBeNull();
      expect(closed(present(cut, "surface"))).toBe(true);
    });
  });
});

// ── buildDensityStl (KOF-239) ─────────────────────────────────────────────────
// Parse a binary STL back into triangles so the checks read the bytes a viewer
// would, not the in-memory surface.
function parseStl(buffer) {
  const view = new DataView(buffer);
  const count = view.getUint32(80, true);
  const tris = [];
  for (let tri = 0; tri < count; tri++) {
    const base = 84 + tri * 50;
    const float = (index) => view.getFloat32(base + index * 4, true);
    tris.push({
      normal: [float(0), float(1), float(2)],
      v: [
        [float(3), float(4), float(5)],
        [float(6), float(7), float(8)],
        [float(9), float(10), float(11)],
      ],
    });
  }
  const header = String.fromCharCode(...new Uint8Array(buffer, 0, 5));
  return { count, tris, header, byteLength: buffer.byteLength };
}

// Enclosed volume by the divergence theorem, sum of v0·(v1×v2)/6. It equals the
// solid's volume only if the surface is closed AND every triangle is wound
// outward; an inward face subtracts instead, so this checks both at once.
function signedVolume(tris) {
  let vol = 0;
  for (const { v: verts } of tris) {
    const [pa, pb, pc] = verts;
    vol +=
      (pa[0] * (pb[1] * pc[2] - pb[2] * pc[1]) -
        pa[1] * (pb[0] * pc[2] - pb[2] * pc[0]) +
        pa[2] * (pb[0] * pc[1] - pb[1] * pc[0])) /
      6;
  }
  return vol;
}

describe("buildDensityStl", () => {
  describe("two kept tets", () => {
    const stl = buildDensityStl(
      nodes,
      twoTets,
      new Float64Array([0.9, 0.9]),
      0.5,
    );

    test("6 triangles, 84 + 50*n bytes", () => {
      expect(stl).not.toBeNull();
      const parsed = parseStl(present(stl, "stl"));
      expect(parsed.count).toBe(6);
      expect(parsed.byteLength).toBe(84 + 6 * 50);
    });

    test("header does not start with 'solid' (would read as ASCII STL)", () => {
      const parsed = parseStl(present(stl, "stl"));
      expect(parsed.header).not.toBe("solid");
    });

    test("surface is closed and outward-wound (encloses 0.5)", () => {
      // tet A = 1/6, tet B = 1/3.
      const vol = signedVolume(parseStl(present(stl, "stl")).tris);
      expect(Math.abs(vol - 0.5), `signed volume ${vol}`).toBeLessThan(1e-6);
    });

    test("facet normals point outward (agree with the winding)", () => {
      const parsed = parseStl(present(stl, "stl"));
      for (const { normal, v: verts } of parsed.tris) {
        const [pa, pb, pc] = verts;
        const edgeAB = [pb[0] - pa[0], pb[1] - pa[1], pb[2] - pa[2]];
        const edgeAC = [pc[0] - pa[0], pc[1] - pa[1], pc[2] - pa[2]];
        const cross = [
          edgeAB[1] * edgeAC[2] - edgeAB[2] * edgeAC[1],
          edgeAB[2] * edgeAC[0] - edgeAB[0] * edgeAC[2],
          edgeAB[0] * edgeAC[1] - edgeAB[1] * edgeAC[0],
        ];
        expect(
          normal[0] * cross[0] + normal[1] * cross[1] + normal[2] * cross[2],
        ).toBeGreaterThan(0);
      }
    });
  });

  test("inverted tet ordering still exports outward (volume +1/6)", () => {
    // A tet with inverted node ordering (negative Jacobian) still exports
    // outward: orientation comes from the element centroid, not the node order.
    const inverted = {
      id: 12,
      type: "CTETRA",
      nodeIds: [0, 2, 1, 3],
      propertyId: 1,
    };
    const stl = present(
      buildDensityStl(nodes, [inverted], new Float64Array([1]), 0.5),
      "stl",
    );
    const vol = signedVolume(parseStl(stl).tris);
    expect(Math.abs(vol - 1 / 6), `signed volume ${vol}`).toBeLessThan(1e-6);
  });

  test("hex exports as 12 outward triangles enclosing volume 1", () => {
    // Unit cube as one CHEXA: 6 quads give 12 triangles enclosing volume 1.
    const hex = {
      id: 40,
      type: "CHEXA",
      nodeIds: [0, 1, 2, 3, 4, 5, 6, 7],
      propertyId: 1,
    };
    const stl = present(
      buildDensityStl(cubeNodes, [hex], new Float64Array([1]), 0.5),
      "stl",
    );
    const parsed = parseStl(stl);
    const vol = signedVolume(parsed.tris);
    expect(parsed.count).toBe(12);
    expect(Math.abs(vol - 1), `volume ${vol}`).toBeLessThan(1e-6);
  });

  test("every element below threshold: null (nothing to export)", () => {
    expect(
      buildDensityStl(nodes, twoTets, new Float64Array([0.1, 0.1]), 0.5),
    ).toBeNull();
  });

  test("file name encodes model and threshold", () => {
    expect(densityStlFileName("crane hook", 0.5)).toBe(
      "crane_hook_topopt_t0.50.stl",
    );
  });
});

describe("buildSmoothDensityStl: the Smooth view's shape, closed and outward", () => {
  // Field 1 at node 0, level 0.5: the corner tet cut at the edge midpoints,
  // volume (1/2)^3 * 1/6 = 1/48 — for both node-ordering handednesses.
  const field = new Float64Array([1, 0, 0, 0, 0]);

  test.each([
    ["positive", [0, 1, 2, 3]],
    ["inverted", [0, 2, 1, 3]],
  ])("a cut %s tet is closed and outward (volume 1/48)", (_name, ids) => {
    const tet = { id: 13, type: "CTETRA", nodeIds: ids, propertyId: 1 };
    const stl = present(
      buildSmoothDensityStl(nodes, [tet], field, 0.5, "density"),
      "stl",
    );
    const vol = signedVolume(parseStl(stl).tris);
    expect(Math.abs(vol - 1 / 48), `signed volume ${vol}`).toBeLessThan(1e-7);
  });

  test("a hex cut by a linear field encloses exactly the slab (0.75)", () => {
    // Unit-cube CHEXA with field f = x at level 0.25: the Kuhn split is exact
    // for a linear field, so the exported solid is the slab x >= 0.25.
    const hex = {
      id: 41,
      type: "CHEXA",
      nodeIds: [0, 1, 2, 3, 4, 5, 6, 7],
      propertyId: 1,
    };
    const slab = present(
      buildSmoothDensityStl(
        cubeNodes,
        [hex],
        new Float64Array(cubeNodes.map((node) => node.x)),
        0.25,
        "density",
      ),
      "stl",
    );
    const slabVol = signedVolume(parseStl(slab).tris);
    expect(Math.abs(slabVol - 0.75), `signed volume ${slabVol}`).toBeLessThan(
      1e-6,
    );
  });

  test("nothing inside: null", () => {
    expect(
      buildSmoothDensityStl(nodes, [tetA], field, 1.5, "density"),
    ).toBeNull();
  });
});
