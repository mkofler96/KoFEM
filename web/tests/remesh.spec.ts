import { test, expect } from "@playwright/test";
import fs from "fs";
import { fileURLToPath } from "url";

// Regression test for issue #250: clicking "Re-mesh" failed with an opaque
// "Error: <pointer>". The worker is torn down after every mesh (so Netgen's
// global state can't reach the MFEM solve), so the re-mesh ran in a fresh WASM
// module with no STEP geometry loaded and generate_fem_mesh threw. The fix
// reloads the geometry from the retained STEP bytes before meshing.
//
// This drives the worker directly (window.__kofem) and reproduces the real UI
// sequence exactly: parse_step (import) → volume_mesh (mesh) → resetWorker
// (what LeftPanel does after each mesh) → volume_mesh (the re-mesh that
// regressed). Both meshes must produce a non-empty mesh.

const STEP_FILE = fileURLToPath(
  new URL("./fixtures/tube.stp", import.meta.url),
);

test("re-mesh succeeds after the worker is reset (issue #250)", async ({
  page,
}) => {
  test.setTimeout(180_000);

  await page.goto("/app/", { waitUntil: "domcontentloaded" });
  await page.waitForFunction(
    () => !!(window as Window & { __kofem?: unknown }).__kofem,
    { timeout: 30_000 },
  );

  const stepBytes = Array.from(fs.readFileSync(STEP_FILE));
  const result = (await page.evaluate(async (bytes) => {
    const k = (
      window as Window & {
        __kofem: {
          sendToWorker: (t: string, p: unknown) => Promise<unknown>;
          resetWorker: () => void;
        };
      }
    ).__kofem;
    const u8 = new Uint8Array(bytes);
    const opts = { bytes: u8, maxElementSize: 20, minElementSize: 2 };

    // Import + first mesh.
    await k.sendToWorker("parse_step", { bytes: u8 });
    const first = (await k.sendToWorker("volume_mesh", opts)) as {
      nodes: unknown[];
    };

    // LeftPanel resets the worker after every successful mesh — so the re-mesh
    // below runs in a brand-new module with no geometry, the exact #250 setup.
    k.resetWorker();
    const second = (await k.sendToWorker("volume_mesh", opts)) as {
      nodes: unknown[];
    };

    return { first: first.nodes.length, second: second.nodes.length };
  }, stepBytes)) as { first: number; second: number };

  expect(result.first).toBeGreaterThan(0);
  expect(result.second).toBeGreaterThan(0);
});

// Guard path: meshing with no geometry loaded and no STEP bytes to reload from
// (e.g. re-meshing a loaded analysis) must fail with an actionable message, not
// an opaque pointer. A fresh worker has no geometry, so volume_mesh without
// bytes hits the reload guard directly.
test("volume_mesh without STEP bytes fails with an actionable message", async ({
  page,
}) => {
  test.setTimeout(60_000);

  await page.goto("/app/", { waitUntil: "domcontentloaded" });
  await page.waitForFunction(
    () => !!(window as Window & { __kofem?: unknown }).__kofem,
    { timeout: 30_000 },
  );

  const message = await page.evaluate(async () => {
    const k = (
      window as Window & {
        __kofem: { sendToWorker: (t: string, p: unknown) => Promise<unknown> };
      }
    ).__kofem;
    try {
      await k.sendToWorker("volume_mesh", {
        maxElementSize: 20,
        minElementSize: 2,
      });
      return null;
    } catch (err) {
      return err instanceof Error ? err.message : String(err);
    }
  });

  expect(message).not.toBeNull();
  expect(message).toContain("no STEP geometry");
  expect(message).toContain("re-import");
});

// A C++ engine error (here: feeding the OCCT reader invalid STEP bytes) used to
// reach JS as a bare heap pointer, rendering as the meaningless "Error: 12190840"
// from issue #250. describeError must now produce human-readable text. The
// assertion holds whether or not the wasm exports getExceptionMessage: decoded
// what() text and the "C++ exception (undecoded, ptr N)" fallback both contain
// letters — a bare pointer number does not.
test("a C++ engine error surfaces as readable text, not a bare pointer (issue #250)", async ({
  page,
}) => {
  test.setTimeout(60_000);

  await page.goto("/app/", { waitUntil: "domcontentloaded" });
  await page.waitForFunction(
    () => !!(window as Window & { __kofem?: unknown }).__kofem,
    { timeout: 30_000 },
  );

  const message = await page.evaluate(async () => {
    const k = (
      window as Window & {
        __kofem: { sendToWorker: (t: string, p: unknown) => Promise<unknown> };
      }
    ).__kofem;
    const garbage = new TextEncoder().encode("this is not a STEP file");
    try {
      await k.sendToWorker("parse_step", { bytes: garbage });
      return null;
    } catch (err) {
      return err instanceof Error ? err.message : String(err);
    }
  });

  expect(message).not.toBeNull();
  expect(message).toMatch(/[a-zA-Z]/);
  expect(message?.trim()).not.toMatch(/^\d+$/);
});
