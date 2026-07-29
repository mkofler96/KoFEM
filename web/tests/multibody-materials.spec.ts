// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Per-body material assignment UI (issue #353): importing a two-body assembly
// lists one body per solid, each with a material colour swatch, a material
// dropdown, and an eye control to hide it; hovering a body highlights it.

import { test, expect } from "./coverage";
import path from "path";
import { importStep } from "./fixtures/app";

interface Store {
  getState(): {
    properties: {
      id: number;
      materialId: number;
      sourceBodyId?: number;
    }[];
    materials: { id: number; name: string; color: string }[];
    highlightBodyId: number | null;
    hiddenBodyIds: number[];
    tieDistance: number;
    viewRepr: string;
    nodes: unknown[];
  };
}
const store = (page: import("@playwright/test").Page) =>
  page.evaluate(() =>
    (window as unknown as { __kofemStore: Store }).__kofemStore.getState(),
  );

// Fraction of the viewport covered by opaquely drawn geometry. The WebGL canvas
// clears to transparent (the light background is CSS), so alpha alone separates
// what is drawn from what is not — and a body dimmed to DIMMED_OPACITY lands far
// below the 0.5 cutoff. preserveDrawingBuffer is on (Viewport.tsx), so the
// buffer is still readable after the frame.
const drawnFraction = (page: import("@playwright/test").Page) =>
  page.evaluate(() => {
    const canvas = document.querySelector("canvas");
    if (!canvas) throw new Error("viewport canvas not mounted");
    const copy = document.createElement("canvas");
    copy.width = canvas.width;
    copy.height = canvas.height;
    const ctx = copy.getContext("2d");
    if (!ctx) throw new Error("2d context unavailable for canvas readback");
    ctx.drawImage(canvas, 0, 0);
    const { data } = ctx.getImageData(0, 0, copy.width, copy.height);
    let opaque = 0;
    for (let i = 3; i < data.length; i += 4) if (data[i] > 128) opaque++;
    return opaque / (copy.width * copy.height);
  });

// Playwright runs from web/; test_files sits one level up (see screenshot.spec).
const TWO_BOXES = path.resolve("..", "test_files", "two_boxes.stp");
// A solid base plus a 2 mm fin: auto-shell idealises the fin at mesh time, so
// the meshed model carries a derived PSHELL property alongside the two CAD
// bodies — the case the highlight has to resolve back to a tessellated body.
const FIN_TWO_PARTS = path.resolve("..", "test_files", "fin_two_parts.step");

test("two-body assembly lists per-body materials with colours", async ({
  page,
}) => {
  await importStep(page, TWO_BOXES);

  // One property (body) per solid, each defaulting to the sole material.
  const state = await store(page);
  expect(state.properties).toHaveLength(2);
  expect(state.properties.map((p) => p.id).sort()).toEqual([1, 2]);

  // Both body rows render with a material dropdown.
  await expect(page.getByTestId("body-material-1")).toBeVisible();
  await expect(page.getByTestId("body-material-2")).toBeVisible();
});

test("hovering a body highlights it; the eye hides it", async ({ page }) => {
  await importStep(page, TWO_BOXES);

  const body2Row = page
    .getByTestId("body-material-2")
    .locator("xpath=ancestor::div[1]");

  // Hover → the body is highlighted in the store (viewport dims the others).
  await body2Row.hover();
  await expect.poll(async () => (await store(page)).highlightBodyId).toBe(2);

  // Eye toggle hides the body, and clicking again shows it.
  await page.getByTestId("body-visibility-2").click();
  await expect.poll(async () => (await store(page)).hiddenBodyIds).toEqual([2]);
  await page.getByTestId("body-visibility-2").click();
  await expect.poll(async () => (await store(page)).hiddenBodyIds).toEqual([]);
});

// Hovering a body row used to make the whole model disappear on an assembly
// with a shell-idealised body. Two faults compounded: the panel wrote viewRepr
// straight to the store, so the first hover permanently swapped the mesh for
// the CAD tessellation; and the highlight ("dim every body except this one")
// was handed the id of the derived PSHELL, which no tessellated body carries,
// so every body dimmed to DIMMED_OPACITY and nothing was left to look at.
test("hovering a body never blanks the viewport or changes the representation", async ({
  page,
}) => {
  test.setTimeout(240_000);
  await importStep(page, FIN_TWO_PARTS);

  await page
    .getByRole("button")
    .filter({ hasText: "Mesh STEP volume" })
    .click();
  await expect
    .poll(async () => (await store(page)).nodes.length, { timeout: 180_000 })
    .toBeGreaterThan(0);

  // Auto-shell replaced the fin's tets with a PSHELL carrying a fresh id; it
  // points back at the CAD body it was idealised from, which is what the
  // geometry view can actually highlight.
  const meshed = await store(page);
  const shellProp = meshed.properties.find((p) => p.sourceBodyId !== undefined);
  if (!shellProp)
    throw new Error(
      `no derived PSHELL property after meshing the fin assembly: ${JSON.stringify(meshed.properties)}`,
    );
  expect(shellProp.sourceBodyId).toBe(2);

  const repr = meshed.viewRepr;
  const baseline = await drawnFraction(page);
  expect(baseline).toBeGreaterThan(0.05);

  const rows = page.locator('[data-testid^="body-material-"]');
  const rowCount = await rows.count();
  expect(rowCount).toBe(meshed.properties.length);

  for (let i = 0; i < rowCount; i++) {
    await rows.nth(i).locator("xpath=ancestor::div[1]").hover();
    await expect
      .poll(async () => (await store(page)).highlightBodyId)
      .not.toBeNull();
    // The highlight dims the bodies around the hovered one, so the drawn area
    // shrinks — but the model stays plainly on screen. Before the fix the
    // PSHELL row left under 2 % of the baseline: an empty viewport.
    await expect
      .poll(async () => drawnFraction(page))
      .toBeGreaterThan(baseline * 0.2);
    // The highlight is a transient override, never a stored preference.
    expect((await store(page)).viewRepr).toBe(repr);
  }

  // Pointer off the list → the representation and the full model come back.
  await page.mouse.move(0, 0);
  await expect.poll(async () => (await store(page)).highlightBodyId).toBeNull();
  await expect
    .poll(async () => drawnFraction(page))
    .toBeGreaterThan(baseline * 0.95);
  expect((await store(page)).viewRepr).toBe(repr);
});

test("the bonded tie distance is editable for multibody assemblies", async ({
  page,
}) => {
  await importStep(page, TWO_BOXES);

  const tie = page.getByTestId("tie-distance");
  await expect(tie).toBeVisible();
  await expect.poll(async () => (await store(page)).tieDistance).toBe(0);

  await tie.fill("2");
  await expect.poll(async () => (await store(page)).tieDistance).toBe(2);
});

test("adding a material auto-assigns a distinct colour", async ({ page }) => {
  await importStep(page, TWO_BOXES);

  const before = await store(page);
  const firstColor = before.materials[0].color;

  await page.getByTestId("add-material").click();
  // The new material's colour picker is pre-filled with a palette colour that
  // differs from the existing material.
  const colorInput = page.getByTestId("material-color");
  await expect(colorInput).toBeVisible();
  const picked = await colorInput.inputValue();
  expect(picked.toLowerCase()).not.toBe(firstColor.toLowerCase());

  // Save it (scoped to the material form — the app chrome has its own Save),
  // then assign body 2 to it and confirm the mapping changed.
  const form = colorInput.locator(
    "xpath=ancestor::div[contains(@class,'inlineForm')]",
  );
  await form.getByRole("button", { name: "Save" }).click();
  const after = await store(page);
  expect(after.materials).toHaveLength(2);

  await page
    .getByTestId("body-material-2")
    .selectOption(String(after.materials[1].id));
  const assigned = await store(page);
  expect(assigned.properties.find((p) => p.id === 2)?.materialId).toBe(
    after.materials[1].id,
  );
});
