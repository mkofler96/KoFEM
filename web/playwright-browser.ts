// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

import path from "path";

// Which Chromium the Playwright configs launch.
//
// 1. PLAYWRIGHT_CHROMIUM_EXECUTABLE, when set, names the browser explicitly.
// 2. The headless shell pinned by the installed Playwright version, when it is
//    installed (CI runs `playwright install --only-shell chromium`).
// 3. The Chromium pre-installed in Claude Code cloud sessions. Its revision
//    changes with the image, so use the stable symlink, not a versioned path.
// 4. Otherwise Playwright's own launch error, which says how to install it.

export const BROWSER_ENV_VAR = "PLAYWRIGHT_CHROMIUM_EXECUTABLE";
export const PREINSTALLED_CHROMIUM = "/opt/pw-browsers/chromium";

export interface BrowserLookup {
  env: Record<string, string | undefined>;
  /** chromium.executablePath(): the pinned full Chromium, installed or not. */
  pinnedChromium: string;
  exists: (file: string) => boolean;
}

/** Marker Playwright writes once the pinned headless shell is installed. */
function pinnedHeadlessShellMarker(pinnedChromium: string): string {
  let dir = path.dirname(pinnedChromium);
  while (dir !== path.dirname(dir)) {
    const match = /^chromium-(\d+)$/.exec(path.basename(dir));
    if (match) {
      return path.join(
        path.dirname(dir),
        `chromium_headless_shell-${match[1]}`,
        "INSTALLATION_COMPLETE",
      );
    }
    dir = path.dirname(dir);
  }
  throw new Error(
    `Cannot find the chromium-<revision> directory in Playwright's browser path ${pinnedChromium}`,
  );
}

/** Executable to launch, or undefined to let Playwright use its pinned browser. */
export function resolveChromiumExecutable({
  env,
  pinnedChromium,
  exists,
}: BrowserLookup): string | undefined {
  const override = env[BROWSER_ENV_VAR];
  if (override) {
    if (!exists(override)) {
      throw new Error(
        `${BROWSER_ENV_VAR} points at ${override}, which does not exist`,
      );
    }
    return override;
  }
  if (exists(pinnedHeadlessShellMarker(pinnedChromium))) return undefined;
  if (exists(PREINSTALLED_CHROMIUM)) return PREINSTALLED_CHROMIUM;
  return undefined;
}
