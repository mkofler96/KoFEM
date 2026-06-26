// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

import { test, expect } from "./coverage";
import path from "path";
import fs from "fs";
import { gotoApp } from "./fixtures/app";

const OUT_DIR = path.join("playwright-results", "screenshots", "showcase");
const STEP_FILES_DIR = path.resolve("..", "test_files");
// tube.stp produces ~760 tets / 274 nodes — small enough for a fast CI solve.
// Wall Bracket produces ~50K tets regardless of element size (geometry-driven)
// which overloads the CI runner's disk and memory budget.
const TUBE = path.join(STEP_FILES_DIR, "tube.stp");

test.describe("Full workflow showcase", () => {
  test.beforeAll(() => {
    fs.mkdirSync(OUT_DIR, { recursive: true });
  });

  test("tube: import → geometry → mesh → constraints → results", async ({
    page,
  }) => {
    test.setTimeout(600_000);

    if (!fs.existsSync(TUBE)) {
      test.skip();
      return;
    }

    const t0 = Date.now();
    const elapsed = () => `+${((Date.now() - t0) / 1000).toFixed(1)}s`;

    // Any browser console.error or uncaught page exception fails the test immediately.
    let _rejectOnError: ((err: Error) => void) | null = null;
    const fatalError = new Promise<never>((_, rej) => {
      _rejectOnError = rej;
    });

    page.on("console", (msg) => {
      if (msg.type() === "error") {
        const text = msg.text();
        console.error(`[showcase] browser error: ${text}`);
        _rejectOnError?.(new Error(`Browser console.error: ${text}`));
      } else {
        console.log(`[showcase] browser ${msg.type()}: ${msg.text()}`);
      }
    });
    page.on("pageerror", (err) => {
      console.error(`[showcase] page exception: ${err.message}`);
      _rejectOnError?.(err);
    });

    await gotoApp(page);

    // 1. Empty app — geometry import card
    await Promise.race([
      expect(page.getByRole("button", { name: "Import STEP" })).toBeVisible(),
      fatalError,
    ]);
    await page.screenshot({
      path: path.join(OUT_DIR, "01-select-geometry.png"),
    });
    console.log(`[showcase] ${elapsed()} 01 screenshot done`);

    // Import tube
    console.log(`[showcase] ${elapsed()} importing tube.stp`);
    await page
      .locator('input[type="file"][accept=".stp,.step"]')
      .setInputFiles(TUBE);
    await Promise.race([
      expect(
        page.getByRole("button").filter({ hasText: "Mesh STEP volume" }),
      ).toBeVisible({ timeout: 60_000 }),
      fatalError,
    ]);
    console.log(`[showcase] ${elapsed()} tessellation done`);

    const stepErrorBanner = page.getByTestId("step-error");
    if (await stepErrorBanner.isVisible()) {
      throw new Error(
        `STEP import failed: ${await stepErrorBanner.textContent()}`,
      );
    }

    await page.waitForTimeout(600);

    // 2. Geometry panel
    await page.screenshot({
      path: path.join(OUT_DIR, "02-geometry-options.png"),
    });
    console.log(`[showcase] ${elapsed()} 02 screenshot done`);

    // 3. Mesh — trigger volume meshing (controls live in the Geometry panel)
    await expect(
      page.getByRole("button").filter({ hasText: "Mesh STEP volume" }),
    ).toBeVisible();
    console.log(`[showcase] ${elapsed()} 03 clicking Mesh STEP volume…`);
    await page
      .getByRole("button")
      .filter({ hasText: "Mesh STEP volume" })
      .click();

    const meshingErrorBanner = page.getByTestId("meshing-error");
    await Promise.race([
      expect(page.getByText("Mesh is solver-ready")).toBeVisible({
        timeout: 60_000,
      }),
      meshingErrorBanner
        .waitFor({ state: "visible", timeout: 60_000 })
        .then(async () => {
          throw new Error(
            `Volume meshing failed: ${await meshingErrorBanner.textContent()}`,
          );
        }),
      fatalError,
    ]);
    console.log(`[showcase] ${elapsed()} 03 volume mesh complete`);
    await page.screenshot({
      path: path.join(OUT_DIR, "03-mesh-generation.png"),
    });
    console.log(`[showcase] ${elapsed()} 03 screenshot done`);

    // 4. Apply BCs and show constraints panel.
    // Find the mesh's long axis by bounding-box extents; fix the near face, load the far face.
    await page.evaluate(() => {
      type CoordNode = { id: number; x: number; y: number; z: number };
      type FaceEntry = { label: string; nodeIds: number[] };
      const store = (
        window as unknown as {
          __kofemStore: {
            getState(): {
              nodes: CoordNode[];
              createBcGroup(
                faces: FaceEntry[],
                dofs: number[],
                val: number,
              ): void;
              createLoadGroup(
                faces: FaceEntry[],
                dof: number,
                force: number,
              ): void;
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
        .createLoadGroup([{ label: "Face 1", nodeIds: loadedIds }], 1, -2000);
    });

    // Verify the store has constraints and loads before proceeding.
    // This catches any silent failure in the page.evaluate above.
    const bcState = await page.evaluate(() => {
      const store = (
        window as unknown as {
          __kofemStore: {
            getState(): {
              constraints: unknown[];
              loads: unknown[];
              surfaceLoads: unknown[];
              isRunning: boolean;
            };
          };
        }
      ).__kofemStore;
      const s = store.getState();
      return {
        constraints: s.constraints.length,
        // Force/pressure loads reach the solver as surface tractions; moments as
        // nodal forces. Count both so the gate holds for either kind.
        loads: s.loads.length + s.surfaceLoads.length,
        isRunning: s.isRunning,
      };
    });
    console.log(
      `[showcase] ${elapsed()} store after evaluate — constraints:${bcState.constraints} loads:${bcState.loads} isRunning:${bcState.isRunning}`,
    );
    if (bcState.constraints === 0 || bcState.loads === 0) {
      throw new Error(
        `BC/load injection failed: constraints=${bcState.constraints} loads=${bcState.loads}`,
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
    await page.screenshot({
      path: path.join(OUT_DIR, "04-load-application.png"),
    });
    console.log(`[showcase] ${elapsed()} 04 screenshot done`);

    // 5. Solve and results
    // Navigate to the Solve panel, which mounts SolvePanel and exposes
    // window.__kofemTriggerSolve.  We trigger the solve via evaluate() rather
    // than clicking the button because toBeEnabled() inside Promise.race() has
    // exhibited a mysterious ~300 s stall in CI despite correct store state.
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
    // Log pre-solve state for CI diagnostics
    const presolveState = await page.evaluate(() => {
      const store = (
        window as unknown as {
          __kofemStore: {
            getState(): {
              nodes: unknown[];
              constraints: unknown[];
              loads: unknown[];
              surfaceLoads: unknown[];
              isRunning: boolean;
            };
          };
        }
      ).__kofemStore;
      const s = store.getState();
      return {
        nodes: s.nodes.length,
        constraints: s.constraints.length,
        loads: s.loads.length + s.surfaceLoads.length,
        isRunning: s.isRunning,
      };
    });
    console.log(
      `[showcase] ${elapsed()} pre-solve — nodes:${presolveState.nodes} constraints:${presolveState.constraints} loads:${presolveState.loads} isRunning:${presolveState.isRunning}`,
    );
    if (
      presolveState.nodes === 0 ||
      presolveState.constraints === 0 ||
      presolveState.loads === 0
    ) {
      throw new Error(
        `Solve preconditions not met: ${JSON.stringify(presolveState)}`,
      );
    }
    await page.evaluate(() => {
      (
        window as unknown as { __kofemTriggerSolve?: () => void }
      ).__kofemTriggerSolve?.();
    });
    console.log(`[showcase] ${elapsed()} solver started…`);

    await Promise.race([
      expect(page.getByText("Result summary")).toBeVisible({
        timeout: 120_000,
      }),
      fatalError,
    ]);

    await page.screenshot({ path: path.join(OUT_DIR, "05-results.png") });
    console.log(`[showcase] ${elapsed()} 05 screenshot done`);

    console.log(`[showcase] ${elapsed()} DONE`);
  });
});
