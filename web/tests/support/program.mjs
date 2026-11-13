// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// The example and Theory Guide programs are command-line tools: they print a
// report and exit non-zero when a published number no longer holds. Their
// tests run them at that boundary, the way their usage lines say.

import { spawn } from "bun";
import { fileURLToPath } from "node:url";

const WEB_DIR = fileURLToPath(new URL("../../", import.meta.url));

/**
 * Run `bun <file> [...args]` from web/ and return its exit code and combined
 * output. `file` is relative to web/, as in the program's usage line.
 */
export async function runProgram(file, args = []) {
  const proc = spawn(["bun", file, ...args], {
    cwd: WEB_DIR,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { exitCode, output: `${stdout}${stderr}` };
}
