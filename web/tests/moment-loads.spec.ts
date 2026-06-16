import { test, expect } from "./coverage";

// Helper: dismiss the welcome screen by loading the built-in example
async function startExample(page: import("@playwright/test").Page) {
  await page.goto("/");
  await page.getByRole("button", { name: "Start with example" }).click();
  await expect(page.getByRole("button", { name: "Import STEP" })).toBeVisible();
}

type Store = {
  getState(): {
    nodes: { id: number; x: number; y: number; z: number }[];
    loads: { nodeId: number; dof: number; value: number }[];
    clearLoads(): void;
    createLoadGroup(
      faces: { label: string; nodeIds: number[] }[],
      dof: number,
      totalForce: number,
    ): void;
  };
};

// ── Moment-load conversion math ───────────────────────────────────────────────

test("Mz moment produces tangential forces with zero net force and correct net moment", async ({
  page,
}) => {
  await startExample(page);

  const result = await page.evaluate(() => {
    const store = (window as unknown as { __kofemStore: Store }).__kofemStore;

    // End face of cantilever (x ≈ 1.0) — 9 nodes on a 3×3 grid
    const endNodes = store
      .getState()
      .nodes.filter((n) => Math.abs(n.x - 1.0) < 1e-9);
    store.getState().clearLoads();
    store.getState().createLoadGroup(
      [{ label: "End face", nodeIds: endNodes.map((n) => n.id) }],
      5, // Mz
      1000,
    );

    // Re-read loads from fresh state after mutations
    const loads = store.getState().loads;

    // Centroid of the face
    const cx = endNodes.reduce((s, n) => s + n.x, 0) / endNodes.length;
    const cy = endNodes.reduce((s, n) => s + n.y, 0) / endNodes.length;

    const nodeById = new Map(endNodes.map((n) => [n.id, n]));
    let netFx = 0,
      netFy = 0,
      netFz = 0,
      netMz = 0;
    for (const l of loads) {
      const n = nodeById.get(l.nodeId)!;
      const rx = n.x - cx,
        ry = n.y - cy;
      if (l.dof === 0) {
        netFx += l.value;
        netMz -= ry * l.value;
      }
      if (l.dof === 1) {
        netFy += l.value;
        netMz += rx * l.value;
      }
      if (l.dof === 2) netFz += l.value;
    }

    return { nodeCount: endNodes.length, netFx, netFy, netFz, netMz, loads };
  });

  expect(result.nodeCount).toBe(9); // 3×3 end face
  // All resulting loads must be force DOFs (0–2), not moment DOFs
  expect(result.loads.every((l) => l.dof <= 2)).toBe(true);
  // Net force must be zero (pure couple)
  expect(result.netFx).toBeCloseTo(0, 9);
  expect(result.netFy).toBeCloseTo(0, 9);
  expect(result.netFz).toBeCloseTo(0, 9);
  // Net moment about z must equal the applied moment exactly
  expect(result.netMz).toBeCloseTo(1000, 6);
});

test("Mx moment produces correct net moment about x and zero net force", async ({
  page,
}) => {
  await startExample(page);

  const result = await page.evaluate(() => {
    const store = (window as unknown as { __kofemStore: Store }).__kofemStore;

    const endNodes = store
      .getState()
      .nodes.filter((n) => Math.abs(n.x - 1.0) < 1e-9);
    store.getState().clearLoads();
    store.getState().createLoadGroup(
      [{ label: "End face", nodeIds: endNodes.map((n) => n.id) }],
      3, // Mx
      500,
    );

    const loads = store.getState().loads;
    const cy = endNodes.reduce((s, n) => s + n.y, 0) / endNodes.length;
    const cz = endNodes.reduce((s, n) => s + n.z, 0) / endNodes.length;

    const nodeById = new Map(endNodes.map((n) => [n.id, n]));
    let netFx = 0,
      netFy = 0,
      netFz = 0,
      netMx = 0;
    for (const l of loads) {
      const n = nodeById.get(l.nodeId)!;
      const ry = n.y - cy,
        rz = n.z - cz;
      if (l.dof === 0) netFx += l.value;
      if (l.dof === 1) {
        netFy += l.value;
        netMx -= rz * l.value;
      }
      if (l.dof === 2) {
        netFz += l.value;
        netMx += ry * l.value;
      }
    }

    return { netFx, netFy, netFz, netMx, loads };
  });

  expect(result.loads.every((l) => l.dof <= 2)).toBe(true);
  expect(result.netFx).toBeCloseTo(0, 9);
  expect(result.netFy).toBeCloseTo(0, 9);
  expect(result.netFz).toBeCloseTo(0, 9);
  expect(result.netMx).toBeCloseTo(500, 6);
});

test("My moment produces correct net moment about y and zero net force", async ({
  page,
}) => {
  await startExample(page);

  const result = await page.evaluate(() => {
    const store = (window as unknown as { __kofemStore: Store }).__kofemStore;

    const endNodes = store
      .getState()
      .nodes.filter((n) => Math.abs(n.x - 1.0) < 1e-9);
    store.getState().clearLoads();
    store.getState().createLoadGroup(
      [{ label: "End face", nodeIds: endNodes.map((n) => n.id) }],
      4, // My
      750,
    );

    const loads = store.getState().loads;
    const cx = endNodes.reduce((s, n) => s + n.x, 0) / endNodes.length;
    const cz = endNodes.reduce((s, n) => s + n.z, 0) / endNodes.length;

    const nodeById = new Map(endNodes.map((n) => [n.id, n]));
    let netFx = 0,
      netFy = 0,
      netFz = 0,
      netMy = 0;
    for (const l of loads) {
      const n = nodeById.get(l.nodeId)!;
      const rx = n.x - cx,
        rz = n.z - cz;
      if (l.dof === 0) {
        netFx += l.value;
        netMy += rz * l.value;
      }
      if (l.dof === 1) netFy += l.value;
      if (l.dof === 2) {
        netFz += l.value;
        netMy -= rx * l.value;
      }
    }

    return { netFx, netFy, netFz, netMy, loads };
  });

  expect(result.loads.every((l) => l.dof <= 2)).toBe(true);
  expect(result.netFx).toBeCloseTo(0, 9);
  expect(result.netFy).toBeCloseTo(0, 9);
  expect(result.netFz).toBeCloseTo(0, 9);
  expect(result.netMy).toBeCloseTo(750, 6);
});

// ── Solve integration ─────────────────────────────────────────────────────────

test("solve completes successfully when loads include a moment (Mz)", async ({
  page,
}) => {
  // Only treat errors from the app origin as fatal; ignore third-party
  // resource failures (e.g. font CDN SSL errors in the sandboxed environment).
  let _reject: ((e: Error) => void) | null = null;
  const fatal = new Promise<never>((_, rej) => {
    _reject = rej;
  });
  page.on("console", (msg) => {
    if (msg.type() === "error") {
      const text = msg.text();
      // Ignore external resource failures unrelated to the app
      if (
        text.includes("net::ERR_") ||
        text.includes("Failed to load resource")
      )
        return;
      _reject?.(new Error(`Browser error: ${text}`));
    }
  });
  page.on("pageerror", (err) => _reject?.(err));

  await startExample(page);

  // Replace the default Fy force load with a Mz moment load via the store
  await page.evaluate(() => {
    const store = (window as unknown as { __kofemStore: Store }).__kofemStore;
    const endNodes = store
      .getState()
      .nodes.filter((n) => Math.abs(n.x - 1.0) < 1e-9);
    store.getState().clearLoads();
    store.getState().createLoadGroup(
      [{ label: "End face", nodeIds: endNodes.map((n) => n.id) }],
      5, // Mz — 1 kN·m torsion at the free end
      1000,
    );
  });

  // Navigate to Solve panel and run
  await page
    .locator("nav")
    .getByRole("button")
    .filter({ hasText: "Solve" })
    .click();

  const solveBtn = page
    .getByRole("button")
    .filter({ hasText: "Run static solve" });
  await Promise.race([expect(solveBtn).toBeEnabled(), fatal]);
  await solveBtn.click();

  await Promise.race([
    expect(page.getByText(/Max \|U\|/)).toBeVisible({ timeout: 30_000 }),
    fatal,
  ]);
});
