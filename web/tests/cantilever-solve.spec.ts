// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

import { test, expect } from "./coverage";
import { buildCantilever } from "./fixtures/cantilever";

// JS/WASM pipeline verification — no UI. Feeds the known cantilever model
// straight into the solve worker and checks the returned fields. This is the
// solver-correctness coverage that the old "solve on hex mesh" UI test gave us,
// now decoupled from the (removed) welcome-screen example button.

type SolveResult = { displacements: number[]; vonMises: number[] };

test("solve worker returns displacements and von Mises for the cantilever", async ({
  page,
}) => {
  await page.goto("/app/");
  await page.waitForFunction(
    () => !!(window as unknown as { __kofem?: unknown }).__kofem,
  );

  // Collect the worker log stream that feeds the UI log panels (issue #278):
  // sharedWorker echoes every worker log line to the browser console as
  // "[wasm] <line>", so the console is a faithful copy of what the panel gets.
  const wasmLogs: string[] = [];
  page.on("console", (msg) => {
    const text = msg.text();
    if (text.startsWith("[wasm]")) wasmLogs.push(text);
  });

  const model = buildCantilever();

  const result = (await page.evaluate(async (m) => {
    const kofem = (
      window as unknown as {
        __kofem: {
          sendToWorker(name: string, payload: object): Promise<unknown>;
        };
      }
    ).__kofem;
    return kofem.sendToWorker("solve", {
      nodes: m.nodes,
      elements: m.elements,
      materials: m.materials,
      properties: m.properties,
      constraints: m.constraints,
      loads: m.loads,
    });
  }, model)) as SolveResult;

  // One displacement vector (ux, uy, uz) per node.
  expect(result.displacements.length).toBe(model.nodes.length * 3);
  // One von Mises scalar per element.
  expect(result.vonMises.length).toBe(model.elements.length);

  // Mean vertical deflection of the free-end nodes (x = 1.0).
  const tipIds = model.nodes
    .filter((n) => Math.abs(n.x - 1.0) < 1e-9)
    .map((n) => n.id);
  const idIndex = new Map(model.nodes.map((n, i) => [n.id, i]));
  const tipUy =
    tipIds.reduce(
      (s, id) => s + result.displacements[idIndex.get(id)! * 3 + 1],
      0,
    ) / tipIds.length;

  // Analytical Euler–Bernoulli tip deflection for a cantilever with an end load:
  //   δ = P·L³ / (3·E·I),   I = b·h³/12
  // The transverse-shear contribution (Timoshenko) is <1% for this L/h = 10
  // beam, so Euler–Bernoulli is the right reference here.
  /* eslint-disable kofem/min-identifier-length -- symbols from the Euler–Bernoulli formula above: δ = P·L³/(3·E·I), I = b·h³/12 */
  const P = 10_000; // |tip load| (N)
  const L = 1.0; // length (m)
  const E = model.materials[0].young;
  const b = 0.1,
    h = 0.1; // cross-section (m)
  const I = (b * h ** 3) / 12;
  /* eslint-enable kofem/min-identifier-length */
  const deltaAnalytical = (P * L ** 3) / (3 * E * I); // ≈ 1.905 mm

  expect(tipUy).toBeLessThan(0);
  // Coarse linear-hex meshes lock in bending (stiffer than reality), so the FE
  // deflection sits below analytical. The observed value for this 10×2×2 mesh is
  // ~30.5% under Euler–Bernoulli; allow a 35% band so the check stays a
  // meaningful order-of-magnitude assertion without being flaky.
  const relErr = Math.abs(
    (Math.abs(tipUy) - deltaAnalytical) / deltaAnalytical,
  );
  expect(relErr).toBeLessThan(0.35);

  // The solve must stream its CG residual minimization like the mesher streams
  // meshing progress (issue #278): the CGLogMonitor prints every 10th iteration
  // plus a converged summary through the worker's log channel.
  expect(
    wasmLogs.filter((l) => /CG iteration\s+\d+: relative residual/.test(l))
      .length,
  ).toBeGreaterThan(1);
  expect(wasmLogs.some((l) => /CG converged: \d+ iterations/.test(l))).toBe(
    true,
  );
});
