// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

import { test, expect } from "./coverage";

// End-to-end coverage of the auto-shell pipeline (src/lib/shellize.ts +
// solver.worker tryCoupledSolve): a synthetic two-body assembly with a thin
// plate (20×20×0.5 mm, body 1) cantilevering off a thick block (16×20×16 mm,
// body 2) is solved through the worker's real solve path. The thin plate must
// be detected as a wall pair, collapsed to a mid-surface shell, coupled to the
// block with distributing couplings, and solved by the engine's coupled solver.
//
// The plate touches the block only through duplicated (unshared) interface
// nodes, so the all-solid fallback would see a floating plate and fail — a
// converged solve is itself proof that the coupled path carried the load.

type Summary = {
  nNodes: number;
  nElements: number;
  dispLen: number;
  vmLen: number;
  allFinite: boolean;
  tipUz: number; // most negative w at the free plate edge (x = 20)
  rootUz: number; // w at the plate row over the block edge (x = 10)
  maxPlateVm: number;
  maxBlockVm: number;
};

test("auto-shell: thin plate on a block solves through the coupled path", async ({
  page,
}) => {
  test.setTimeout(120_000);

  const logs: string[] = [];
  page.on("console", (msg) => logs.push(msg.text()));

  await page.goto("/app/");
  await expect(page.locator("nav")).toBeVisible();
  await page.waitForFunction(() =>
    Boolean((window as unknown as { __kofem?: unknown }).__kofem),
  );

  const summary = await page.evaluate(async (): Promise<Summary> => {
    type Node = { id: number; x: number; y: number; z: number };
    type Element = {
      id: number;
      type: string;
      nodeIds: number[];
      propertyId: number;
    };

    const nodes: Node[] = [];
    const elements: Element[] = [];

    // Kuhn 6-tet decomposition of each grid cell (corner bit order x+2y+4z);
    // every tet shares the cell diagonal 0–7, so boundary quads split into
    // exactly two triangles that are true tet faces.
    const KUHN = [
      [0, 1, 3, 7],
      [0, 3, 2, 7],
      [0, 2, 6, 7],
      [0, 6, 4, 7],
      [0, 4, 5, 7],
      [0, 5, 1, 7],
    ];
    const addGrid = (
      x0: number,
      y0: number,
      z0: number,
      nx: number,
      ny: number,
      nz: number,
      dx: number,
      dy: number,
      dz: number,
      body: number,
    ) => {
      const base = nodes.length;
      const nid = (i: number, j: number, k: number) =>
        base + i + (nx + 1) * (j + (ny + 1) * k) + 1; // 1-based store ids
      for (let k = 0; k <= nz; k++)
        for (let j = 0; j <= ny; j++)
          for (let i = 0; i <= nx; i++)
            nodes.push({
              id: nid(i, j, k),
              x: x0 + i * dx,
              y: y0 + j * dy,
              z: z0 + k * dz,
            });
      for (let k = 0; k < nz; k++)
        for (let j = 0; j < ny; j++)
          for (let i = 0; i < nx; i++) {
            const corner = [
              nid(i, j, k),
              nid(i + 1, j, k),
              nid(i, j + 1, k),
              nid(i + 1, j + 1, k),
              nid(i, j, k + 1),
              nid(i + 1, j, k + 1),
              nid(i, j + 1, k + 1),
              nid(i + 1, j + 1, k + 1),
            ];
            for (const t of KUHN)
              elements.push({
                id: elements.length + 1,
                type: "CTETRA",
                nodeIds: [
                  corner[t[0]],
                  corner[t[1]],
                  corner[t[2]],
                  corner[t[3]],
                ],
                propertyId: body,
              });
          }
    };

    // Body 1: thin plate z ∈ [0, 0.5], detected as a 0.5 mm wall pair.
    addGrid(0, 0, 0, 4, 4, 1, 5, 5, 0.5, 1);
    // Body 2: block 16×20×16 under the plate's x ∈ [-6, 10] half — every
    // opposite-face gap exceeds the 15 mm wall threshold, so it stays solid.
    addGrid(-6, 0, -16, 4, 4, 4, 4, 5, 4, 2);

    // Boundary faces (used exactly once across all tets), classified onto the
    // axis-aligned box planes to fake per-CAD-face ids. Each face carries the
    // tet's opposite vertex so it can be wound OUTWARD below — the wall
    // detector's flatness gate needs consistently oriented triangles, exactly
    // like Netgen's surface elements.
    const faceCount = new Map<
      string,
      { tri: number[]; opp: number; body: number }
    >();
    for (const el of elements)
      for (const f of [
        [0, 1, 2, 3],
        [0, 1, 3, 2],
        [0, 2, 3, 1],
        [1, 2, 3, 0],
      ]) {
        const tri = [el.nodeIds[f[0]], el.nodeIds[f[1]], el.nodeIds[f[2]]];
        const key = [...tri].sort((a, b) => a - b).join(",");
        if (faceCount.has(key)) faceCount.delete(key);
        else
          faceCount.set(key, {
            tri,
            opp: el.nodeIds[f[3]],
            body: el.propertyId,
          });
      }
    const byId = new Map(nodes.map((n) => [n.id, n]));
    const planes: { body: number; axis: "x" | "y" | "z"; at: number }[] = [
      { body: 1, axis: "z", at: 0.5 }, // face 1 — plate top
      { body: 1, axis: "z", at: 0 }, // face 2 — plate bottom
      { body: 1, axis: "x", at: 0 },
      { body: 1, axis: "x", at: 20 },
      { body: 1, axis: "y", at: 0 },
      { body: 1, axis: "y", at: 20 },
      { body: 2, axis: "z", at: 0 },
      { body: 2, axis: "z", at: -16 },
      { body: 2, axis: "x", at: -6 },
      { body: 2, axis: "x", at: 10 },
      { body: 2, axis: "y", at: 0 },
      { body: 2, axis: "y", at: 20 },
    ];
    const surfaceTriangles: [number, number, number][] = [];
    const surfaceFaceIds: number[] = [];
    const nodeById = (id: number): Node => {
      const found = byId.get(id);
      if (!found) throw new Error(`fixture references unknown node id ${id}`);
      return found;
    };
    for (const { tri, opp, body } of faceCount.values()) {
      const [pA, pB, pC, pO] = [tri[0], tri[1], tri[2], opp].map(nodeById);
      const edgeAB = [pB.x - pA.x, pB.y - pA.y, pB.z - pA.z];
      const edgeAC = [pC.x - pA.x, pC.y - pA.y, pC.z - pA.z];
      const normal = [
        edgeAB[1] * edgeAC[2] - edgeAB[2] * edgeAC[1],
        edgeAB[2] * edgeAC[0] - edgeAB[0] * edgeAC[2],
        edgeAB[0] * edgeAC[1] - edgeAB[1] * edgeAC[0],
      ];
      const toOpp = [
        pO.x - (pA.x + pB.x + pC.x) / 3,
        pO.y - (pA.y + pB.y + pC.y) / 3,
        pO.z - (pA.z + pB.z + pC.z) / 3,
      ];
      const inward =
        normal[0] * toOpp[0] + normal[1] * toOpp[1] + normal[2] * toOpp[2] > 0;
      const wound: [number, number, number] = inward
        ? [tri[0], tri[2], tri[1]]
        : [tri[0], tri[1], tri[2]];
      const fid = planes.findIndex(
        (pl) =>
          pl.body === body &&
          tri.every((id) => Math.abs(nodeById(id)[pl.axis] - pl.at) < 1e-6),
      );
      if (fid < 0) throw new Error("boundary face lies on no box plane");
      surfaceTriangles.push(wound);
      surfaceFaceIds.push(fid + 1);
    }

    // Clamp the block bottom; pull the plate's free edge down (total −100 N).
    const constraints = nodes
      .filter((n) => Math.abs(n.z + 16) < 1e-6)
      .flatMap((n) => [0, 1, 2].map((dof) => ({ nodeId: n.id, dof })));
    const tipTop = nodes.filter(
      (n) => Math.abs(n.x - 20) < 1e-6 && Math.abs(n.z - 0.5) < 1e-6,
    );
    const loads = tipTop.map((n) => ({
      nodeId: n.id,
      dof: 2,
      value: -100 / tipTop.length,
    }));

    const win = window as unknown as {
      __kofem: {
        sendToWorker(name: string, payload: object): Promise<unknown>;
      };
    };
    const res = (await win.__kofem.sendToWorker("solve", {
      nodes,
      elements,
      materials: [
        { id: 1, name: "steel", young: 210000, poisson: 0.3, density: 7.85e-9 },
      ],
      // Body 1 (the thin plate) is idealised as shells, body 2 (the block) stays
      // solid — the per-body element-type choice that drives the coupled path.
      properties: [
        { id: 1, materialId: 1, discretization: "shell" },
        { id: 2, materialId: 1, discretization: "solid" },
      ],
      constraints,
      loads,
      surfaceLoads: [],
      surfaceTriangles,
      surfaceFaceIds,
    })) as { displacements: Float64Array; vonMises: Float64Array };

    const uz = (n: Node) => {
      const i = nodes.indexOf(n);
      return res.displacements[3 * i + 2];
    };
    const plateNodes = nodes.filter((n) => n.z >= 0);
    const tipUz = Math.min(
      ...plateNodes.filter((n) => Math.abs(n.x - 20) < 1e-6).map(uz),
    );
    const rootUz = Math.min(
      ...plateNodes.filter((n) => Math.abs(n.x - 10) < 1e-6).map(uz),
    );
    let maxPlateVm = 0;
    let maxBlockVm = 0;
    for (let e = 0; e < elements.length; e++) {
      const vm = res.vonMises[e];
      if (elements[e].propertyId === 1) maxPlateVm = Math.max(maxPlateVm, vm);
      else maxBlockVm = Math.max(maxBlockVm, vm);
    }
    const all = [...res.displacements, ...res.vonMises];
    return {
      nNodes: nodes.length,
      nElements: elements.length,
      dispLen: res.displacements.length,
      vmLen: res.vonMises.length,
      allFinite: all.every((v) => Number.isFinite(v)),
      tipUz,
      rootUz,
      maxPlateVm,
      maxBlockVm,
    };
  });

  // The coupled path (not the all-solid fallback) carried the solve: one thin
  // wall on body 1, and only the block's tets stay solid.
  const autoShell = logs.find((l) => l.includes("[auto-shell]"));
  expect(autoShell).toBeTruthy();
  expect(autoShell).toContain("body 1: 1 thin walls");
  expect(autoShell).toContain("384 solid tets");

  expect(summary.dispLen).toBe(3 * summary.nNodes);
  expect(summary.vmLen).toBe(summary.nElements);
  expect(summary.allFinite).toBe(true);

  // The 0.5 mm plate bends DOWN under the tip load, growing along the
  // overhang. The magnitude window is wide but catches the thickness-inflation
  // regression (t³ stiffness: a doubled thickness cuts deflection ~8×) and a
  // broken coupling (free plate → orders of magnitude larger or NaN).
  expect(summary.tipUz).toBeLessThan(0);
  expect(-summary.tipUz).toBeGreaterThan(0.02);
  expect(-summary.tipUz).toBeLessThan(2);
  expect(-summary.tipUz).toBeGreaterThan(1.5 * -summary.rootUz);

  // Stress recovery produced non-trivial fields on both the shell facets
  // (mapped back to plate elements) and the solid tets.
  expect(summary.maxPlateVm).toBeGreaterThan(0);
  expect(summary.maxBlockVm).toBeGreaterThan(0);
  expect(summary.maxPlateVm).toBeGreaterThan(summary.maxBlockVm);
});
