import { test, expect } from "./coverage";
import path from "path";
import fs from "fs";
import { gotoApp } from "./fixtures/app";

// Captures the landing-page tutorial figures by driving the real app through a
// full analysis, exactly like the e2e showcase. Unlike showcase.spec.ts (whose
// screenshots are throwaway CI artifacts), these are committed under
// web/public/tutorial/ and embedded in index.html, so the tutorial is graphical
// and always reflects the current UI. Regenerate with:
//
//   bun playwright test tutorial-capture.spec.ts
//
// The tube produces ~760 tets / 274 nodes — small enough for a fast solve and a
// clean, legible figure.
const OUT_DIR = path.resolve("public", "tutorial");
const STEP_FILES_DIR = path.resolve("..", "test_files");
const TUBE = path.join(STEP_FILES_DIR, "tube.stp");

test.describe("Tutorial figure capture", () => {
  test.beforeAll(() => {
    fs.mkdirSync(OUT_DIR, { recursive: true });
  });

  test.use({ viewport: { width: 1280, height: 820 } });

  test("full workflow → committed tutorial figures", async ({ page }) => {
    test.setTimeout(600_000);

    if (!fs.existsSync(TUBE)) {
      test.skip();
      return;
    }

    const shot = (name: string) =>
      page.screenshot({ path: path.join(OUT_DIR, name) });

    // Fail fast on any browser console error or uncaught page exception.
    let rejectOnError: ((err: Error) => void) | null = null;
    const fatalError = new Promise<never>((_, rej) => {
      rejectOnError = rej;
    });
    page.on("console", (msg) => {
      if (msg.type() !== "error") return;
      const text = msg.text();
      // Ignore network/resource failures (e.g. blocked web-font CDN in sandboxed
      // capture environments) — only real engine/JS errors should fail capture.
      if (text.includes("Failed to load resource")) return;
      rejectOnError?.(new Error(`Browser console.error: ${text}`));
    });
    page.on("pageerror", (err) => rejectOnError?.(err));

    await gotoApp(page);

    // 1. Import — the empty geometry card.
    await Promise.race([
      expect(page.getByRole("button", { name: "Import STEP" })).toBeVisible(),
      fatalError,
    ]);
    await shot("01-import.png");

    await page
      .locator('input[type="file"][accept=".stp,.step"]')
      .setInputFiles(TUBE);
    await Promise.race([
      expect(
        page.getByRole("button").filter({ hasText: "Mesh STEP volume" }),
      ).toBeVisible({ timeout: 60_000 }),
      fatalError,
    ]);
    const stepErr = page.getByTestId("step-error");
    if (await stepErr.isVisible()) {
      throw new Error(`STEP import failed: ${await stepErr.textContent()}`);
    }
    await page.waitForTimeout(600);

    // 2. Geometry — the tessellated CAD surface in the viewport.
    await shot("02-geometry.png");

    // 3. Mesh — fill the solid with tetrahedra.
    await page
      .getByRole("button")
      .filter({ hasText: "Mesh STEP volume" })
      .click();
    const meshErr = page.getByTestId("meshing-error");
    await Promise.race([
      expect(page.getByText("Mesh is solver-ready")).toBeVisible({
        timeout: 60_000,
      }),
      meshErr.waitFor({ state: "visible", timeout: 60_000 }).then(async () => {
        throw new Error(
          `Volume meshing failed: ${await meshErr.textContent()}`,
        );
      }),
      fatalError,
    ]);
    await page.waitForTimeout(400);
    await shot("03-mesh.png");

    // 4. Constraints & loads — fix the near face, pull the far face. Injected
    // through the store (the same path the showcase uses) so the capture does
    // not depend on interactive face-picking.
    await page.evaluate(() => {
      type CoordNode = { id: number; x: number; y: number; z: number };
      type FaceEntry = { label: string; nodeIds: number[] };
      const store = (
        window as unknown as {
          __kofemStore: {
            getState(): {
              nodes: CoordNode[];
              createBcGroup(f: FaceEntry[], dofs: number[], v: number): void;
              createLoadGroup(f: FaceEntry[], dof: number, force: number): void;
            };
          };
        }
      ).__kofemStore;
      const { nodes } = store.getState();
      const axes = ["x", "y", "z"] as const;
      const ranges = axes.map((ax) => {
        const vals = nodes.map((n) => n[ax]);
        return { ax, min: Math.min(...vals), max: Math.max(...vals) };
      });
      const { ax, min, max } = ranges.reduce((a, b) =>
        b.max - b.min > a.max - a.min ? b : a,
      );
      const tol = (max - min) * 0.01;
      const fixedIds = nodes.filter((n) => n[ax] < min + tol).map((n) => n.id);
      const loadedIds = nodes.filter((n) => n[ax] > max - tol).map((n) => n.id);
      store
        .getState()
        .createBcGroup([{ label: "Face 1", nodeIds: fixedIds }], [0, 1, 2], 0);
      store
        .getState()
        .createLoadGroup([{ label: "Face 2", nodeIds: loadedIds }], 1, -2000);
    });

    const bc = await page.evaluate(() => {
      const s = (
        window as unknown as {
          __kofemStore: {
            getState(): { constraints: unknown[]; loads: unknown[] };
          };
        }
      ).__kofemStore.getState();
      return { constraints: s.constraints.length, loads: s.loads.length };
    });
    if (bc.constraints === 0 || bc.loads === 0) {
      throw new Error(
        `BC/load injection failed: constraints=${bc.constraints} loads=${bc.loads}`,
      );
    }

    await page
      .locator("nav")
      .getByRole("button")
      .filter({ hasText: "Constraints" })
      .click();
    await Promise.race([
      expect(page.getByText("Fixed displacement")).toBeVisible({
        timeout: 15_000,
      }),
      fatalError,
    ]);
    await page.waitForTimeout(400);
    await shot("04-constraints.png");

    // 5. Solve → results. Trigger via the exposed hook (the showcase documents
    // why clicking the button stalls under Promise.race in CI).
    await page
      .locator("nav")
      .getByRole("button")
      .filter({ hasText: "Solve" })
      .click();
    await Promise.race([
      page.waitForFunction(
        () =>
          typeof (window as unknown as { __kofemTriggerSolve?: () => void })
            .__kofemTriggerSolve === "function",
        { timeout: 15_000 },
      ),
      fatalError,
    ]);
    await page.evaluate(() => {
      (
        window as unknown as { __kofemTriggerSolve?: () => void }
      ).__kofemTriggerSolve?.();
    });
    await Promise.race([
      expect(page.getByText("Result summary")).toBeVisible({
        timeout: 120_000,
      }),
      fatalError,
    ]);
    await page.waitForTimeout(600);
    await shot("05-results.png");
  });
});
