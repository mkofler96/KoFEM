// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

import { test, expect } from "./coverage";
import path from "path";
import fs from "fs";
import { importIges } from "./fixtures/app";

const IGES_FILE = path.resolve("..", "test_files", "cube_surfaces.igs");

test("WASM OCC generate_fem_mesh: end-to-end smoke test on surface-only IGES fixture", async ({
  page,
}) => {
  test.setTimeout(120_000);
  test.skip(!fs.existsSync(IGES_FILE), `IGES fixture not found: ${IGES_FILE}`);

  const logs: string[] = [];
  page.on("console", (msg) => {
    const text = `[wasm-unit-iges] ${msg.type()}: ${msg.text()}`;
    console.log(text);
    logs.push(text);
  });
  page.on("pageerror", (e) =>
    console.error(`[wasm-unit-iges] page error: ${e.message}`),
  );

  // The fixture is a cube exported as 6 free trimmed planar surfaces (no
  // solid/shell entity), mirroring a real CAD tool's surface-only IGES
  // export. Importing it exercises tessellate_step's IGES reader and the
  // sew_faces_into_solid() repair (adaptive tolerance sewing + closed-shell
  // detection) added for issue #276.
  await importIges(page, IGES_FILE);

  // Wait for __kofem (set synchronously in main.tsx)
  await page.waitForFunction(() =>
    Boolean((window as unknown as { __kofem?: unknown }).__kofem),
  );

  const result = (await page.evaluate(() =>
    (
      window as unknown as {
        __kofem: { sendToWorker: (t: string, p: unknown) => Promise<unknown> };
      }
    ).__kofem.sendToWorker("test_generate_fem_mesh", {}),
  )) as { nodes: number; elements: number; durationMs: number };

  console.log(
    `[wasm-unit-iges] nodes=${result.nodes} elements=${result.elements} durationMs=${result.durationMs}`,
  );
  // A non-zero tet count confirms sew_faces_into_solid() turned the loose
  // IGES surfaces into a closed solid Netgen could fill (issue #276 guard).
  expect(result.nodes).toBeGreaterThan(0);
  expect(result.elements).toBeGreaterThan(0);
  expect(result.durationMs).toBeLessThan(60_000);
});
