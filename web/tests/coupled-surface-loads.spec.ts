// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

import { test, expect } from "./coverage";

test("mixed worker applies total force, traction and pressure like equivalent nodal loads", async ({
  page,
}) => {
  await page.goto("/app/");
  await page.waitForFunction(() =>
    Boolean((window as unknown as { __kofem?: unknown }).__kofem),
  );
  const comparisons = await page.evaluate(async () => {
    const worker = (
      window as unknown as {
        __kofem: {
          sendToWorker(
            type: string,
            payload: object,
          ): Promise<{ displacements: Float64Array }>;
        };
      }
    ).__kofem;
    const nodes = [
      { id: 100, x: 0, y: 0, z: 0 },
      { id: 120, x: 2, y: 0, z: 0 },
      { id: 140, x: 0, y: 1, z: 0 },
      { id: 160, x: 0, y: 0, z: 1 },
    ];
    const model = {
      nodes,
      elements: [
        { id: 1, type: "CTETRA", nodeIds: [100, 120, 140, 160], propertyId: 1 },
        { id: 2, type: "CTRIA3", nodeIds: [100, 120, 160], propertyId: 2 },
      ],
      materials: [
        { id: 1, name: "Steel", young: 210000, poisson: 0.3, density: 1 },
      ],
      properties: [
        { id: 1, materialId: 1 },
        { id: 2, materialId: 1, thickness: 0.1 },
      ],
      constraints: [100, 120, 140].flatMap((nodeId) =>
        [0, 1, 2].map((dof) => ({ nodeId, dof })),
      ),
    };
    // The sloped tet facet has area 1.5 and area-normal [0.5, 1, 1].
    const faces = [[120, 140, 160]];
    const cases = [
      {
        surface: { type: "force", force: [0, -9, 0], faces },
        nodal: [0, -3, 0],
      },
      {
        surface: { type: "traction", force: [0, -6, 0], faces },
        nodal: [0, -3, 0],
      },
      {
        surface: { type: "pressure", pressure: 2, faces },
        nodal: [-1 / 3, -2 / 3, -2 / 3],
      },
    ];
    const results = [];
    for (const { surface, nodal } of cases) {
      const viaSurface = await worker.sendToWorker("solve", {
        ...model,
        loads: [],
        surfaceLoads: [surface],
      });
      const viaNodes = await worker.sendToWorker("solve", {
        ...model,
        loads: faces[0].flatMap((nodeId) =>
          nodal.map((value, dof) => ({ nodeId, dof, value })),
        ),
      });
      const reference = [...viaNodes.displacements];
      const peak = Math.max(...reference.map(Math.abs));
      const error = Math.max(
        ...reference.map((value, index) =>
          Math.abs(value - viaSurface.displacements[index]),
        ),
      );
      results.push({ type: surface.type, peak, relativeError: error / peak });
    }
    return results;
  });
  for (const result of comparisons) {
    expect(
      result.peak,
      `${result.type}: reference must deform`,
    ).toBeGreaterThan(0);
    expect(result.relativeError, result.type).toBeLessThan(1e-8);
  }
});
