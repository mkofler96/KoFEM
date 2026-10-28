// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// The engine build this bundle was made with: the `.engine-id` stamp that
// scripts/fetch-wasm-engine.sh and scripts/build-wasm.sh write next to the
// binary. A glob rather than a plain import, because build-wasm.sh writes no
// stamp when it cannot compute the ID — the build must not fail over a
// diagnostic. `exhaustive` lets the glob see the dotfile.
const stamps = import.meta.glob<string>("../wasm/pkg/.engine-id", {
  query: "?raw",
  import: "default",
  eager: true,
  exhaustive: true,
});

const stamp = Object.values(stamps)[0];

/** `engine-<hash>`, or null when this build carries no stamp. */
export const ENGINE_ID: string | null =
  stamp === undefined ? null : stamp.trim();
