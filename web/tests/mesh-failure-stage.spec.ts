// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// A meshing failure says which step failed (KOF-311), through the real worker
// and engine: solver.worker tags the step, sharedWorker carries it to the page.
// Analytics falls back to the step when the message matches no category.

import { test, expect } from "./coverage";

test("a failed geometry reload reaches the page tagged with its step", async ({
  page,
}) => {
  await page.goto("/app/");
  await page.waitForFunction(() =>
    Boolean((window as unknown as { __kofem?: unknown }).__kofem),
  );

  // A fresh worker holds no geometry, so volume_mesh reloads it from the
  // bytes first — and these bytes are not a STEP file.
  const failure = await page.evaluate(async () => {
    const kofem = (
      window as unknown as {
        __kofem: {
          sendToWorker: (type: string, payload: unknown) => Promise<unknown>;
        };
      }
    ).__kofem;
    try {
      await kofem.sendToWorker("volume_mesh", {
        bytes: new TextEncoder().encode("this is not a STEP file"),
        format: "step",
        maxElementSize: 5,
        minElementSize: 0.5,
      });
      return null;
    } catch (err) {
      return {
        message: err instanceof Error ? err.message : String(err),
        stage: (err as { stage?: unknown }).stage,
      };
    }
  });

  expect(failure).not.toBeNull();
  expect(failure?.message).toMatch(/invalid STEP file/);
  expect(failure?.stage).toBe("geometry_reload");
});
