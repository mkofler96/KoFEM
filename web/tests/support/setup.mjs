// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Loaded before every bun test file (bunfig.toml).
//
// The time budget of the node-side tests is set here, once. It is a watchdog
// for a hung solve or mesher, not a performance target: bun's default of 5 s
// is shorter than one engine solve on a busy machine, and a per-test number
// would be a guess about the machine. A test that needs longer than this is
// stuck.
import { setDefaultTimeout } from "bun:test";

const WATCHDOG_MS = 5 * 60 * 1000;

setDefaultTimeout(WATCHDOG_MS);
