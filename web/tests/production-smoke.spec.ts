import { test, expect } from "@playwright/test";
import fs from "fs";
import { fileURLToPath } from "url";

// Build-time smoke test for the production bundle (run from the Docker builder
// stage via playwright.docker.config.ts, which serves `vite preview` over the
// already-built dist/). It guards the class of regression where fingerprinted
// assets — in particular the WASM binary referenced by the emcc loader — fail
// to resolve in a production build even though `bun run dev` works.

const STEP_FILE = fileURLToPath(new URL("./fixtures/tube.stp", import.meta.url));

test("production bundle boots and runs the WASM pipeline end-to-end", async ({
  page,
}) => {
  test.setTimeout(120_000);

  // Any 4xx/5xx or transport failure on a fingerprinted asset (JS chunk, CSS,
  // worker, or the .wasm binary) means the build is mis-wired — fail loudly.
  const badRequests: string[] = [];
  page.on("response", (r) => {
    if (r.status() >= 400 && r.url().includes("/assets/"))
      badRequests.push(`HTTP ${r.status()} ${r.url()}`);
  });
  page.on("requestfailed", (r) => {
    if (r.url().includes("/assets/"))
      badRequests.push(`FAILED ${r.failure()?.errorText} ${r.url()}`);
  });

  await page.goto("/app/", { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => !!(window as Window & { __kofem?: unknown }).__kofem, {
    timeout: 30_000,
  });

  // Drive the real pipeline in the worker: STEP bytes → OCCT tessellation →
  // Netgen volume mesh. Reaching non-empty mesh output proves the .wasm binary
  // was fetched, instantiated, and executed in the production build.
  const stepBytes = Array.from(fs.readFileSync(STEP_FILE));
  const result = (await page.evaluate(async (bytes) => {
    const k = (window as Window & {
      __kofem: { sendToWorker: (t: string, p: unknown) => Promise<unknown> };
    }).__kofem;
    await k.sendToWorker("parse_step", { bytes: new Uint8Array(bytes) });
    return k.sendToWorker("test_generate_fem_mesh", {});
  }, stepBytes)) as { nodes: number; elements: number; durationMs: number };

  expect(result.nodes).toBeGreaterThan(0);
  expect(result.elements).toBeGreaterThan(0);
  expect(badRequests, `Failed asset requests:\n${badRequests.join("\n")}`).toEqual(
    [],
  );
});
