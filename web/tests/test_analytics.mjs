// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Unit tests for src/lib/analytics.ts — product events only ever reach gtag
// with consent, wait in memory while the banner is unanswered, carry no free
// text, and errors map to fixed categories. The consent loader itself is
// exercised in the browser by tests/analytics-consent.spec.ts.
//
// Run:  bun tests/test_analytics.mjs

import {
  CONSENT_EVENT,
  categorizeError,
  durationBucket,
  modelType,
  resetAnalyticsForTests,
  track,
  trackOnce,
} from "../src/lib/analytics.ts";

let failures = 0;
function check(name, cond, detail = "") {
  if (cond) {
    console.log(`  [PASS] ${name}`);
  } else {
    failures++;
    console.log(`  [FAIL] ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

// A window with just what the loader and the utility touch.
const sent = [];
const win = new EventTarget();
globalThis.window = win;
function setConsent(state) {
  if (state === undefined) delete win.__kofemAnalyticsConsent;
  else win.__kofemAnalyticsConsent = state;
  if (state === "granted")
    win.gtag = (command, name, params) => sent.push({ command, name, params });
  win.dispatchEvent(new CustomEvent(CONSENT_EVENT, { detail: state }));
}
function fresh(state) {
  resetAnalyticsForTests();
  delete win.gtag;
  sent.length = 0;
  setConsent(state);
}
const opened = { entry: "direct", duration_bucket: "1_5s" };

// ── Consent gating ───────────────────────────────────────────────────────────
{
  fresh("granted");
  track("solver_opened", opened);
  check(
    "granted: the event reaches gtag with its parameters",
    sent.length === 1 &&
      sent[0].command === "event" &&
      sent[0].name === "solver_opened" &&
      sent[0].params.entry === "direct",
    JSON.stringify(sent),
  );
}
{
  fresh("denied");
  track("solver_opened", opened);
  check(
    "denied: nothing is sent and gtag is never defined",
    sent.length === 0 && win.gtag === undefined,
  );
}
{
  fresh("disabled");
  track("solver_opened", opened);
  check("disabled (no measurement ID): nothing is sent", sent.length === 0);
}
{
  fresh(undefined);
  track("solver_opened", opened);
  track("geometry_import_success", {
    format: "step",
    duration_bucket: "lt_1s",
  });
  check(
    "pending: nothing is sent while the banner is unanswered",
    sent.length === 0 && win.gtag === undefined,
  );
  setConsent("granted");
  check(
    "pending → granted: queued events are sent in order",
    sent.map((e) => e.name).join() === "solver_opened,geometry_import_success",
    JSON.stringify(sent.map((e) => e.name)),
  );
}
{
  fresh(undefined);
  track("solver_opened", opened);
  setConsent("denied");
  setConsent("granted");
  check(
    "pending → denied: queued events are discarded, not sent on a later accept",
    sent.length === 0,
    JSON.stringify(sent),
  );
}
{
  fresh(undefined);
  for (let i = 0; i < 40; i++) track("results_viewed", { workflow: "example" });
  setConsent("granted");
  check(
    "pending queue is bounded",
    sent.length === 25,
    `${sent.length} events`,
  );
}
{
  fresh("granted");
  track("solver_opened", opened);
  setConsent("denied");
  track("solve_started", { workflow: "cad_import", analysis_type: "static" });
  check(
    "withdrawn: events after the withdrawal are not sent",
    sent.map((e) => e.name).join() === "solver_opened",
    JSON.stringify(sent.map((e) => e.name)),
  );
}
{
  fresh("granted");
  trackOnce("solver_opened", opened);
  trackOnce("solver_opened", opened);
  check("trackOnce sends once per page", sent.length === 1);
}

// ── No free text leaves the page ─────────────────────────────────────────────
{
  fresh("granted");
  const errors = [];
  const original = console.error;
  console.error = (msg) => errors.push(msg);
  track("example_loaded", {
    example_id: "C:\\Users\\me\\bracket v2.step",
    duration_bucket: "lt_1s",
  });
  track("example_load_failed", {
    example_id: "x".repeat(65),
    error_category: "unknown",
  });
  console.error = original;
  check(
    "a parameter with spaces, paths or excess length is refused",
    sent.length === 0 && errors.length === 2,
    JSON.stringify({ sent, errors }),
  );
  check(
    "the refusal names the parameter but not its value",
    errors.every((e) => e.includes("example_id") && !e.includes("bracket")),
    errors.join(" | "),
  );
}
{
  fresh("granted");
  track("example_loaded", {
    example_id: "mbb-beam-topopt",
    duration_bucket: "1_5s",
  });
  check("a gallery id passes", sent.length === 1);
}

// ── Session continuity ───────────────────────────────────────────────────────
{
  fresh("granted");
  const realNow = Date.now;
  let now = 1_000_000;
  Date.now = () => now;
  track("solver_opened", opened);
  now += 10 * 60 * 1000;
  track("solve_started", { workflow: "example", analysis_type: "static" });
  now += 31 * 60 * 1000;
  track("solve_completed", {
    workflow: "example",
    analysis_type: "static",
    duration_bucket: "gt_5min",
  });
  Date.now = realNow;
  check(
    "an event after 30 min of silence is preceded by a page_view",
    sent.map((e) => e.name).join() ===
      "solver_opened,solve_started,page_view,solve_completed",
    JSON.stringify(sent.map((e) => e.name)),
  );
}

// ── Buckets and categories ───────────────────────────────────────────────────
{
  const cases = [
    [0, "lt_1s"],
    [999, "lt_1s"],
    [1_000, "1_5s"],
    [14_999, "5_15s"],
    [59_999, "15_60s"],
    [60_000, "1_5min"],
    [300_000, "gt_5min"],
  ];
  const wrong = cases.filter(([ms, b]) => durationBucket(ms) !== b);
  check("duration buckets", wrong.length === 0, JSON.stringify(wrong));
}
{
  const cases = [
    [
      "STEPControl_Reader::ReadFile failed — invalid STEP file",
      "unsupported_format",
    ],
    [
      "IGESControl_Reader::ReadFile failed — invalid IGES file",
      "unsupported_format",
    ],
    [
      "CG solver did not converge: relative residual 1e-2 after 5000 iterations",
      "numerical_failure",
    ],
    ["shell: singular 3×3 matrix", "numerical_failure"],
    ["RuntimeError: Aborted(OOM)", "resource_limit"],
    ["Cannot enlarge memory arrays to size 2147483648 bytes", "resource_limit"],
    [
      "WASM trap (code bug, not OOM): RuntimeError: memory access out of bounds",
      "worker_failure",
    ],
    ["Worker crashed", "worker_failure"],
    ["Ng_GenerateVolumeMesh failed (code 1)", "invalid_input"],
    ["No geometry found.", "invalid_input"],
    ["mixed solve: the model has no shell element", "invalid_input"],
    ["something nobody anticipated", "unknown"],
  ];
  const wrong = cases
    .map(([msg, want]) => [msg, want, categorizeError(new Error(msg))])
    .filter(([, want, got]) => want !== got);
  check("error categories", wrong.length === 0, JSON.stringify(wrong));
  check(
    "non-Error rejections are categorised too",
    categorizeError("Worker error") === "worker_failure",
  );
}
{
  check(
    "model type from element types",
    modelType([{ type: "CTETRA" }]) === "solid" &&
      modelType([{ type: "CTRIA3" }]) === "shell" &&
      modelType([{ type: "CTRIA3" }, { type: "CTETRA" }]) === "mixed",
  );
}

if (failures > 0) {
  console.log(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nAll analytics checks passed");
