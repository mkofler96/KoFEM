// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Unit tests for src/lib/feedback.ts — a bug report carries the listed
// diagnostics and nothing else: no geometry, file names, coordinates, mesh or
// results, however much of the model the builder is handed. The prefilled
// GitHub URL stays well under GitHub's length limit and matches the issue
// forms in .github/ISSUE_TEMPLATE. The dialog itself is exercised in the
// browser by tests/feedback.spec.ts.
//
// Run:  bun tests/test_feedback.mjs

import { readFileSync } from "node:fs";
import {
  DIAGNOSTICS_FIELD_ID,
  FEEDBACK_TEMPLATES,
  MAX_ERROR_CHARS,
  MAX_ISSUE_URL_LENGTH,
  TRUNCATION_MARKER,
  buildDiagnostics,
  describeBrowser,
  feedbackIssueUrl,
  formatDiagnostics,
  redactErrorText,
} from "../src/lib/feedback.ts";

let failures = 0;
function check(name, cond, detail = "") {
  if (cond) {
    console.log(`  [PASS] ${name}`);
  } else {
    failures++;
    console.log(`  [FAIL] ${name}${detail ? ` — ${detail}` : ""}`);
  }
}
function throws(fn) {
  try {
    fn();
    return false;
  } catch {
    return true;
  }
}

const CHROME_LINUX =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.6723.58 Safari/537.36";

const env = {
  appVersion: "v0.4.0-dev-26a1531",
  engineId: "engine-b3e98c12987e",
  userAgent: CHROME_LINUX,
  webAssembly: true,
  webGl: "WebGL 2",
  lastShownError: null,
};

// A model the way the store holds it, salted with values that must not leak:
// a confidential model name, coordinates, mesh connectivity, group names,
// load magnitudes, materials and results.
const SECRET_NAME = "ACME_Hydraulic_Bracket_rev7";
const SECRET_NUMBERS = ["123.456", "98765", "4.2e-7", "2100000"];
function storeLike(overrides = {}) {
  return {
    modelName: SECRET_NAME,
    stepSurface: {
      points: [
        [123.456, 0, 1],
        [2, 3, 4],
      ],
      triangles: [[0, 1, 0]],
    },
    stepBytes: new TextEncoder().encode("ISO-10303-21; ACME secret part"),
    properties: [
      { id: 1, materialId: 1, discretization: "solid" },
      { id: 2, materialId: 1, discretization: "shell" },
      { id: 3, materialId: 1, thickness: 2.5, sourceBodyId: 2 },
    ],
    materials: [{ id: 1, name: "ACME alloy X", young: 2100000, poisson: 0.3 }],
    nodes: [
      { id: 1, x: 123.456, y: -7, z: 0 },
      { id: 2, x: 1, y: 2, z: 3 },
      { id: 3, x: 4, y: 5, z: 6 },
    ],
    elements: [{ id: 1, type: "CTETRA", nodeIds: [1, 2, 3, 1], propertyId: 1 }],
    bcGroups: [{ id: 1, name: "Bolt hole ACME", faces: [{ cadFaceId: 17 }] }],
    loadGroups: [
      { id: 1, name: "Pump pressure", components: [98765, 0, 0] },
      { id: 2, name: "Weight", components: [0, 0, -1] },
    ],
    result: { displacement: [4.2e-7, 0, 0], vonMises: [98765] },
    treeSelection: { group: "mesh", target: { type: "item", kind: "mesh" } },
    ...overrides,
  };
}

const FIELDS = [
  "appVersion",
  "bodies",
  "browser",
  "elements",
  "engineId",
  "lastError",
  "loads",
  "nodes",
  "os",
  "step",
  "supports",
  "webAssembly",
  "webGl",
];

// ── Only the listed fields, as counts ────────────────────────────────────────
{
  const diag = buildDiagnostics(env, storeLike());
  check(
    "the diagnostics carry exactly the listed fields",
    JSON.stringify(Object.keys(diag).sort()) === JSON.stringify(FIELDS),
    Object.keys(diag).sort().join(","),
  );
  check(
    "every value is a primitive (no arrays or objects to smuggle data in)",
    Object.values(diag).every(
      (v) => v === null || ["string", "number", "boolean"].includes(typeof v),
    ),
  );
  check(
    "model size is counted: CAD bodies (not derived PSHELLs), nodes, elements, supports, loads",
    diag.bodies === 2 &&
      diag.nodes === 3 &&
      diag.elements === 1 &&
      diag.supports === 1 &&
      diag.loads === 2,
    JSON.stringify(diag),
  );
  check("the current step is the model-tree group", diag.step === "mesh");
  check(
    "the browser is reduced to family + major version and OS family",
    diag.browser === "Chrome 130" && diag.os === "Linux",
    `${diag.browser} / ${diag.os}`,
  );

  const text = formatDiagnostics(diag);
  const url = feedbackIssueUrl("problem", diag);
  const everything = [JSON.stringify(diag), text, decodeURIComponent(url)];
  const leaks = [
    SECRET_NAME,
    "ACME",
    "Bolt hole",
    "Pump",
    ...SECRET_NUMBERS,
  ].filter((secret) => everything.some((s) => s.includes(secret)));
  check(
    "no model name, group name, coordinate, load, material or result value appears",
    leaks.length === 0,
    `leaked: ${leaks.join(", ")}`,
  );
}
{
  const diag = buildDiagnostics(
    env,
    storeLike({ stepSurface: null, nodes: [], elements: [] }),
  );
  check(
    "before any geometry the placeholder property is not counted as a body",
    diag.bodies === 0,
    String(diag.bodies),
  );
}

// ── Version stamps are validated, not passed through ─────────────────────────
check(
  "an app version that is not a version stamp is refused",
  throws(() =>
    buildDiagnostics(
      { ...env, appVersion: "C:\\Users\\me\\bracket.step" },
      storeLike(),
    ),
  ),
);
check(
  "an engine id that is not engine-<hash> is refused",
  throws(() =>
    buildDiagnostics({ ...env, engineId: "my-bracket" }, storeLike()),
  ),
);
check(
  "a build without an engine stamp says so",
  formatDiagnostics(buildDiagnostics({ ...env, engineId: null }, storeLike()))
    .split("\n")
    .includes("Engine: not recorded in this build"),
);

// ── The last error is redacted and capped ────────────────────────────────────
{
  const diag = buildDiagnostics(
    {
      ...env,
      lastShownError: `Volume meshing failed for ${SECRET_NAME}: ACME_part.STEP\nnode at (123.456, -7, 4.2e-7) is degenerate`,
    },
    storeLike(),
  );
  check(
    "the model name, file names and coordinate triples are replaced",
    diag.lastError ===
      "Volume meshing failed for [model name]: [file] node at [coordinates] is degenerate",
    diag.lastError,
  );
  check(
    "plain error text survives",
    redactErrorText("Solver error: matrix is singular", []) ===
      "Solver error: matrix is singular",
  );
  check(
    "control characters become spaces",
    redactErrorText("a\u0000b\u001bc", []) === "a b c",
  );
  check(
    "names shorter than three characters are not used to redact",
    redactErrorText("a bad mesh", ["a"]) === "a bad mesh",
  );
}
{
  const long = "x".repeat(MAX_ERROR_CHARS + 50);
  const out = redactErrorText(long, []);
  check(
    "an over-long error is cut with a visible marker",
    out.endsWith(TRUNCATION_MARKER) &&
      out.length === MAX_ERROR_CHARS + TRUNCATION_MARKER.length,
    String(out.length),
  );
}
{
  // Worst case for the URL: every character encodes to 12 bytes.
  const emoji = "\u{1F4A5}".repeat(5000);
  const diag = buildDiagnostics({ ...env, lastShownError: emoji }, storeLike());
  check(
    "a cut never splits a surrogate pair",
    !throws(() => encodeURIComponent(diag.lastError)),
  );
  const url = feedbackIssueUrl("problem", diag);
  check(
    `the worst-case URL stays under ${MAX_ISSUE_URL_LENGTH} characters`,
    url.length < MAX_ISSUE_URL_LENGTH,
    String(url.length),
  );
}

// ── The URL targets the issue forms ──────────────────────────────────────────
{
  const diag = buildDiagnostics(env, storeLike());
  const url = new URL(feedbackIssueUrl("problem", diag));
  check(
    "a report opens the bug_report form on the KoFEM repository",
    url.origin === "https://github.com" &&
      url.pathname === "/mkofler96/KoFEM/issues/new" &&
      url.searchParams.get("template") === "bug_report.yml",
    url.href,
  );
  check(
    "the diagnostics prefill their form field verbatim",
    url.searchParams.get(DIAGNOSTICS_FIELD_ID) === formatDiagnostics(diag),
  );
  check(
    "the URL carries nothing but the template and the diagnostics",
    JSON.stringify([...url.searchParams.keys()]) ===
      JSON.stringify(["template", DIAGNOSTICS_FIELD_ID]),
  );
  const bare = new URL(feedbackIssueUrl("problem", null));
  check(
    "without opt-in only the template is passed",
    JSON.stringify([...bare.searchParams.keys()]) ===
      JSON.stringify(["template"]),
    bare.href,
  );
  const idea = new URL(feedbackIssueUrl("improvement", null));
  check(
    "a suggestion opens the feature_request form",
    idea.searchParams.get("template") === "feature_request.yml" &&
      [...idea.searchParams.keys()].length === 1,
    idea.href,
  );
  check(
    "a suggestion refuses diagnostics",
    throws(() => feedbackIssueUrl("improvement", diag)),
  );
}

// ── The forms exist and have the field the URL fills ─────────────────────────
for (const file of Object.values(FEEDBACK_TEMPLATES)) {
  const path = new URL(`../../.github/ISSUE_TEMPLATE/${file}`, import.meta.url);
  let yml = "";
  try {
    yml = readFileSync(path, "utf8");
  } catch (err) {
    check(`${file} exists`, false, err.message);
    continue;
  }
  check(`${file} exists`, yml.length > 0);
  if (file === FEEDBACK_TEMPLATES.problem)
    check(
      `${file} has the "${DIAGNOSTICS_FIELD_ID}" field the URL prefills`,
      new RegExp(`^\\s*id:\\s*${DIAGNOSTICS_FIELD_ID}\\s*$`, "m").test(yml),
    );
}

// ── Browser and OS families ──────────────────────────────────────────────────
const AGENTS = [
  [CHROME_LINUX, "Chrome 130", "Linux"],
  [
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.2849.56",
    "Edge 130",
    "Windows",
  ],
  [
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15",
    "Safari 17",
    "macOS",
  ],
  [
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1",
    "Safari 17",
    "iOS",
  ],
  [
    "Mozilla/5.0 (X11; Ubuntu; Linux x86_64; rv:131.0) Gecko/20100101 Firefox/131.0",
    "Firefox 131",
    "Linux",
  ],
  [
    "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.6723.58 Mobile Safari/537.36",
    "Chrome 130",
    "Android",
  ],
  ["curl/8.5.0", "unrecognised browser", "unrecognised OS"],
];
for (const [ua, browser, os] of AGENTS) {
  const got = describeBrowser(ua);
  check(
    `${browser} on ${os}`,
    got.browser === browser && got.os === os,
    `${got.browser} on ${got.os}`,
  );
}

console.log(
  failures === 0 ? "\nAll feedback checks passed." : `\n${failures} FAILED`,
);
process.exit(failures === 0 ? 0 : 1);
