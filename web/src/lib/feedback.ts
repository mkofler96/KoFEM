// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Bug reports and suggestions go to public GitHub issue forms
// (.github/ISSUE_TEMPLATE/). KoFEM sends nothing itself: it builds a link to a
// prefilled form, and the user reviews and submits it on GitHub.
//
// Everything a report can carry from the app passes through buildDiagnostics,
// and its output type is the complete list: versions, browser, the WebAssembly
// and WebGL support, model size as counts, the current step and the last error
// message the UI showed. The model reaches the builder only as arrays it counts;
// geometry, file names, coordinates, meshes and results have no field to go in.
// The one free-text field, the error message, is redacted and capped.

import type { TreeGroup } from "../store/viewSlice";

export const FEEDBACK_REPO_URL = "https://github.com/mkofler96/KoFEM";
export const FEEDBACK_TEMPLATES = {
  problem: "bug_report.yml",
  improvement: "feature_request.yml",
} as const;
export type FeedbackKind = keyof typeof FEEDBACK_TEMPLATES;
// The issue form field the diagnostics prefill — its `id` in bug_report.yml.
export const DIAGNOSTICS_FIELD_ID = "diagnostics";

// Error text beyond this many characters is cut, with a visible marker.
export const MAX_ERROR_CHARS = 400;
export const TRUNCATION_MARKER = " … [truncated]";
// GitHub answers 414 above roughly 8 KB of URL; stay well clear of it.
export const MAX_ISSUE_URL_LENGTH = 6000;

export type WebGlSupport = "WebGL 2" | "WebGL 1" | "unavailable";

/** Everything a bug report can carry from the app — and nothing else. */
export interface Diagnostics {
  readonly appVersion: string;
  readonly engineId: string | null;
  readonly browser: string;
  readonly os: string;
  readonly webAssembly: boolean;
  readonly webGl: WebGlSupport;
  readonly bodies: number;
  readonly nodes: number;
  readonly elements: number;
  readonly supports: number;
  readonly loads: number;
  readonly step: TreeGroup;
  readonly lastError: string | null;
}

/** The model as the builder sees it: lists to count, never to read. */
export interface DiagnosticsModel {
  readonly modelName: string;
  readonly stepSurface: object | null;
  readonly properties: readonly { readonly sourceBodyId?: number }[];
  readonly nodes: readonly unknown[];
  readonly elements: readonly unknown[];
  readonly bcGroups: readonly unknown[];
  readonly loadGroups: readonly unknown[];
  readonly treeSelection: { readonly group: TreeGroup };
}

export interface DiagnosticsEnvironment {
  readonly appVersion: string;
  readonly engineId: string | null;
  readonly userAgent: string;
  readonly webAssembly: boolean;
  readonly webGl: WebGlSupport;
  // The text of the last error banner the UI showed, verbatim.
  readonly lastShownError: string | null;
}

const VERSION_RE = /^[\w.+-]{1,64}$/;
const ENGINE_ID_RE = /^engine-[0-9a-f]{12}$/;

export function buildDiagnostics(
  env: DiagnosticsEnvironment,
  model: DiagnosticsModel,
): Diagnostics {
  if (!VERSION_RE.test(env.appVersion))
    throw new Error(
      `Diagnostics: app version "${env.appVersion.slice(0, 80)}" is not a version stamp (letters, digits, . + - _, at most 64 characters)`,
    );
  if (env.engineId !== null && !ENGINE_ID_RE.test(env.engineId))
    throw new Error(
      `Diagnostics: engine id "${env.engineId.slice(0, 80)}" is not of the form engine-<12 hex digits> (scripts/engine-version.sh)`,
    );
  const { browser, os } = describeBrowser(env.userAgent);
  // Before an import the store still holds one placeholder property; there is
  // no body until there is geometry.
  const hasGeometry = model.stepSurface !== null || model.nodes.length > 0;
  return {
    appVersion: env.appVersion,
    engineId: env.engineId,
    browser,
    os,
    webAssembly: env.webAssembly,
    webGl: env.webGl,
    bodies: hasGeometry
      ? model.properties.filter((p) => p.sourceBodyId === undefined).length
      : 0,
    nodes: model.nodes.length,
    elements: model.elements.length,
    supports: model.bcGroups.length,
    loads: model.loadGroups.length,
    step: model.treeSelection.group,
    lastError:
      env.lastShownError === null
        ? null
        : redactErrorText(env.lastShownError, [model.modelName]),
  };
}

// Engine and mesher messages can quote what they choke on. Names the user
// gave, CAD file names and coordinate triples are replaced before the text is
// shown in the preview; the user still reviews the result.
const FILE_NAME_RE =
  /[^\s"'`()[\]{}<>:;,|]+\.(?:step|stp|iges|igs|brep|stl|vtu|xml|json|csv)\b/gi;
const NUMBER = String.raw`[-+]?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?`;
const COORDINATES_RE = new RegExp(
  String.raw`[([]\s*${NUMBER}\s*[,;\s]\s*${NUMBER}\s*[,;\s]\s*${NUMBER}\s*[)\]]`,
  "gi",
);
const CONTROL_RE = /[\u0000-\u001f\u007f]+/g;

export function redactErrorText(text: string, names: string[]): string {
  let out = text.replace(CONTROL_RE, " ");
  for (const name of names) {
    const trimmed = name.trim();
    // Too short to tell apart from ordinary words in the message.
    if (trimmed.length < 3) continue;
    out = out.replace(
      new RegExp(trimmed.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi"),
      "[model name]",
    );
  }
  out = out
    .replace(FILE_NAME_RE, "[file]")
    .replace(COORDINATES_RE, "[coordinates]")
    .replace(/\s+/g, " ")
    .trim();
  // Cut by code point so a surrogate pair is never split (encodeURIComponent
  // throws on a lone surrogate).
  const chars = Array.from(out);
  return chars.length > MAX_ERROR_CHARS
    ? chars.slice(0, MAX_ERROR_CHARS).join("") + TRUNCATION_MARKER
    : out;
}

const OS_RULES: [string, RegExp][] = [
  ["Windows", /Windows NT/],
  // Before macOS and Linux: iOS claims "like Mac OS X", Android "Linux".
  ["iOS", /iPhone|iPad|iPod/],
  ["Android", /Android/],
  ["ChromeOS", /CrOS/],
  ["macOS", /Mac OS X|Macintosh/],
  ["Linux", /Linux/],
];
// Most specific first: Edge and Opera also say "Chrome", Chrome says "Safari".
const BROWSER_RULES: [string, RegExp][] = [
  ["Edge", /Edg(?:e|A|iOS)?\/(\d+)/],
  ["Opera", /OPR\/(\d+)/],
  ["Samsung Internet", /SamsungBrowser\/(\d+)/],
  ["Firefox", /(?:Firefox|FxiOS)\/(\d+)/],
  ["Chrome", /(?:HeadlessChrome|Chrome|CriOS)\/(\d+)/],
  ["Safari", /Version\/(\d+)[\d.]*(?: Mobile\/\S+)? Safari\//],
];

/** Browser family with its major version, and the OS family — no full UA. */
export function describeBrowser(userAgent: string): {
  browser: string;
  os: string;
} {
  const os = OS_RULES.find(([, re]) => re.test(userAgent));
  for (const [name, re] of BROWSER_RULES) {
    const match = re.exec(userAgent);
    if (match)
      return {
        browser: `${name} ${match[1]}`,
        os: os ? os[0] : "unrecognised OS",
      };
  }
  return {
    browser: "unrecognised browser",
    os: os ? os[0] : "unrecognised OS",
  };
}

const STEP_LABELS: Record<TreeGroup, string> = {
  geometry: "Geometry",
  materials: "Materials",
  mesh: "Mesh",
  boundary: "Boundary conditions",
  studies: "Studies",
  results: "Results",
};

function count(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** The diagnostics as the plain text the user previews and GitHub receives. */
export function formatDiagnostics(d: Diagnostics): string {
  return [
    `KoFEM: ${d.appVersion}`,
    `Engine: ${d.engineId === null ? "not recorded in this build" : d.engineId}`,
    `Browser: ${d.browser} on ${d.os}`,
    `WebAssembly: ${d.webAssembly ? "available" : "unavailable"}`,
    `WebGL: ${d.webGl}`,
    `Model: ${[
      count(d.bodies, "body", "bodies"),
      count(d.nodes, "node", "nodes"),
      count(d.elements, "element", "elements"),
      count(d.supports, "support", "supports"),
      count(d.loads, "load", "loads"),
    ].join(", ")}`,
    `Step: ${STEP_LABELS[d.step]}`,
    `Last error: ${d.lastError === null ? "none shown" : d.lastError}`,
  ].join("\n");
}

/**
 * The GitHub "new issue" page for one of the forms, with the diagnostics in
 * their field when the user chose to include them. GitHub prefills issue form
 * fields from query parameters named after the field `id`.
 */
export function feedbackIssueUrl(
  kind: FeedbackKind,
  diagnostics: Diagnostics | null,
): string {
  if (kind === "improvement" && diagnostics !== null)
    throw new Error(
      "feedbackIssueUrl: suggestions carry no diagnostics — the feature_request form has no field for them",
    );
  const params = new URLSearchParams({ template: FEEDBACK_TEMPLATES[kind] });
  if (diagnostics !== null)
    params.set(DIAGNOSTICS_FIELD_ID, formatDiagnostics(diagnostics));
  const url = `${FEEDBACK_REPO_URL}/issues/new?${params.toString()}`;
  if (url.length > MAX_ISSUE_URL_LENGTH)
    throw new Error(
      `feedbackIssueUrl: the prefilled URL is ${url.length} characters, over the ${MAX_ISSUE_URL_LENGTH} kept clear of GitHub's limit — the error text cap (MAX_ERROR_CHARS) no longer bounds it`,
    );
  return url;
}
