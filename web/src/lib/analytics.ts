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
// A per-session event (the first completed solve) is sent once per browser
// tab; the flag that says so is written to sessionStorage only when it is sent.
//
// No event carries model data. Parameters are a closed set of enums (format,
// workflow, error category, duration bucket) plus the public gallery example
// id; raw error messages, file names, sizes and results never leave the page.

import type { CadFormat } from "./cadFormat";
import { inEnglish } from "../i18n/english";
import {
  rustFailureClass,
  WorkerCrashError,
  WorkerTaskError,
  type FailureStage,
  type RustFailureClass,
} from "./workerError";

export type Workflow = "cad_import" | "example" | "saved_file" | "none";
export type ErrorCategory =
  | "invalid_input"
  // Not a STEP or IGES file: refused before the engine sees it (KOF-347).
  | "unsupported_format"
  // Named STEP or IGES, but the reader rejects it: corrupt or mislabelled.
  | "parse_error"
  // The file reads, but holds no shape to show or mesh.
  | "empty_geometry"
  // The browser could not read the picked file (moved, or a cloud placeholder).
  | "file_unreadable"
  // The engine's import failed in a way no rule above recognises.
  | "import_failure"
  | "resource_limit"
  // numerical_reason says how (KOF-490).
  | "numerical_failure"
  | "geometry_defect"
  | "degenerate_element"
  // Netgen gave up on the shape (KOF-311).
  | "mesher_failure"
  // OCCT could not triangulate the shape.
  | "tessellation_failure"
  | "shell_idealisation_failure"
  // A solve path that does not take this model yet refuses it (KOF-418).
  | "unsupported_model"
  // The supports leave a body free to slide or spin; refused before the
  // solve (KOF-388). What the check misses still fails as numerical_failure.
  | "unheld_body"
  // The solver or optimizer failed in a way no rule above recognises.
  | "solver_failure"
  // A WASM trap or abort: a code bug in the engine, not the visitor's model.
  | "engine_crash"
  // The worker itself died, refused the task or answered nothing usable.
  | "worker_failure"
  | "engine_unavailable"
  // A language's text could not be fetched (KOF-490).
  | "app_load_failure"
  // The visitor ended the task, e.g. New model while meshing.
  | "cancelled"
  | "unknown";
// The reasons of crates/kofem-fem/src/failure_class.rs (KOF-490).
export const NUMERICAL_REASONS = [
  "singular_matrix",
  "not_converged",
  "newton_not_converged",
  "unstable_tangent",
  "inverted_element",
  "non_finite_result",
] as const;
export type NumericalReason = (typeof NUMERICAL_REASONS)[number];
// The category a failure is sent with; a numerical failure always carries its
// reason.
export type FailureClass =
  | { error_category: PlainCategory }
  | { error_category: "numerical_failure"; numerical_reason: NumericalReason };
// A category with no reason to carry: every one but numerical_failure.
type PlainCategory = Exclude<ErrorCategory, "numerical_failure">;
export type DurationBucket =
  "lt_1s" | "1_5s" | "5_15s" | "15_60s" | "1_5min" | "gt_5min";
export type ModelType = "solid" | "shell" | "mixed";
export type AnalysisType = "static" | "topology";
// "other": a file refused for not being STEP or IGES.
type ImportFormat = CadFormat | "other";
// How the model got here, and which example it is when it is one (KOF-418).
export interface WorkflowParams {
  workflow: Workflow;
  example_id?: string;
}

export interface AnalyticsEvents {
  solver_opened: {
    entry: "example" | "direct";
    duration_bucket: DurationBucket;
  };
  engine_ready: { duration_bucket: DurationBucket };
  geometry_import_success: {
    workflow: "cad_import";
    format: CadFormat;
    duration_bucket: DurationBucket;
  };
  geometry_import_failed: {
    workflow: "cad_import";
    format: ImportFormat;
    duration_bucket: DurationBucket;
    error_category: ErrorCategory;
  };
  example_loaded: { example_id: string; duration_bucket: DurationBucket };
  example_load_failed: { example_id: string; error_category: ErrorCategory };
  mesh_completed: WorkflowParams & {
    model_type: ModelType;
    duration_bucket: DurationBucket;
  };
  mesh_failed: WorkflowParams & {
    model_type: ModelType;
    duration_bucket: DurationBucket;
    error_category: ErrorCategory;
  };
  solve_started: WorkflowParams & { analysis_type: AnalysisType };
  solve_completed: WorkflowParams & {
    analysis_type: AnalysisType;
    duration_bucket: DurationBucket;
  };
  // The GA4 key event: the first completed solve of a browser-tab session,
  // whereas solve_completed counts every solve (KOF-491).
  first_solve_completed: WorkflowParams & {
    analysis_type: AnalysisType;
    duration_bucket: DurationBucket;
  };
  solve_failed: WorkflowParams & {
    analysis_type: AnalysisType;
    duration_bucket: DurationBucket;
  } & FailureClass;
  results_viewed: WorkflowParams;
  // Results → Save report (KOF-391): that a report was saved, never what it
  // says.
  report_saved: WorkflowParams;
  // The feedback dialog was opened from the top bar, then the email or the
  // GitHub path taken. No parameters, so nothing to register in GA4; what the
  // user then writes stays in their email or on GitHub.
  feedback_report_opened: Record<string, never>;
  feedback_email_opened: Record<string, never>;
  feedback_github_opened: Record<string, never>;
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
// Sent at most once per browser-tab session, so a reload does not repeat them
// and a new tab starts over. The mark is a flag in sessionStorage, written only
// when the event is sent, so never without consent, and gone with the tab.
const PER_SESSION: ReadonlySet<string> = new Set<AnalyticsEventName>([
  "first_solve_completed",
]);
const SESSION_MARK_PREFIX = "kofem_analytics_sent:";

let pending: [string, Record<string, string>][] = [];
let listening = false;
let lastHitAt: number | null = null;
let workflow: Workflow = "none";
let exampleId: string | null = null;
const sentOnce = new Set<AnalyticsEventName>();

function consent(): ConsentState | undefined {
  return typeof window === "undefined"
    ? "disabled"
    : window.__kofemAnalyticsConsent;
}

// Claims the tab session's one send of a per-session event. Without
// sessionStorage the event is not sent: a key event must never be counted twice.
function claimSession(name: string): boolean {
  const key = SESSION_MARK_PREFIX + name;
  try {
    if (window.sessionStorage.getItem(key) !== null) return false;
    window.sessionStorage.setItem(key, "1");
    return true;
  } catch (err) {
    console.error(
      `[analytics] sessionStorage is unavailable — "${name}" not sent, since it may be sent only once per session.`,
      err,
    );
    return false;
  }
}

function send(name: string, params: Record<string, string>) {
  const gtag = window.gtag;
  if (!gtag) {
    console.error(
      `[analytics] consent is granted but window.gtag is missing — "${name}" not sent. The consent loader (vite-analytics.ts) defines gtag before announcing "granted".`,
    );
    return;
  }
  if (PER_SESSION.has(name) && !claimSession(name)) return;
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
    if (PER_SESSION.has(name) && pending.some(([queued]) => queued === name))
      return;
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
 * A completed solve: `solve_completed` every time, for usage counts, and
 * `first_solve_completed` once per tab session, for GA4's key event.
 */
export function trackSolveCompleted(
  params: AnalyticsEvents["solve_completed"],
): void {
  track("solve_completed", params);
  track("first_solve_completed", params);
}

/**
 * The consent banner, when the loader is active (a measurement ID is set). The
 * app links to it so a visitor can withdraw consent without leaving the solver.
 */
export function consentBanner(): HTMLElement | null {
  if (consent() === "disabled") return null;
  return document.getElementById("kofem-cookie-consent");
}

/**
 * How the model now in the workspace got there; tags later mesh/solve events.
 * An example names its public gallery id, so a failing example can be found.
 */
export function setWorkflow(w: "example", id: string): void;
export function setWorkflow(w: Exclude<Workflow, "example">): void;
export function setWorkflow(w: Workflow, id?: string): void {
  if (w === "example" && !id)
    throw new Error("setWorkflow: the example workflow needs an example id");
  workflow = w;
  exampleId = w === "example" && id ? id : null;
}
/** The workflow parameters of a mesh, solve or results event. */
export function workflowParams(): WorkflowParams {
  return exampleId === null
    ? { workflow }
    : { workflow, example_id: exampleId };
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
// text, which is never sent — only the category is. A FemError is classed by
// the Rust module instead (RUST_CATEGORY below).
const ERROR_RULES: [PlainCategory, RegExp][] = [
  [
    "resource_limit",
    /out of memory|Aborted\(OOM\)|Cannot enlarge memory|memory allocation|Array buffer allocation failed|bad_alloc|exceeds the limit|too many elements/i,
  ],
  [
    "file_unreadable",
    /NotReadableError|NotFoundError|requested file .*could not be/i,
  ],
  // resetWorker() rejects what was in flight: the visitor started over. Or
  // they stopped the solve at the CG iteration-limit prompt.
  ["cancelled", /Worker reset|Solve stopped by user/i],
  ["engine_unavailable", /engine failed to load/i],
  [
    "engine_crash",
    /WASM trap|RuntimeError|Aborted\(|memory access out of bounds|unreachable/i,
  ],
  [
    "worker_failure",
    /Worker crashed|Worker error|worker .*terminated|WASM module not initialised|worker is busy/i,
  ],
  // i18n/loadLocale.ts fetches a language's text on demand.
  ["app_load_failure", /text of KoFEM (could not be loaded|is incomplete)/i],
  ["unsupported_format", /unsupported|not a (STEP|IGES)/i],
  ["parse_error", /invalid (STEP|IGES) file|ReadFile failed|ISO-10303/i],
  // Before geometry_defect: an IGES file of free surfaces names the closed
  // solid it lacks, and a tessellated-only STEP the CAD solid (KOF-361).
  [
    "empty_geometry",
    /no transferable shapes|no geometry with a measurable extent|No geometry found|only a tessellated mesh/i,
  ],
  // Before mesher_failure: Netgen's volume fill names the geometry as the cause.
  // BOPAlgo_MakeConnected fails on import when an assembly's bodies overlap.
  [
    "geometry_defect",
    /self-intersecting|0 tetrahedra|no closed solid|watertight|BOPAlgo_MakeConnected/i,
  ],
  [
    "mesher_failure",
    /Ng_\w+ failed|Ng_NewMesh|NgException|Geomsearch|hash-position|OCCGeometry construction failed/i,
  ],
  ["tessellation_failure", /BRepMesh\w* .*failed|produced no triangles/i],
  // Before invalid_input: the refusals of lib/solve/refusals.ts, amg.ts,
  // route.ts and autoShell.ts (KOF-418).
  [
    "unsupported_model",
    /does not support|cannot solve this model|solve with linear elements only|supports solid models only|the shell solver cannot apply|can be idealised as shells today|works on tetrahedral meshes only/i,
  ],
  ["shell_idealisation_failure", /Shell idealisation failed/i],
  // The rigid-body check (lib/solve/rigidBody.ts, KOF-388), and a body only
  // contact holds that its load drives off (KOF-501).
  [
    "unheld_body",
    /can still (move along|rotate about)|held only by contact, which cannot stop it/i,
  ],
  [
    "invalid_input",
    /No geometry|must be|must not|no (solid|shell) element|no property|no material|degenerate|zero total|carries no|cannot be|missing|invalid|cannot fill/i,
  ],
];

// The categories of crates/kofem-fem/src/failure_class.rs; "numerical" comes
// with a reason.
const RUST_CATEGORY = {
  invalid_input: "invalid_input",
  degenerate_element: "degenerate_element",
  resource_limit: "resource_limit",
  unsupported_model: "unsupported_model",
  internal: "solver_failure",
} as const satisfies Record<string, PlainCategory>;

function isRustCategory(value: string): value is keyof typeof RUST_CATEGORY {
  return Object.hasOwn(RUST_CATEGORY, value);
}

function isNumericalReason(value: string): value is NumericalReason {
  return (NUMERICAL_REASONS as readonly string[]).includes(value);
}

function fromRust({ category, reason }: RustFailureClass): FailureClass {
  if (category === "numerical" && reason !== null && isNumericalReason(reason))
    return { error_category: "numerical_failure", numerical_reason: reason };
  if (isRustCategory(category) && reason === null)
    return { error_category: RUST_CATEGORY[category] };
  // The page and the Rust module are built together, so this is a bug.
  console.error(
    `[analytics] the Rust module sent an unknown failure class: ${category} / ${String(reason)}`,
  );
  return { error_category: "unknown" };
}

// What a failure in each step is when its text matches no rule above.
const STAGE_CATEGORY: Record<FailureStage, PlainCategory> = {
  geometry_reload: "tessellation_failure",
  meshing: "mesher_failure",
  shell_idealisation: "shell_idealisation_failure",
  geometry_import: "import_failure",
  solving: "solver_failure",
};

/**
 * Map an error to a fixed category, and a numerical failure to its reason.
 * The message itself stays in the browser.
 */
export function classifyFailure(err: unknown): FailureClass {
  const rust =
    err instanceof WorkerTaskError ? err.rustClass : rustFailureClass(err);
  if (rust !== null) return fromRust(rust);
  const text =
    err instanceof WorkerTaskError
      ? `${err.name}: ${err.english}`
      : inEnglish(
          err instanceof Error ? `${err.name}: ${err.message}` : String(err),
        );
  for (const [category, re] of ERROR_RULES)
    if (re.test(text)) return { error_category: category };
  if (err instanceof WorkerCrashError)
    return { error_category: "worker_failure" };
  if (err instanceof WorkerTaskError && err.stage !== null)
    return { error_category: STAGE_CATEGORY[err.stage] };
  return { error_category: "unknown" };
}

/** `classifyFailure`'s category alone, for events without a reason. */
export function categorizeError(err: unknown): ErrorCategory {
  return classifyFailure(err).error_category;
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
  exampleId = null;
  sentOnce.clear();
}
