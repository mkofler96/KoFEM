// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Unit tests for src/lib/feedback.ts — a bug report carries the listed
// diagnostics and nothing else: no geometry, file names, coordinates, mesh or
// results, however much of the model the builder is handed. The prefilled
// GitHub URL stays well under GitHub's length limit and matches the issue
// forms in .github/ISSUE_TEMPLATE. The dialog itself is exercised in the
// browser by tests/feedback.spec.ts.

import { describe, expect, test } from "bun:test";
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
} from "../../src/lib/feedback.ts";

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
    tieGroups: [{ id: 1, name: "Flange weld 3" }],
    couplingGroups: [{ id: 1, name: "ACME_Secret_Project" }],
    studies: [{ id: 1, kind: "static", name: "Burst case Q3" }],
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
describe("diagnostics fields", () => {
  const diag = buildDiagnostics(env, storeLike());

  test("the diagnostics carry exactly the listed fields", () => {
    expect(Object.keys(diag).sort()).toEqual(FIELDS);
  });

  test("every value is a primitive (no arrays or objects to smuggle data in)", () => {
    for (const [key, value] of Object.entries(diag))
      expect(
        value === null ||
          ["string", "number", "boolean"].includes(typeof value),
        `${key} is ${typeof value}`,
      ).toBe(true);
  });

  test("model size is counted: CAD bodies (not derived PSHELLs), nodes, elements, supports, loads", () => {
    expect(diag.bodies, JSON.stringify(diag)).toBe(2);
    expect(diag.nodes, JSON.stringify(diag)).toBe(3);
    expect(diag.elements, JSON.stringify(diag)).toBe(1);
    expect(diag.supports, JSON.stringify(diag)).toBe(1);
    expect(diag.loads, JSON.stringify(diag)).toBe(2);
  });

  test("the current step is the model-tree group", () => {
    expect(diag.step).toBe("mesh");
  });

  test("the browser is reduced to family + major version and OS family", () => {
    expect(diag.browser).toBe("Chrome 130");
    expect(diag.os).toBe("Linux");
  });

  test("no model name, group name, coordinate, load, material or result value appears", () => {
    const text = formatDiagnostics(diag);
    const url = feedbackIssueUrl("problem", diag);
    const everything = [JSON.stringify(diag), text, decodeURIComponent(url)];
    const leaks = [
      SECRET_NAME,
      "ACME",
      "Bolt hole",
      "Pump",
      "Flange",
      "Burst",
      ...SECRET_NUMBERS,
    ].filter((secret) => everything.some((text_) => text_.includes(secret)));
    expect(leaks, `leaked: ${leaks.join(", ")}`).toHaveLength(0);
  });

  test("before any geometry the placeholder property is not counted as a body", () => {
    const empty = buildDiagnostics(
      env,
      storeLike({ stepSurface: null, nodes: [], elements: [] }),
    );
    expect(empty.bodies, String(empty.bodies)).toBe(0);
  });
});

// ── Version stamps are validated, not passed through ─────────────────────────
describe("version stamps", () => {
  test("an app version that is not a version stamp is refused", () => {
    expect(() =>
      buildDiagnostics(
        { ...env, appVersion: "C:\\Users\\me\\bracket.step" },
        storeLike(),
      ),
    ).toThrow();
  });

  test("an engine id that is not engine-<hash> is refused", () => {
    expect(() =>
      buildDiagnostics({ ...env, engineId: "my-bracket" }, storeLike()),
    ).toThrow();
  });

  test("a build without an engine stamp says so", () => {
    expect(
      formatDiagnostics(
        buildDiagnostics({ ...env, engineId: null }, storeLike()),
      ).split("\n"),
    ).toContain("Engine: not recorded in this build");
  });
});

// ── The last error is redacted and capped ────────────────────────────────────
describe("the last error", () => {
  const shown = (lastShownError) =>
    buildDiagnostics({ ...env, lastShownError }, storeLike()).lastError;

  test("the model name, file names and coordinate triples are replaced", () => {
    expect(
      shown(
        `Volume meshing failed for ${SECRET_NAME}: ACME_part.STEP\nnode at (123.456, -7, 4.2e-7) is degenerate`,
      ),
    ).toBe(
      "Volume meshing failed for [name]: [file] node at [coordinates] is degenerate",
    );
  });

  // Real messages: coupling.ts quotes the coupling name, the worker names
  // materials and ties without quotes too.
  test("a quoted coupling name is redacted", () => {
    expect(
      shown(
        'Solver error: Coupling "ACME_Secret_Project" grips no node — pick the surface it couples to',
      ),
    ).toBe(
      'Solver error: Coupling "[redacted]" grips no node — pick the surface it couples to',
    );
  });

  test("unquoted material, group, tie and study names are redacted", () => {
    expect(
      shown(
        "Shell body uses ACME alloy X; Bolt hole ACME, Pump pressure, Flange weld 3 and Burst case Q3 failed",
      ),
    ).toBe("Shell body uses [name]; [name], [name], [name] and [name] failed");
  });

  test("a quoted name that is not in the store is redacted too", () => {
    expect(
      redactErrorText('Tie "Customer part B" connected no nodes', []),
    ).toBe('Tie "[redacted]" connected no nodes');
  });

  test("curly quotes are redacted like straight ones", () => {
    expect(redactErrorText("Material “Secret alloy” is invalid", [])).toBe(
      'Material "[redacted]" is invalid',
    );
  });

  test("a quoted number is a setting and stays", () => {
    expect(
      redactErrorText('Max element size must be positive — got "0".', []),
    ).toBe('Max element size must be positive — got "0".');
  });

  test("names match whole words only", () => {
    expect(redactErrorText("Weightless mesh; Weight failed", ["Weight"])).toBe(
      "Weightless mesh; [name] failed",
    );
  });

  test("plain error text survives", () => {
    expect(redactErrorText("Solver error: matrix is singular", [])).toBe(
      "Solver error: matrix is singular",
    );
  });

  test("control characters become spaces", () => {
    expect(redactErrorText("a\u0000b\u001bc", [])).toBe("a b c");
  });

  test("names shorter than three characters are not used to redact", () => {
    expect(redactErrorText("a bad mesh", ["a"])).toBe("a bad mesh");
  });

  test("an over-long error is cut with a visible marker", () => {
    const out = redactErrorText("x".repeat(MAX_ERROR_CHARS + 50), []);
    expect(out.endsWith(TRUNCATION_MARKER)).toBe(true);
    expect(out.length).toBe(MAX_ERROR_CHARS + TRUNCATION_MARKER.length);
  });

  // Worst case for the URL: every character encodes to 12 bytes.
  const emoji = "\u{1F4A5}".repeat(5000);

  test("a cut never splits a surrogate pair", () => {
    expect(() => encodeURIComponent(shown(emoji))).not.toThrow();
  });

  test(`the worst-case URL stays under ${MAX_ISSUE_URL_LENGTH} characters`, () => {
    const diag = buildDiagnostics(
      { ...env, lastShownError: emoji },
      storeLike(),
    );
    const url = feedbackIssueUrl("problem", diag);
    expect(url.length, String(url.length)).toBeLessThan(MAX_ISSUE_URL_LENGTH);
  });
});

// ── The URL targets the issue forms ──────────────────────────────────────────
describe("the prefilled issue URL", () => {
  const diag = buildDiagnostics(env, storeLike());

  test("a report opens the bug_report form on the KoFEM repository", () => {
    const url = new URL(feedbackIssueUrl("problem", diag));
    expect(url.origin).toBe("https://github.com");
    expect(url.pathname).toBe("/mkofler96/KoFEM/issues/new");
    expect(url.searchParams.get("template"), url.href).toBe("bug_report.yml");
  });

  test("the diagnostics prefill their form field verbatim", () => {
    const url = new URL(feedbackIssueUrl("problem", diag));
    expect(url.searchParams.get(DIAGNOSTICS_FIELD_ID)).toBe(
      formatDiagnostics(diag),
    );
  });

  test("the URL carries nothing but the template and the diagnostics", () => {
    const url = new URL(feedbackIssueUrl("problem", diag));
    expect([...url.searchParams.keys()]).toEqual([
      "template",
      DIAGNOSTICS_FIELD_ID,
    ]);
  });

  test("without opt-in only the template is passed", () => {
    const bare = new URL(feedbackIssueUrl("problem", null));
    expect([...bare.searchParams.keys()], bare.href).toEqual(["template"]);
  });

  test("a suggestion opens the feature_request form", () => {
    const idea = new URL(feedbackIssueUrl("improvement", null));
    expect(idea.searchParams.get("template"), idea.href).toBe(
      "feature_request.yml",
    );
    expect([...idea.searchParams.keys()], idea.href).toHaveLength(1);
  });

  test("a suggestion refuses diagnostics", () => {
    expect(() => feedbackIssueUrl("improvement", diag)).toThrow();
  });
});

// ── The forms exist and have the field the URL fills ─────────────────────────
describe("issue forms", () => {
  test.each(Object.values(FEEDBACK_TEMPLATES))("%s exists", (file) => {
    const path = new URL(
      `../../../.github/ISSUE_TEMPLATE/${file}`,
      import.meta.url,
    );
    expect(readFileSync(path, "utf8").length).toBeGreaterThan(0);
  });

  test(`${FEEDBACK_TEMPLATES.problem} has the "${DIAGNOSTICS_FIELD_ID}" field the URL prefills`, () => {
    const path = new URL(
      `../../../.github/ISSUE_TEMPLATE/${FEEDBACK_TEMPLATES.problem}`,
      import.meta.url,
    );
    expect(readFileSync(path, "utf8")).toMatch(
      new RegExp(`^\\s*id:\\s*${DIAGNOSTICS_FIELD_ID}\\s*$`, "m"),
    );
  });
});

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
describe("browser and OS families", () => {
  test.each(
    AGENTS.map(([agent, browser, platform]) => ({ agent, browser, platform })),
  )("$browser on $platform", ({ agent, browser, platform }) => {
    const got = describeBrowser(agent);
    expect(got.browser).toBe(browser);
    expect(got.os).toBe(platform);
  });
});
