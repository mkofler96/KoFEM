import { test, expect, type Page } from "@playwright/test";
import path from "path";
import fs from "fs";
import {
  installCursor,
  moveCursor,
  rippleCursor,
  clickWithCursor,
} from "./fixtures/cursor";

// Records the landing-page walkthrough video by driving the real app through a
// full analysis with a synthetic on-screen cursor, so the clicks and the
// realtime mesh/solve computation are all visible. The result is committed at
// web/public/tutorial/walkthrough.webm and embedded in index.html. Regenerate
// with:
//
//   bun run capture:video
//
// Models the Wall Bracket (same as the still-figure tutorial): the three
// mounting-bolt holes are fixed and a downward load is applied to the
// cylindrical hub. Faces are selected by their stable OCC face index.
const OUT_DIR = path.resolve("public", "tutorial");
const VIDEO_OUT = path.join(OUT_DIR, "walkthrough.webm");
const STEP_FILES_DIR = path.resolve("..", "test_files");
const BRACKET = path.join(STEP_FILES_DIR, "Wall Bracket.stp");
const HOLE_FACES = [34, 35, 36];
const TUBE_FACES = [3, 37];

const VIEWPORT = { width: 1280, height: 820 };

test.describe("Tutorial walkthrough video", () => {
  test("full workflow → committed walkthrough video @video", async ({
    browser,
  }) => {
    test.setTimeout(600_000);

    if (!fs.existsSync(BRACKET)) {
      test.skip();
      return;
    }
    fs.mkdirSync(OUT_DIR, { recursive: true });

    const context = await browser.newContext({
      viewport: VIEWPORT,
      recordVideo: { dir: OUT_DIR, size: VIEWPORT },
    });
    const page: Page = await context.newPage();

    // Fail fast on any real browser error (network/resource failures excepted).
    let rejectOnError: ((err: Error) => void) | null = null;
    const fatalError = new Promise<never>((_, rej) => {
      rejectOnError = rej;
    });
    page.on("console", (msg) => {
      if (msg.type() !== "error") return;
      const text = msg.text();
      if (text.includes("Failed to load resource")) return;
      rejectOnError?.(new Error(`Browser console.error: ${text}`));
    });
    page.on("pageerror", (err) => rejectOnError?.(err));

    let savedPath: string | null = null;
    try {
      await installCursor(page);
      await page.goto("/app/");
      await expect(page.locator("nav")).toBeVisible();
      await page.waitForTimeout(900);

      // 1. Import the STEP geometry. The real <input> is hidden behind the
      // "Import STEP" button, so we choreograph the cursor onto the button and
      // ripple, then feed the file through the input.
      const importBtn = page.getByRole("button", { name: "Import STEP" });
      await Promise.race([expect(importBtn).toBeVisible(), fatalError]);
      const ibox = await importBtn.boundingBox();
      if (ibox) {
        await moveCursor(
          page,
          ibox.x + ibox.width / 2,
          ibox.y + ibox.height / 2,
        );
        await rippleCursor(page);
      }
      await page
        .locator('input[type="file"][accept=".stp,.step"]')
        .setInputFiles(BRACKET);
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
      // Let the tessellated CAD surface settle in the viewport.
      await page.waitForTimeout(1400);

      // 2. Mesh the volume — click and watch Netgen fill the solid in realtime.
      await clickWithCursor(
        page,
        page.getByRole("button").filter({ hasText: "Mesh STEP volume" }),
      );
      const meshErr = page.getByTestId("meshing-error");
      await Promise.race([
        expect(page.getByText("Mesh is solver-ready")).toBeVisible({
          timeout: 180_000,
        }),
        meshErr
          .waitFor({ state: "visible", timeout: 180_000 })
          .then(async () => {
            throw new Error(
              `Volume meshing failed: ${await meshErr.textContent()}`,
            );
          }),
        fatalError,
      ]);
      await page.waitForTimeout(1400);

      // 3. Constrain and load. Sweep the cursor across the bolt holes and the
      // hub with click ripples for the camera, then commit the BC/load groups
      // through the store (the same robust path the still-figure capture uses).
      const canvas = page.locator("canvas").first();
      const cbox = await canvas.boundingBox();
      if (cbox) {
        const pts = [
          { x: cbox.x + cbox.width * 0.34, y: cbox.y + cbox.height * 0.44 },
          { x: cbox.x + cbox.width * 0.44, y: cbox.y + cbox.height * 0.58 },
          { x: cbox.x + cbox.width * 0.3, y: cbox.y + cbox.height * 0.66 },
          { x: cbox.x + cbox.width * 0.68, y: cbox.y + cbox.height * 0.5 },
        ];
        for (const p of pts) {
          await moveCursor(page, p.x, p.y, 520);
          await rippleCursor(page);
        }
      }

      await injectBcAndLoads(page);
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

      await clickWithCursor(
        page,
        page
          .locator("nav")
          .getByRole("button")
          .filter({ hasText: "Constraints" }),
      );
      await Promise.race([
        expect(page.getByText("Fixed displacement")).toBeVisible({
          timeout: 15_000,
        }),
        fatalError,
      ]);
      await page.waitForTimeout(1600);

      // 4. Solve and read the results — the MFEM solve runs in realtime.
      await clickWithCursor(
        page,
        page.locator("nav").getByRole("button").filter({ hasText: "Solve" }),
      );
      await Promise.race([
        page.waitForFunction(
          () =>
            typeof (window as unknown as { __kofemTriggerSolve?: () => void })
              .__kofemTriggerSolve === "function",
          { timeout: 15_000 },
        ),
        fatalError,
      ]);
      await page.waitForTimeout(800);
      await page.evaluate(() => {
        (
          window as unknown as { __kofemTriggerSolve?: () => void }
        ).__kofemTriggerSolve?.();
      });
      await Promise.race([
        expect(page.getByText("Result summary")).toBeVisible({
          timeout: 240_000,
        }),
        fatalError,
      ]);
      // Hold on the coloured result so the video ends on the payoff.
      await page.waitForTimeout(2600);

      const video = page.video();
      await page.close();
      await context.close();
      if (video) {
        await video.saveAs(VIDEO_OUT);
        savedPath = VIDEO_OUT;
        await video.delete();
      }
    } finally {
      if (!context.pages().every((p) => p.isClosed())) {
        await context.close().catch(() => {});
      }
    }

    if (!savedPath || !fs.existsSync(savedPath)) {
      throw new Error("walkthrough video was not written");
    }
    expect(fs.statSync(savedPath).size).toBeGreaterThan(10_000);
  });
});

// Fix the three bolt holes (all DOFs) and load the hub bore downward, by
// gathering nodes per OCC face from the mesher-tagged surface triangulation.
async function injectBcAndLoads(page: Page): Promise<void> {
  await page.evaluate(
    ({ holeFaces, tubeFaces }) => {
      type FaceEntry = { label: string; nodeIds: number[] };
      const store = (
        window as unknown as {
          __kofemStore: {
            getState(): {
              surfaceTriangles: [number, number, number][] | null;
              surfaceFaceIds: number[] | null;
              createBcGroup(f: FaceEntry[], dofs: number[], v: number): void;
              createLoadGroup(f: FaceEntry[], dof: number, force: number): void;
            };
          };
        }
      ).__kofemStore;
      const { surfaceTriangles, surfaceFaceIds } = store.getState();
      if (!surfaceTriangles || !surfaceFaceIds) {
        throw new Error("surface face data missing — STEP mesh required");
      }
      const nodesOf = (faces: number[]): number[] => {
        const want = new Set(faces);
        const ids = new Set<number>();
        for (let t = 0; t < surfaceTriangles.length; t++) {
          if (want.has(surfaceFaceIds[t]))
            for (const v of surfaceTriangles[t]) ids.add(v);
        }
        return [...ids];
      };
      store.getState().createBcGroup(
        holeFaces.map((f, i) => ({
          label: `Hole ${i + 1}`,
          nodeIds: nodesOf([f]),
        })),
        [0, 1, 2],
        0,
      );
      // dof 1 = Uy; negative force pulls the hub down.
      store
        .getState()
        .createLoadGroup(
          [{ label: "Hub bore", nodeIds: nodesOf(tubeFaces) }],
          1,
          -5000,
        );
    },
    { holeFaces: HOLE_FACES, tubeFaces: TUBE_FACES },
  );
}
