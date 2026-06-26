// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// App version stamp shown in the status bar. CI injects VITE_GIT_VERSION
// (the output of `git describe --tags`, e.g. "v0.0.1-beta1") at build time via
// web/Dockerfile, so the displayed version always matches the published commit.
// In local dev the var is unset, so we fall back to "dev".
export const APP_VERSION = import.meta.env.VITE_GIT_VERSION ?? "dev";
