// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Product events for GA4: did a visitor get from opening the solver to a result,
// and where did they stop. Everything here is subordinate to the consent loader
// in web/vite-analytics.ts, which alone loads gtag.js:
//
// - granted   → the event goes to window.gtag, which only that loader defines.
// - pending   → the visitor has not answered the banner yet. The event waits in
//               memory and is sent if they accept on this page, dropped if they
//               decline or leave. Nothing is written to storage.
// - denied, disabled (no measurement ID), or no loader at all → dropped.
//
// No event carries model data. Parameters are a closed set of enums (format,
// workflow, error category, duration bucket) plus the public gallery example
// id; raw error messages, file names, sizes and results never leave the page.

export type Workflow = "cad_import" | "example" | "saved_file" | "none";
export type ErrorCategory =
  | "invalid_input"
  | "unsupported_format"
  | "resource_limit"
  | "numerical_failure"
  | "worker_failure"
  | "unknown";
export type DurationBucket =
  "lt_1s" | "1_5s" | "5_15s" | "15_60s" | "1_5min" | "gt_5min";
export type ModelType = "solid" | "shell" | "mixed";
export type AnalysisType = "static" | "topology";
type CadFormat = "step" | "iges";

export interface AnalyticsEvents {
  solver_opened: {
    entry: "example" | "direct";
    duration_bucket: DurationBucket;
  };
  engine_ready: { duration_bucket: DurationBucket };
  geometry_import_success: {
    format: CadFormat;
    duration_bucket: DurationBucket;
  };
  geometry_import_failed: {
    format: CadFormat;
    duration_bucket: DurationBucket;
    error_category: ErrorCategory;
  };
  example_loaded: { example_id: string; duration_bucket: DurationBucket };
  example_load_failed: { example_id: string; error_category: ErrorCategory };
  mesh_completed: {
    workflow: Workflow;
    model_type: ModelType;
    duration_bucket: DurationBucket;
  };
  mesh_failed: {
    workflow: Workflow;
    model_type: ModelType;
    duration_bucket: DurationBucket;
    error_category: ErrorCategory;
  };
  solve_started: { workflow: Workflow; analysis_type: AnalysisType };
  solve_completed: {
    workflow: Workflow;
    analysis_type: AnalysisType;
    duration_bucket: DurationBucket;
  };
  solve_failed: {
    workflow: Workflow;
    analysis_type: AnalysisType;
    duration_bucket: DurationBucket;
    error_category: ErrorCategory;
  };
  results_viewed: { workflow: Workflow };
}
export type AnalyticsEventName = keyof AnalyticsEvents;

type ConsentState = "granted" | "denied" | "disabled";
type Gtag = (command: "event", name: string, params: object) => void;

declare global {
  interface Window {
    __kofemAnalyticsConsent?: ConsentState;
    gtag?: Gtag;
  }
}

export const CONSENT_EVENT = "kofem:analytics-consent";
// Enough for one full workflow while the banner waits; older events are dropped.
const MAX_PENDING = 25;
// GA4's default session timeout. An event after this much silence starts a new
// session; without a page_view that session's landing page reads "(not set)".
const SESSION_TIMEOUT_MS = 30 * 60 * 1000;
// Parameter values must look like an enum or a gallery id. A raw error message
// or file name fails this and is refused rather than sent.
const SAFE_VALUE = /^[A-Za-z0-9_-]{1,64}$/;

let pending: [string, Record<string, string>][] = [];
let listening = false;
let lastHitAt: number | null = null;
let workflow: Workflow = "none";
const sentOnce = new Set<AnalyticsEventName>();

function consent(): ConsentState | undefined {
  return typeof window === "undefined"
    ? "disabled"
    : window.__kofemAnalyticsConsent;
}

function send(name: string, params: Record<string, string>) {
  const gtag = window.gtag;
  if (!gtag) {
    console.error(
      `[analytics] consent is granted but window.gtag is missing — "${name}" not sent. The consent loader (vite-analytics.ts) defines gtag before announcing "granted".`,
    );
    return;
  }
  const now = Date.now();
  if (lastHitAt !== null && now - lastHitAt > SESSION_TIMEOUT_MS)
    gtag("event", "page_view", {});
  lastHitAt = now;
  gtag("event", name, params);
}

function listen() {
  if (listening || typeof window === "undefined") return;
  listening = true;
  window.addEventListener(CONSENT_EVENT, () => {
    const queued = pending;
    pending = [];
    if (consent() === "granted") for (const [n, p] of queued) send(n, p);
  });
}

/**
 * Record a product event. Safe to call unconditionally: without consent the
 * event never reaches gtag, and this never loads analytics itself.
 */
export function track<E extends AnalyticsEventName>(
  name: E,
  params: AnalyticsEvents[E],
): void {
  const entries = Object.entries(params) as [string, string][];
  const unsafe = entries.find(([, v]) => !SAFE_VALUE.test(v));
  if (unsafe) {
    console.error(
      `[analytics] refused "${name}": parameter ${unsafe[0]} is not an enum-like value (${unsafe[1].length} chars). Events carry categories only, never free text.`,
    );
    return;
  }
  const clean = Object.fromEntries(entries);
  const state = consent();
  if (state === "granted") send(name, clean);
  else if (state === undefined) {
    listen();
    pending.push([name, clean]);
    if (pending.length > MAX_PENDING) pending.shift();
  }
}

/** `track`, at most once per page load (StrictMode runs effects twice). */
export function trackOnce<E extends AnalyticsEventName>(
  name: E,
  params: AnalyticsEvents[E],
): void {
  if (sentOnce.has(name)) return;
  sentOnce.add(name);
  track(name, params);
}

/**
 * The consent banner, when the loader is active (a measurement ID is set). The
 * app links to it so a visitor can withdraw consent without leaving the solver.
 */
export function consentBanner(): HTMLElement | null {
  if (consent() === "disabled") return null;
  return document.getElementById("kofem-cookie-consent");
}

/** How the model now in the workspace got there; tags later mesh/solve events. */
export function setWorkflow(w: Workflow): void {
  workflow = w;
}
export function currentWorkflow(): Workflow {
  return workflow;
}

export function durationBucket(ms: number): DurationBucket {
  if (ms < 1_000) return "lt_1s";
  if (ms < 5_000) return "1_5s";
  if (ms < 15_000) return "5_15s";
  if (ms < 60_000) return "15_60s";
  if (ms < 300_000) return "1_5min";
  return "gt_5min";
}

/** Milliseconds-to-bucket timer: `const done = startTimer(); … done()`. */
export function startTimer(): () => DurationBucket {
  const t0 = performance.now();
  return () => durationBucket(performance.now() - t0);
}

// Ordered: the first matching rule wins. Matched against the worker's error
// text, which is never sent — only the category is.
const ERROR_RULES: [ErrorCategory, RegExp][] = [
  [
    "resource_limit",
    /out of memory|Aborted\(OOM\)|Cannot enlarge memory|memory allocation|Array buffer allocation failed|exceeds the limit|too many elements/i,
  ],
  [
    "worker_failure",
    /Worker crashed|Worker error|worker .*terminated|WASM module not initialised|WASM trap|RuntimeError/i,
  ],
  [
    "unsupported_format",
    /invalid (STEP|IGES) file|ReadFile failed|unsupported|not a (STEP|IGES)|ISO-10303/i,
  ],
  [
    "numerical_failure",
    /did not converge|diverg|singular|NaN|ill-conditioned|zero pivot|not positive definite|rigid[- ]body|unconstrained/i,
  ],
  // The mesher refusing a shape is a geometry problem, not a crash.
  [
    "invalid_input",
    /No geometry|must be|must not|no (solid|shell) element|no property|no material|degenerate|zero total|carries no|cannot be|missing|invalid|Ng_\w+ failed|BRepMesh\w* .*failed|OCCGeometry construction failed|cannot fill/i,
  ],
];

/** Map an error to a fixed category. The message itself stays in the browser. */
export function categorizeError(err: unknown): ErrorCategory {
  const text =
    err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  for (const [category, re] of ERROR_RULES) if (re.test(text)) return category;
  return "unknown";
}

/** Solid, shell or mixed, from the element types of a mesh. */
export function modelType(elements: { type: string }[]): ModelType {
  let shell = false;
  let solid = false;
  for (const e of elements) {
    if (e.type === "CTRIA3") shell = true;
    else solid = true;
    if (shell && solid) return "mixed";
  }
  return shell ? "shell" : "solid";
}

/** Test hook: forget queued events, once-only events and timing state. */
export function resetAnalyticsForTests(): void {
  pending = [];
  lastHitAt = null;
  workflow = "none";
  sentOnce.clear();
}
