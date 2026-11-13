// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Unit tests for playwright-browser.ts — which Chromium the Playwright configs
// launch. CI installs the pinned headless shell and must keep using it; cloud
// sessions ship a different, pre-installed Chromium that the config must find
// without a per-session override (KOF-321).
//
// Run:  bun tests/test_playwright_browser.mjs

import {
  BROWSER_ENV_VAR,
  PREINSTALLED_CHROMIUM,
  resolveChromiumExecutable,
} from "../playwright-browser.ts";

let failures = 0;
function check(name, cond, detail = "") {
  if (cond) {
    console.log(`  [PASS] ${name}`);
  } else {
    failures++;
    console.log(`  [FAIL] ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

// Playwright's pinned Chromium, as chromium.executablePath() reports it.
const PINNED_LINUX =
  "/root/.cache/ms-playwright/chromium-1223/chrome-linux64/chrome";
const PINNED_SHELL_MARKER =
  "/root/.cache/ms-playwright/chromium_headless_shell-1223/INSTALLATION_COMPLETE";
const CUSTOM = "/usr/bin/chromium";

function resolve({ env = {}, files = [], pinned = PINNED_LINUX } = {}) {
  const present = new Set(files);
  return resolveChromiumExecutable({
    env,
    pinnedChromium: pinned,
    exists: (path) => present.has(path),
  });
}

console.log("Pinned headless shell installed (CI)");
check(
  "uses Playwright's own browser",
  resolve({ files: [PINNED_SHELL_MARKER, PREINSTALLED_CHROMIUM] }) ===
    undefined,
);

console.log("Pinned headless shell missing (cloud session)");
check(
  "uses the pre-installed Chromium",
  resolve({ files: [PREINSTALLED_CHROMIUM] }) === PREINSTALLED_CHROMIUM,
);
check(
  "leaves Playwright to report the missing browser when none is installed",
  resolve() === undefined,
);

console.log(`${BROWSER_ENV_VAR} override`);
check(
  "wins over the pinned and pre-installed browsers",
  resolve({
    env: { [BROWSER_ENV_VAR]: CUSTOM },
    files: [CUSTOM, PINNED_SHELL_MARKER, PREINSTALLED_CHROMIUM],
  }) === CUSTOM,
);
let thrown = "";
try {
  resolve({ env: { [BROWSER_ENV_VAR]: CUSTOM } });
} catch (err) {
  thrown = err instanceof Error ? err.message : String(err);
}
check(
  "throws when it points at a missing file",
  thrown.includes(BROWSER_ENV_VAR) && thrown.includes(CUSTOM),
  thrown,
);
check(
  "an empty value counts as unset",
  resolve({
    env: { [BROWSER_ENV_VAR]: "" },
    files: [PREINSTALLED_CHROMIUM],
  }) === PREINSTALLED_CHROMIUM,
);

console.log("Pinned path outside a chromium-<revision> directory");
thrown = "";
try {
  resolve({ pinned: "/somewhere/chrome" });
} catch (err) {
  thrown = err instanceof Error ? err.message : String(err);
}
check(
  "throws instead of guessing",
  thrown.includes("/somewhere/chrome"),
  thrown,
);

if (failures > 0) {
  console.log(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nAll checks passed");
