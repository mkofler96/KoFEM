import type { Page } from "@playwright/test";

// A synthetic on-screen cursor for capture videos. Playwright's recorder does
// not render the real pointer, so we inject a DOM element and choreograph it by
// hand: the video then shows where each click lands. Pure visual aid — actual
// interactions still go through Playwright's real mouse / locators.
const CURSOR_SCRIPT = `
(() => {
  const install = () => {
    if (window.__cursor) return;
    const wrap = document.createElement("div");
    wrap.style.cssText =
      "position:fixed;left:0;top:0;z-index:2147483647;pointer-events:none;" +
      "transform:translate(-50%,-50%);transition:none;will-change:left,top;";
    const dot = document.createElement("div");
    dot.style.cssText =
      "width:22px;height:22px;border-radius:50%;" +
      "background:rgba(74,124,255,0.35);border:2px solid #4a7cff;" +
      "box-shadow:0 0 0 4px rgba(74,124,255,0.18),0 2px 6px rgba(0,0,0,0.4);";
    const ring = document.createElement("div");
    ring.style.cssText =
      "position:absolute;left:50%;top:50%;width:22px;height:22px;border-radius:50%;" +
      "transform:translate(-50%,-50%) scale(1);border:2px solid #4a7cff;opacity:0;";
    wrap.appendChild(ring);
    wrap.appendChild(dot);
    const state = { x: window.innerWidth / 2, y: window.innerHeight / 2 };
    const apply = () => {
      wrap.style.left = state.x + "px";
      wrap.style.top = state.y + "px";
    };
    apply();
    const mount = () => document.body.appendChild(wrap);
    mount();

    window.__cursor = {
      moveTo(tx, ty, dur = 600) {
        return new Promise((resolve) => {
          const sx = state.x, sy = state.y;
          const t0 = performance.now();
          const ease = (p) => (p < 0.5 ? 2 * p * p : 1 - Math.pow(-2 * p + 2, 2) / 2);
          const step = (now) => {
            const p = Math.min(1, (now - t0) / dur);
            const e = ease(p);
            state.x = sx + (tx - sx) * e;
            state.y = sy + (ty - sy) * e;
            apply();
            if (p < 1) requestAnimationFrame(step);
            else resolve();
          };
          requestAnimationFrame(step);
        });
      },
      click() {
        return new Promise((resolve) => {
          dot.animate(
            [{ transform: "scale(1)" }, { transform: "scale(0.7)" }, { transform: "scale(1)" }],
            { duration: 320, easing: "ease-out" },
          );
          ring.style.opacity = "0.9";
          ring.animate(
            [
              { transform: "translate(-50%,-50%) scale(1)", opacity: 0.9 },
              { transform: "translate(-50%,-50%) scale(3.2)", opacity: 0 },
            ],
            { duration: 480, easing: "ease-out" },
          ).onfinish = () => {
            ring.style.opacity = "0";
            resolve();
          };
        });
      },
      pos() {
        return { x: state.x, y: state.y };
      },
    };
  };
  if (document.body) install();
  else document.addEventListener("DOMContentLoaded", install);
})();
`;

declare global {
  interface Window {
    __cursor?: {
      moveTo(x: number, y: number, dur?: number): Promise<void>;
      click(): Promise<void>;
      pos(): { x: number; y: number };
    };
    __liveCursor?: boolean;
  }
}

export async function installCursor(page: Page): Promise<void> {
  await page.addInitScript(CURSOR_SCRIPT);
}

// A live cursor overlay for manual screen recordings: the same dot, but it
// tracks the user's real mouse and pulses on every real click. Playwright's
// recordVideo captures the page surface without the OS pointer, so this makes
// the user's own clicks visible in a hand-driven recording (see
// scripts/record-walkthrough.ts).
const LIVE_CURSOR_SCRIPT = `
(() => {
  const install = () => {
    if (window.__liveCursor) return;
    window.__liveCursor = true;
    const wrap = document.createElement("div");
    wrap.style.cssText =
      "position:fixed;left:-100px;top:-100px;z-index:2147483647;" +
      "pointer-events:none;transform:translate(-50%,-50%);will-change:left,top;";
    const dot = document.createElement("div");
    dot.style.cssText =
      "width:20px;height:20px;border-radius:50%;" +
      "background:rgba(74,124,255,0.35);border:2px solid #4a7cff;" +
      "box-shadow:0 0 0 4px rgba(74,124,255,0.18),0 2px 6px rgba(0,0,0,0.4);";
    wrap.appendChild(dot);
    const mount = () => document.body.appendChild(wrap);
    mount();
    window.addEventListener(
      "mousemove",
      (e) => {
        wrap.style.left = e.clientX + "px";
        wrap.style.top = e.clientY + "px";
      },
      true,
    );
    window.addEventListener(
      "mousedown",
      (e) => {
        const ring = document.createElement("div");
        ring.style.cssText =
          "position:fixed;left:" + e.clientX + "px;top:" + e.clientY + "px;" +
          "z-index:2147483647;pointer-events:none;width:20px;height:20px;" +
          "border-radius:50%;border:2px solid #4a7cff;" +
          "transform:translate(-50%,-50%) scale(1);";
        document.body.appendChild(ring);
        ring.animate(
          [
            { transform: "translate(-50%,-50%) scale(1)", opacity: 0.9 },
            { transform: "translate(-50%,-50%) scale(3.4)", opacity: 0 },
          ],
          { duration: 520, easing: "ease-out" },
        ).onfinish = () => ring.remove();
      },
      true,
    );
  };
  if (document.body) install();
  else document.addEventListener("DOMContentLoaded", install);
})();
`;

export async function installLiveCursor(page: Page): Promise<void> {
  await page.addInitScript(LIVE_CURSOR_SCRIPT);
}

// Glide the synthetic cursor to a point (does not interact).
export async function moveCursor(
  page: Page,
  x: number,
  y: number,
  dur = 600,
): Promise<void> {
  await page.evaluate(({ x, y, dur }) => window.__cursor?.moveTo(x, y, dur), {
    x,
    y,
    dur,
  });
}

// Play the click ripple at the cursor's current position.
export async function rippleCursor(page: Page): Promise<void> {
  await page.evaluate(() => window.__cursor?.click());
  await page.waitForTimeout(420);
}

// Move the cursor to a locator's centre, ripple, then perform the real click.
export async function clickWithCursor(
  page: Page,
  locator: import("@playwright/test").Locator,
): Promise<void> {
  const box = await locator.boundingBox();
  if (!box) throw new Error("clickWithCursor: target has no bounding box");
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await moveCursor(page, x, y);
  await rippleCursor(page);
  await locator.click();
}
