import { test, expect } from "./coverage";
import path from "path";
import { importStep } from "./fixtures/app";

// Playwright is invoked from web/, so cwd is web/ and the STEP file lives one level up
const STEP_FILE = path.resolve("..", "test_files", "new_bracket_2.stp");

test("capture app after loading STEP file with fit view", async ({ page }) => {
  // Open the app and import the STEP file via the Geometry panel.
  await importStep(page, STEP_FILE, 30_000);

  // Fit all loaded geometry into the isometric view (HUD button in the viewport)
  await page.getByRole("button", { name: "Fit View" }).click();

  // Allow the camera reposition and a render frame to settle
  await page.waitForTimeout(500);

  const dataUrl = await page.evaluate(() => {
    const canvas = document.querySelector("canvas");
    return canvas ? canvas.toDataURL("image/png") : null;
  });
  if (dataUrl) {
    const fs = await import("fs");
    const base64 = dataUrl.replace(/^data:image\/png;base64,/, "");
    fs.writeFileSync(
      "screenshots/step-fit-view.png",
      Buffer.from(base64, "base64"),
    );
  }
});
