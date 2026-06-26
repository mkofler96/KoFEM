// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

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
//   bun run capture:tutorial
//
// Models the Wall Bracket: the three mounting-bolt holes are fixed and a
// downward load is applied to the cylindrical hub ("the tube"). Faces are
// selected by their OCC face index (1-based, from Netgen's STEP integration),
// which is stable across mesh densities for a given STEP file:
//   HOLE_FACES — the three bolt-hole bores (radius ~8 mm, on the mounting plate)
//   TUBE_FACES — the coaxial bore cylinders of the hub at the far end
const OUT_DIR = path.resolve("public", "tutorial");
const STEP_FILES_DIR = path.resolve("..", "test_files");
const BRACKET = path.join(STEP_FILES_DIR, "Wall Bracket.stp");
const HOLE_FACES = [34, 35, 36];
const TUBE_FACES = [3, 37];

test.describe("Tutorial figure capture", () => {
  test.beforeAll(() => {
    fs.mkdirSync(OUT_DIR, { recursive: true });
  });

  test.use({ viewport: { width: 1280, height: 820 } });

  test("full workflow → committed tutorial figures @capture", async ({
    page,
  }) => {
    test.setTimeout(600_000);

    if (!fs.existsSync(BRACKET)) {
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
        timeout: 180_000,
      }),
      meshErr.waitFor({ state: "visible", timeout: 180_000 }).then(async () => {
        throw new Error(
          `Volume meshing failed: ${await meshErr.textContent()}`,
        );
      }),
      fatalError,
    ]);
    await page.waitForTimeout(400);
    await shot("03-mesh.png");

    // 4. Constraints & loads — fix the three bolt holes, load the hub. Injected
    // through the store (the same path the showcase uses) so the capture does
    // not depend on interactive face-picking. Nodes are gathered per OCC face
    // from the surface triangulation the mesher tags with face indices.
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
                createLoadGroup(
                  f: FaceEntry[],
                  dof: number,
                  force: number,
                ): void;
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

    const bc = await page.evaluate(() => {
      const s = (
        window as unknown as {
          __kofemStore: {
            getState(): {
              constraints: unknown[];
              loads: unknown[];
              surfaceLoads: unknown[];
            };
          };
        }
      ).__kofemStore.getState();
      // Force loads now reach the solver as surface tractions, so count both.
      return {
        constraints: s.constraints.length,
        loads: s.loads.length + s.surfaceLoads.length,
      };
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
        timeout: 240_000,
      }),
      fatalError,
    ]);
    await page.waitForTimeout(600);
    await shot("05-results.png");
  });
});
