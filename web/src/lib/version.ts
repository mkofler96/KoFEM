// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// App version stamp shown in the status bar. CI injects VITE_GIT_VERSION
// (the release version plus the short commit, e.g. "v0.1.0-26a1531") at build
// time via web/Dockerfile, so the displayed version always names the published
// commit.
// In local dev the var is unset, so we fall back to "dev".
// eslint-disable-next-line kofem/no-silent-fallback -- VITE_GIT_VERSION is only injected by CI builds; local dev has no version stamp
export const APP_VERSION = import.meta.env.VITE_GIT_VERSION ?? "dev";
