// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Unit tests for playwright-browser.ts — which Chromium the Playwright configs
// launch. CI installs the pinned headless shell and must keep using it; cloud
// sessions ship a different, pre-installed Chromium that the config must find
// without a per-session override (KOF-321).

import { describe, expect, test } from "bun:test";
import {
  BROWSER_ENV_VAR,
  PREINSTALLED_CHROMIUM,
  resolveChromiumExecutable,
} from "../../playwright-browser.ts";

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

describe("pinned headless shell installed (CI)", () => {
  test("uses Playwright's own browser", () => {
    expect(
      resolve({ files: [PINNED_SHELL_MARKER, PREINSTALLED_CHROMIUM] }),
    ).toBeUndefined();
  });
});

describe("pinned headless shell missing (cloud session)", () => {
  test("uses the pre-installed Chromium", () => {
    expect(resolve({ files: [PREINSTALLED_CHROMIUM] })).toBe(
      PREINSTALLED_CHROMIUM,
    );
  });

  test("leaves Playwright to report the missing browser when none is installed", () => {
    expect(resolve()).toBeUndefined();
  });
});

describe(`${BROWSER_ENV_VAR} override`, () => {
  test("wins over the pinned and pre-installed browsers", () => {
    expect(
      resolve({
        env: { [BROWSER_ENV_VAR]: CUSTOM },
        files: [CUSTOM, PINNED_SHELL_MARKER, PREINSTALLED_CHROMIUM],
      }),
    ).toBe(CUSTOM);
  });

  test("throws when it points at a missing file", () => {
    expect(() => resolve({ env: { [BROWSER_ENV_VAR]: CUSTOM } })).toThrow(
      BROWSER_ENV_VAR,
    );
    expect(() => resolve({ env: { [BROWSER_ENV_VAR]: CUSTOM } })).toThrow(
      CUSTOM,
    );
  });

  test("an empty value counts as unset", () => {
    expect(
      resolve({
        env: { [BROWSER_ENV_VAR]: "" },
        files: [PREINSTALLED_CHROMIUM],
      }),
    ).toBe(PREINSTALLED_CHROMIUM);
  });
});

describe("pinned path outside a chromium-<revision> directory", () => {
  test("throws instead of guessing", () => {
    expect(() => resolve({ pinned: "/somewhere/chrome" })).toThrow(
      "/somewhere/chrome",
    );
  });
});
