/**
 * Record your own KoFEM walkthrough by hand.
 *
 * Opens a real, headed browser pointed at the running app and records
 * everything you do into a WebM, so you can drive the analysis yourself —
 * import, mesh, pick faces, solve — instead of the scripted capture. A live
 * cursor overlay tracks your mouse and pulses on each click so they show up in
 * the video (Playwright records the page surface, not the OS pointer).
 *
 * Usage (run on your own machine, where you have a display):
 *
 *   1. One-time:          bunx playwright install chromium   (or use CHANNEL=chrome)
 *   2. In one terminal:   bun run dev
 *   3. In another:        bun run record:video
 *   4. Drive the app in the window that opens.
 *   5. Press Enter in the terminal (or close the window) to stop.
 *
 * The video is written to web/public/tutorial/walkthrough.webm by default — the
 * exact path index.html embeds — so your recording drops straight into the
 * landing page. Override with env vars:
 *
 *   URL=http://localhost:4173/app/   target a different server (e.g. preview)
 *   OUT=public/tutorial/my-clip.webm output path
 *   SIZE=1600x1000                   viewport / video size (default 1280x800)
 *   CHANNEL=chrome                   use your installed Chrome/Edge instead of
 *                                    Playwright's bundled Chromium
 *   NO_CURSOR=1                      disable the live cursor overlay
 */
import { chromium } from "@playwright/test";
import path from "path";
import fs from "fs";
import { installLiveCursor } from "../tests/fixtures/cursor";

const URL = process.env.URL ?? "http://localhost:5173/app/";
const OUT = path.resolve(process.env.OUT ?? "public/tutorial/walkthrough.webm");
const [w, h] = (process.env.SIZE ?? "1280x800").split("x").map(Number);
const SIZE = { width: w || 1280, height: h || 800 };

async function main(): Promise<void> {
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  const recordDir = path.join(path.dirname(OUT), ".record-tmp");

  const browser = await chromium.launch({
    headless: false,
    ...(process.env.CHANNEL ? { channel: process.env.CHANNEL } : {}),
  });
  const context = await browser.newContext({
    viewport: SIZE,
    recordVideo: { dir: recordDir, size: SIZE },
  });
  const page = await context.newPage();
  if (!process.env.NO_CURSOR) await installLiveCursor(page);

  console.log(`\n▶  Recording. Opening ${URL}`);
  try {
    await page.goto(URL, { timeout: 15_000 });
  } catch {
    console.error(
      `\n✗  Could not reach ${URL}. Start the app first (e.g. \`bun run dev\`),\n` +
        `   or set URL=… to point at your server. Closing.\n`,
    );
    await context.close();
    await browser.close();
    process.exit(1);
  }

  console.log(
    "   Drive the app in the browser window.\n" +
      "   Press Enter here (or close the window) to stop and save.\n",
  );

  // Stop on either an Enter keypress in the terminal or the window closing.
  await new Promise<void>((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      process.stdin.pause();
      resolve();
    };
    process.stdin.resume();
    process.stdin.once("data", finish);
    page.once("close", finish);
    context.once("close", finish);
  });

  const video = page.video();
  // Close the page/context so Playwright finalises the recording, then move it
  // to the requested path.
  await context.close();
  await browser.close();

  if (video) {
    await video.saveAs(OUT);
    console.log(`\n✓  Saved ${path.relative(process.cwd(), OUT)}`);
  } else {
    console.error("\n✗  No video was recorded.");
  }
  fs.rmSync(recordDir, { recursive: true, force: true });
  process.exit(0);
}

main();
