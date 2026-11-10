// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// mergeChannels: the log drawer shows all worker log channels as one
// chronological stream, each line tagged with its channel.
import assert from "node:assert/strict";
import { mergeChannels } from "../src/hooks/useWorkerLogs.ts";

const merged = mergeChannels({
  solve: [{ id: 2, text: "solving" }],
  mesh: [
    { id: 0, text: "meshing" },
    { id: 3, text: "meshed" },
  ],
  optimize: [{ id: 1, text: "iter" }],
});
assert.deepEqual(
  merged.map((e) => [e.id, e.channel]),
  [
    [0, "mesh"],
    [1, "optimize"],
    [2, "solve"],
    [3, "mesh"],
  ],
);
assert.deepEqual(mergeChannels({}), []);
console.log("test_log_merge: ok");
