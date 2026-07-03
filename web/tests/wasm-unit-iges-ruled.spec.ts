// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

import { test, expect } from "./coverage";
import path from "path";
import fs from "fs";
import { importIges } from "./fixtures/app";

const IGES_FILE = path.resolve("..", "test_files", "ruled_surface.igs");

test("WASM IGES import: ruled-surface entity (type 118) converts to real geometry", async ({
  page,
}) => {
  test.setTimeout(120_000);
  test.skip(!fs.existsSync(IGES_FILE), `IGES fixture not found: ${IGES_FILE}`);

  const logs: string[] = [];
  page.on("console", (msg) => {
    const text = `[wasm-unit-iges-ruled] ${msg.type()}: ${msg.text()}`;
    console.log(text);
    logs.push(text);
  });
  page.on("pageerror", (e) =>
    console.error(`[wasm-unit-iges-ruled] page error: ${e.message}`),
  );

  // The fixture is a single IGES ruled surface (entity type 118) spanned
  // between two lines. Converting it runs IGESToBRep_TopoSurface, which calls
  // BRepFill::Face — a symbol that used to be stubbed out to a silent no-op in
  // the WASM build, so this import crashed on a degenerate face (issue #319).
  // Importing through the UI proves the real OCCT implementation is linked.
  await importIges(page, IGES_FILE);

  await page.waitForFunction(() =>
    Boolean((window as unknown as { __kofem?: unknown }).__kofem),
  );

  // Re-tessellate through the worker directly to assert the converted face
  // produces real triangles, not an empty shape.
  const igesBase64 = fs.readFileSync(IGES_FILE).toString("base64");
  const result = (await page.evaluate((b64) => {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return (
      window as unknown as {
        __kofem: { sendToWorker: (t: string, p: unknown) => Promise<unknown> };
      }
    ).__kofem.sendToWorker("parse_step", { bytes, format: "iges" });
  }, igesBase64)) as { points: unknown[]; triangles: unknown[] };

  console.log(
    `[wasm-unit-iges-ruled] points=${result.points.length} triangles=${result.triangles.length}`,
  );
  // The ruled surface between two 50 mm lines is a flat quad — at least two
  // triangles. With the old stub the entity transferred as an empty face and
  // the import crashed before producing any tessellation.
  expect(result.points.length).toBeGreaterThanOrEqual(4);
  expect(result.triangles.length).toBeGreaterThanOrEqual(2);
});
