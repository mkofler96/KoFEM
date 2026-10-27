// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// First-load benchmark of the solver app (KOF-263): what a visitor downloads
// and waits for before they can import a model, on a cold and a warm cache,
// under emulated network and CPU conditions.
//
//   node scripts/measure-first-load.mjs [options]
//
//   --url <app url>        default http://localhost:4193/app/
//   --profiles <a,b,…>     default desktop,fast4g,slow4g,lowend (see PROFILES)
//   --runs <n>             cold+warm pairs per profile, default 1
//   --think <s>            seconds the visitor takes to pick a file after the
//                          workspace appears, default 0 (picks it at once)
//   --cap <s>              give up on one load after this long, default 300
//   --json <file>          also write every sample as JSON
//   --chrome <path>        Chromium executable, default Playwright's own
//
// Measure what ships: a production build (`bun run build`) served the way the
// deployment serves it. `vite preview` does NOT compress application/wasm
// (its compression middleware only matches text/JS/JSON/XML), so against it the
// engine travels raw (~35 MB) instead of gzipped (9.0 MB). Serve dist/ with the
// production nginx config, after the Dockerfile's gzip -9 step over
// dist/assets, for representative transfer numbers:
//
//   docker run --rm --network host -e PORT=4193 \
//     -v "$PWD/dist:/usr/share/nginx/html:ro" \
//     -v "$PWD/nginx.conf.template:/etc/nginx/templates/default.conf.template:ro" \
//     nginx:alpine   # the digest pinned in web/Dockerfile
//
// Cold = a fresh browser profile (empty HTTP and code cache). Warm = the same
// profile relaunched, i.e. a returning visitor. Each load imports
// tests/fixtures/tube.stp through the Geometry panel as soon as the workspace is
// on screen (plus --think), so "geometry" is the first moment a real model is
// visible. Engine timings come from the solver worker's own messages, observed
// by wrapping the Worker constructor; byte counts from Resource Timing in the
// page and in the worker (transferSize: 0 means served from cache).
//
// Caveats: CPU throttling (Emulation.setCPUThrottlingRate) slows the page's
// main thread; V8 compiles WebAssembly on background threads, which it does not
// slow, so the low-end profile understates engine compile time on a real slow
// device. Headless Chromium renders WebGL in software (SwiftShader).

import { chromium } from "@playwright/test";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir, loadavg, cpus } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// Throughput in bytes/s as CDP expects; latency is the added round-trip time.
const mbps = (megabits) => (megabits * 1e6) / 8;
const PROFILES = {
  desktop: { label: "Desktop, unthrottled", network: null, cpu: 1 },
  fast4g: {
    label: "Fast 4G (9 Mbps, 150 ms RTT)",
    network: { down: mbps(9), up: mbps(1.5), latency: 150 },
    cpu: 1,
  },
  slow4g: {
    label: "Slow 4G / 3G (1.6 Mbps, 300 ms RTT)",
    network: { down: mbps(1.6), up: mbps(0.75), latency: 300 },
    cpu: 1,
  },
  lowend: { label: "Low-end CPU (4× slowdown)", network: null, cpu: 4 },
};

function parseArgs(argv) {
  const opts = {
    url: "http://localhost:4193/app/",
    profiles: Object.keys(PROFILES),
    runs: 1,
    think: 0,
    cap: 300,
    json: null,
    chrome: undefined,
  };
  for (let i = 0; i < argv.length; i += 2) {
    const [flag, value] = [argv[i], argv[i + 1]];
    if (value === undefined) throw new Error(`${flag} needs a value`);
    if (flag === "--url") opts.url = value;
    else if (flag === "--profiles") opts.profiles = value.split(",");
    else if (flag === "--runs") opts.runs = Number(value);
    else if (flag === "--think") opts.think = Number(value);
    else if (flag === "--cap") opts.cap = Number(value);
    else if (flag === "--json") opts.json = value;
    else if (flag === "--chrome") opts.chrome = value;
    else throw new Error(`Unknown option ${flag}`);
  }
  for (const name of opts.profiles)
    if (!PROFILES[name])
      throw new Error(
        `Unknown profile "${name}" — one of ${Object.keys(PROFILES).join(", ")}`,
      );
  return opts;
}

const FIXTURE = fileURLToPath(
  new URL("../tests/fixtures/tube.stp", import.meta.url),
);

// Runs in the page before any app code: timestamps for the worker's life and
// the engine messages it posts. Works against builds before and after KOF-263 —
// the old worker posts {engineInitMs}, the new one {engineStatus}.
function instrumentWorkers() {
  const marks = { workers: [], ready: [], failed: [], phases: [] };
  window.__loadMarks = marks;
  const NativeWorker = window.Worker;
  window.Worker = class extends NativeWorker {
    constructor(...args) {
      super(...args);
      marks.workers.push(performance.now());
      this.addEventListener("message", (event) => {
        const data = event.data ?? {};
        const status = data.engineStatus;
        if (data.engineInitMs !== undefined)
          marks.ready.push({
            at: performance.now(),
            initMs: data.engineInitMs,
          });
        if (status?.phase === "ready")
          marks.ready.push({ at: performance.now(), ...status });
        if (status?.phase === "failed")
          marks.failed.push({ at: performance.now(), ...status });
        if (status && status.phase !== "downloading")
          marks.phases.push({ at: performance.now(), phase: status.phase });
      });
    }
  };
}

const sum = (list, key) => list.reduce((acc, entry) => acc + entry[key], 0);
const MB = 1e6;

// Resident memory of the renderer process(es) under this browser — page,
// worker, engine and its compiled code together. Linux only (/proc).
function rendererRssMB(userDataDir) {
  if (process.platform !== "linux") return null;
  const procs = new Map();
  for (const pid of readdirSync("/proc").filter((name) => /^\d+$/.test(name))) {
    let cmd, status;
    try {
      cmd = readFileSync(`/proc/${pid}/cmdline`, "utf8").replaceAll("\0", " ");
      status = readFileSync(`/proc/${pid}/status`, "utf8");
    } catch {
      continue; // exited while we looked
    }
    const ppid = Number(/PPid:\s+(\d+)/.exec(status)[1]);
    const rss = /VmRSS:\s+(\d+) kB/.exec(status);
    procs.set(Number(pid), { ppid, cmd, rss: rss ? Number(rss[1]) * 1024 : 0 });
  }
  const root = [...procs].find(
    ([, proc]) =>
      proc.cmd.includes(`--user-data-dir=${userDataDir}`) &&
      !proc.cmd.includes("--type="),
  );
  if (!root) return null;
  const tree = new Set([root[0]]);
  for (let grew = true; grew;) {
    grew = false;
    for (const [pid, proc] of procs)
      if (!tree.has(pid) && tree.has(proc.ppid)) {
        tree.add(pid);
        grew = true;
      }
  }
  let bytes = 0;
  for (const pid of tree)
    if (procs.get(pid).cmd.includes("--type=renderer"))
      bytes += procs.get(pid).rss;
  return bytes / MB;
}

async function oneLoad(context, profile, opts, userDataDir) {
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  await cdp.send("Network.enable");
  if (profile.network)
    await cdp.send("Network.emulateNetworkConditions", {
      offline: false,
      latency: profile.network.latency,
      downloadThroughput: profile.network.down,
      uploadThroughput: profile.network.up,
    });
  // The page's network emulation also throttles its dedicated worker's
  // fetches: the engine download takes size / bandwidth in every profile.
  if (profile.cpu !== 1)
    await cdp.send("Emulation.setCPUThrottlingRate", { rate: profile.cpu });

  const capMs = opts.cap * 1000;
  const sample = { error: null };
  try {
    await page.goto(opts.url, { waitUntil: "commit", timeout: capMs });
    // The model tree and the import card are what the visitor acts on.
    const workspace = await page.waitForFunction(
      () =>
        document.querySelector("nav") &&
        document.querySelector('input[type="file"][accept=".stp,.step"]') &&
        performance.now(),
      null,
      { polling: "raf", timeout: capMs },
    );
    sample.workspaceMs = await workspace.jsonValue();
    sample.fcpMs = await page.evaluate(
      () =>
        performance.getEntriesByName("first-contentful-paint")[0]?.startTime ??
        null,
    );
    if (opts.think > 0) await page.waitForTimeout(opts.think * 1000);
    sample.pickMs = await page.evaluate(() => performance.now());
    await page
      .locator('input[type="file"][accept=".stp,.step"]')
      .setInputFiles(FIXTURE);
    const geometry = await page.waitForFunction(
      () =>
        [...document.querySelectorAll("button")].some((btn) =>
          btn.textContent?.includes("Mesh STEP volume"),
        ) && performance.now(),
      null,
      { polling: "raf", timeout: capMs },
    );
    sample.geometryMs = await geometry.jsonValue();
    const marks = await page.evaluate(() => window.__loadMarks);
    const ready = marks.ready[0];
    sample.workerCreatedMs = marks.workers[0] ?? null;
    sample.engineReadyMs = ready?.at ?? null;
    sample.engineInitMs = ready?.initMs ?? null;
    sample.downloadMs = ready?.downloadMs ?? null;
    sample.compileMs = ready?.compileMs ?? null;
    sample.wasmMemoryMB =
      ready?.memoryBytes !== undefined ? ready.memoryBytes / MB : null;

    // Bytes on the wire, page and worker. The engine is fetched by the worker.
    const pageEntries = await page.evaluate(() =>
      performance
        .getEntriesByType("navigation")
        .concat(performance.getEntriesByType("resource"))
        .map((entry) => ({
          name: entry.name,
          transferSize: entry.transferSize,
          encodedBodySize: entry.encodedBodySize,
          decodedBodySize: entry.decodedBodySize,
          start: entry.startTime,
          end: entry.responseEnd,
        })),
    );
    const workerEntries = [];
    for (const worker of page.workers())
      workerEntries.push(
        ...(await worker.evaluate(() =>
          performance.getEntriesByType("resource").map((entry) => ({
            name: entry.name,
            transferSize: entry.transferSize,
            encodedBodySize: entry.encodedBodySize,
            decodedBodySize: entry.decodedBodySize,
            start: entry.startTime,
            end: entry.responseEnd,
          })),
        )),
      );
    const all = pageEntries.concat(workerEntries);
    const wasm = all.filter((entry) => entry.name.endsWith(".wasm"));
    sample.transferMB = sum(all, "transferSize") / MB;
    sample.wasmTransferMB = wasm.length ? sum(wasm, "transferSize") / MB : 0;
    sample.wasmDecodedMB = wasm.length ? sum(wasm, "decodedBodySize") / MB : 0;
    sample.wasmFetchMs = wasm.length ? wasm[0].end - wasm[0].start : null;
    const jsEntries = all.filter((entry) => /\.(js|css)$/.test(entry.name));
    sample.jsCssTransferMB = sum(jsEntries, "transferSize") / MB;

    const metrics = await cdp
      .send("Performance.enable")
      .then(() => cdp.send("Performance.getMetrics"));
    const metric = (name) =>
      metrics.metrics.find((entry) => entry.name === name)?.value ?? null;
    sample.mainHeapMB = metric("JSHeapUsedSize") / MB;
    sample.rendererRssMB = rendererRssMB(userDataDir);

    // A fresh worker after resetWorker() — the restart every mesh pays.
    const restart = await page.evaluate(async () => {
      const kofem = window.__kofem;
      const marks = window.__loadMarks;
      const before = marks.ready.length;
      const t0 = performance.now();
      kofem.resetWorker();
      await kofem.sendToWorker("init", null).catch(() => {});
      while (marks.ready.length === before)
        await new Promise((resolve) => setTimeout(resolve, 20));
      return performance.now() - t0;
    });
    sample.restartMs = restart;
  } catch (err) {
    sample.error = String(err.message ?? err).split("\n")[0];
  }
  await page.close();
  return sample;
}

async function runProfile(name, opts) {
  const profile = PROFILES[name];
  const samples = [];
  for (let run = 0; run < opts.runs; run++) {
    const userDataDir = mkdtempSync(join(tmpdir(), "kofem-first-load-"));
    const launch = () =>
      chromium.launchPersistentContext(userDataDir, {
        headless: true,
        executablePath: opts.chrome,
        viewport: { width: 1440, height: 900 },
      });
    for (const cache of ["cold", "warm"]) {
      const context = await launch();
      await context.addInitScript(instrumentWorkers);
      const sample = await oneLoad(context, profile, opts, userDataDir);
      await context.close();
      samples.push({ profile: name, cache, run, ...sample });
      console.error(
        `${name} ${cache} #${run + 1}: ${sample.error ?? `geometry at ${(sample.geometryMs / 1000).toFixed(1)} s`}`,
      );
    }
    rmSync(userDataDir, { recursive: true, force: true });
  }
  return samples;
}

const median = (values) => {
  const sorted = values
    .filter((v) => v !== null && v !== undefined)
    .sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};

const secs = (ms) => (ms === null ? "–" : `${(ms / 1000).toFixed(2)} s`);
const mb = (value) => (value === null ? "–" : `${value.toFixed(2)} MB`);

function table(samples, opts) {
  const columns = [
    ["Transferred", (rows) => mb(median(rows.map((r) => r.transferMB)))],
    ["of it engine", (rows) => mb(median(rows.map((r) => r.wasmTransferMB)))],
    ["Workspace", (rows) => secs(median(rows.map((r) => r.workspaceMs)))],
    ["Engine ready", (rows) => secs(median(rows.map((r) => r.engineReadyMs)))],
    ["engine fetch", (rows) => secs(median(rows.map((r) => r.wasmFetchMs)))],
    ["engine init", (rows) => secs(median(rows.map((r) => r.engineInitMs)))],
    ["First geometry", (rows) => secs(median(rows.map((r) => r.geometryMs)))],
    ["Worker restart", (rows) => secs(median(rows.map((r) => r.restartMs)))],
    ["Main JS heap", (rows) => mb(median(rows.map((r) => r.mainHeapMB)))],
    ["WASM memory", (rows) => mb(median(rows.map((r) => r.wasmMemoryMB)))],
    ["Renderer RSS", (rows) => mb(median(rows.map((r) => r.rendererRssMB)))],
  ];
  const lines = [
    `| Profile | Cache | ${columns.map(([title]) => title).join(" | ")} |`,
    `|---|---|${columns.map(() => "---").join("|")}|`,
  ];
  for (const name of opts.profiles)
    for (const cache of ["cold", "warm"]) {
      const rows = samples.filter(
        (s) => s.profile === name && s.cache === cache && !s.error,
      );
      const failed = samples.filter(
        (s) => s.profile === name && s.cache === cache && s.error,
      );
      const cells = rows.length
        ? columns.map(([, cell]) => cell(rows))
        : columns.map(() => "–");
      const note = failed.length
        ? ` (${failed.length} failed: ${failed[0].error})`
        : "";
      lines.push(
        `| ${PROFILES[name].label}${note} | ${cache} | ${cells.join(" | ")} |`,
      );
    }
  return lines.join("\n");
}

const opts = parseArgs(process.argv.slice(2));
if (!existsSync(FIXTURE)) throw new Error(`Fixture missing: ${FIXTURE}`);
const startedAt = new Date().toISOString();
const load = loadavg()
  .map((v) => v.toFixed(2))
  .join(" ");
const samples = [];
for (const name of opts.profiles)
  samples.push(...(await runProfile(name, opts)));
console.log(
  `First load of ${opts.url} — ${startedAt}, ${opts.runs} run(s) per profile ` +
    `(median), think time ${opts.think} s, ${cpus().length} CPUs, load avg ${load}\n`,
);
console.log(table(samples, opts));
if (opts.json)
  writeFileSync(
    opts.json,
    JSON.stringify({ startedAt, opts, samples }, null, 2),
  );
