// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Unit tests for src/lib/zip.ts and src/lib/bugReport.ts (KOF-202): a problem
// report ZIP carries the analysis, the CAD file unless left out, the versions,
// the log and the last error; it opens again to the same analysis and CAD
// bytes; anything that is not a report KoFEM wrote is refused with a reason;
// and the mail link goes to the report address with the file name in its
// body. The dialog is exercised in the browser by tests/feedback.spec.ts.
//
// Run:  bun tests/test_bug_report.mjs

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createZip, crc32, looksLikeZip, readZip } from "../src/lib/zip.ts";

// lib/analysisFile reaches the model store, which reads the screen size when
// and saved sidebar width when it is created; give it a desktop-sized window
// and an empty storage.
globalThis.localStorage ??= {
  getItem: () => null,
  setItem() {
    // Nothing is persisted in this test.
  },
  removeItem() {
    // Nothing is persisted in this test.
  },
};
globalThis.window ??= {
  matchMedia: () => ({
    matches: false,
    addEventListener() {
      // The screen size never changes in this test.
    },
    removeEventListener() {
      // The screen size never changes in this test.
    },
  }),
};
const {
  MAX_LOG_LINES,
  REPORT_EMAIL,
  buildReport,
  formatReportLog,
  parseReport,
  reportFileName,
  reportMailtoUrl,
} = await import("../src/lib/bugReport.ts");
const { parseAnalysisFile, serializeAnalysis } =
  await import("../src/lib/analysisFile.ts");

let failures = 0;
function check(name, cond, detail = "") {
  if (cond) {
    console.log(`  [PASS] ${name}`);
  } else {
    failures++;
    console.log(`  [FAIL] ${name}${detail ? ` — ${detail}` : ""}`);
  }
}
async function rejection(promise) {
  try {
    await promise;
    return null;
  } catch (err) {
    return err.message;
  }
}

const enc = new TextEncoder();
const dec = new TextDecoder();

console.log("zip");
check(
  "crc32 of '123456789' is CBF43926",
  crc32(enc.encode("123456789")) === 0xcbf43926,
);
{
  const big = enc.encode("node ".repeat(10_000));
  const tiny = enc.encode("x");
  const zip = await createZip(
    [
      { name: "big.txt", data: big },
      { name: "tiny.bin", data: tiny },
      { name: "ümlaut.txt", data: new Uint8Array(0) },
    ],
    new Date(2026, 10, 10, 21, 14, 30),
  );
  check("looksLikeZip recognises the archive", looksLikeZip(zip));
  check(
    "a repetitive entry is compressed",
    zip.length < big.length / 10,
    `${zip.length} bytes`,
  );
  const back = await readZip(zip);
  check(
    "entries round-trip in order with names and bytes",
    back.length === 3 &&
      back[0].name === "big.txt" &&
      dec.decode(back[0].data) === dec.decode(big) &&
      back[1].name === "tiny.bin" &&
      back[1].data.length === 1 &&
      back[1].data[0] === tiny[0] &&
      back[2].name === "ümlaut.txt" &&
      back[2].data.length === 0,
  );
  // The archive must open with a standard tool too: maintainers unzip reports.
  const dir = mkdtempSync(join(tmpdir(), "kofem-zip-"));
  writeFileSync(join(dir, "r.zip"), zip);
  let listing = "";
  try {
    listing = execFileSync("python3", [
      "-c",
      "import sys,zipfile; z=zipfile.ZipFile(sys.argv[1]); assert z.testzip() is None; print(','.join(z.namelist()))",
      join(dir, "r.zip"),
    ])
      .toString()
      .trim();
  } catch (err) {
    listing = `python3 zipfile failed: ${err.message}`;
  }
  check(
    "Python's zipfile reads and verifies it",
    listing === "big.txt,tiny.bin,ümlaut.txt",
    listing,
  );

  const corruptCrc = zip.slice();
  // The CRC of the first entry lives at offset 14 of its local header and 16
  // of its central record; change the central one.
  const view = new DataView(corruptCrc.buffer);
  const centralAt = view.getUint32(corruptCrc.length - 22 + 16, true);
  view.setUint32(
    centralAt + 16,
    view.getUint32(centralAt + 16, true) ^ 1,
    true,
  );
  check(
    "a checksum mismatch is refused",
    /checksum/.test((await rejection(readZip(corruptCrc))) ?? ""),
  );
  check(
    "a file that is no ZIP is refused",
    /no end record/.test(
      (await rejection(readZip(enc.encode("<VTKFile/>")))) ?? "",
    ),
  );
  check("looksLikeZip is false for a .vtu", !looksLikeZip(enc.encode("<?xml")));
  check(
    "repeated entry names are refused",
    /repeated/.test(
      (await rejection(
        createZip(
          [
            { name: "a", data: tiny },
            { name: "a", data: tiny },
          ],
          new Date(),
        ),
      )) ?? "",
    ),
  );
}

console.log("report");
const vtu = readFileSync(
  new URL("../../examples/gallery/site/cantilever-beam.vtu", import.meta.url),
  "utf8",
);
const analysis = parseAnalysisFile(vtu);
const step = readFileSync(new URL("./fixtures/tube.stp", import.meta.url));
const diagnostics = {
  appVersion: "v0.6.0-dev-1cbe6bb",
  engineId: "engine-b3e98c12987e",
  browser: "Chrome 130",
  os: "Linux",
  webAssembly: true,
  webGl: "WebGL 2",
  bodies: 1,
  nodes: analysis.nodes.length,
  elements: analysis.elements.length,
  supports: 1,
  loads: 1,
  step: "results",
  lastError: 'Coupling "[redacted]" has no faces',
};
const created = new Date(2026, 10, 10, 21, 14, 5);
const rawError = 'Coupling "Bolt flange" has no faces';
const logs = {
  mesh: ["Netgen: meshing", "Netgen: done"],
  solve: Array.from({ length: MAX_LOG_LINES + 20 }, (_, i) => `iteration ${i}`),
  optimize: [],
};

const withCad = await buildReport({
  analysis,
  cad: { bytes: new Uint8Array(step), format: "step" },
  diagnostics,
  lastError: rawError,
  logs,
  created,
});
const names = (await readZip(withCad)).map((e) => e.name);
check(
  "the report holds manifest, analysis, CAD file and log",
  names.join(",") === "report.json,analysis.vtu,geometry.step,log.txt",
  names.join(","),
);
const opened = await parseReport(withCad);
check(
  "the analysis re-opens identical (re-serialises to the same file)",
  serializeAnalysis(opened.analysis) === serializeAnalysis(analysis),
);
check(
  "the CAD bytes and format come back unchanged",
  opened.cad !== null &&
    opened.cad.format === "step" &&
    Buffer.from(opened.cad.bytes).equals(step),
);
check(
  "the manifest carries versions, step and the verbatim last error",
  opened.manifest.appVersion === diagnostics.appVersion &&
    opened.manifest.engineId === diagnostics.engineId &&
    opened.manifest.browser === "Chrome 130" &&
    opened.manifest.step === "results" &&
    opened.manifest.lastError === rawError &&
    opened.manifest.created === created.toISOString(),
);
check(
  "the log keeps the newest lines and says how many it dropped",
  opened.log.includes("== mesh ==\nNetgen: meshing") &&
    opened.log.includes("(20 earlier lines left out)") &&
    !opened.log.includes("iteration 19\n") &&
    opened.log.includes(`iteration ${MAX_LOG_LINES + 19}`) &&
    !opened.log.includes("== optimize =="),
);
check("an empty log says so", formatReportLog({ mesh: [] }) === "(no log)\n");

const withoutCad = await buildReport({
  analysis,
  cad: null,
  diagnostics,
  lastError: null,
  logs: {},
  created,
});
const bare = await parseReport(withoutCad);
check(
  "Without CAD: no CAD entry, and the manifest says none",
  bare.cad === null &&
    bare.manifest.cad === null &&
    !(await readZip(withoutCad)).some((e) => e.name.startsWith("geometry")),
);
check(
  "Without CAD: the zip holds no byte of the CAD file",
  !Buffer.from(withoutCad).includes(Buffer.from(step.subarray(0, 200))),
);

console.log("refusals");
function zipOf(entries) {
  return createZip(
    entries.map(([name, text]) => ({ name, data: enc.encode(text) })),
    created,
  );
}
const manifest = JSON.parse(
  dec.decode(
    (await readZip(withCad)).find((e) => e.name === "report.json").data,
  ),
);
const goodEntries = (m) => [
  ["report.json", JSON.stringify(m)],
  ["analysis.vtu", vtu],
  ["geometry.step", "ISO-10303-21;"],
  ["log.txt", ""],
];
const cases = [
  [
    "a zip without report.json",
    await zipOf([["analysis.vtu", vtu]]),
    /no report\.json/,
  ],
  [
    "a wrong format marker",
    await zipOf(goodEntries({ ...manifest, format: "something-else" })),
    /wrong format marker/,
  ],
  [
    "a newer report version",
    await zipOf(goodEntries({ ...manifest, version: 2 })),
    /version 2 is not supported/,
  ],
  [
    "a missing CAD file the manifest names",
    await zipOf(goodEntries(manifest).filter(([n]) => n !== "geometry.step")),
    /missing geometry\.step/,
  ],
  [
    "an extra file",
    await zipOf([...goodEntries(manifest), ["notes.txt", "hi"]]),
    /does not write: notes\.txt/,
  ],
  [
    "a CAD entry under another name",
    await zipOf(
      goodEntries({ ...manifest, cad: { file: "../x.step", format: "step" } }),
    ),
    /"cad" must be/,
  ],
  [
    "an analysis that is not a KoFEM file",
    await zipOf(
      goodEntries(manifest).map(([n, t]) => [
        n,
        n === "analysis.vtu" ? "<VTKFile/>" : t,
      ]),
    ),
    /analysis\.vtu is not a valid analysis/,
  ],
  ["plain text", enc.encode("hello"), /not a KoFEM problem report/],
];
for (const [what, bytes, reason] of cases) {
  const message = await rejection(parseReport(bytes));
  check(
    `refuses ${what}`,
    message !== null && reason.test(message),
    message ?? "accepted",
  );
}

console.log("mail");
check(
  "the report address is support@kofem.org",
  REPORT_EMAIL === "support@kofem.org",
);
const fileName = reportFileName("Wall bracket", created);
check(
  "file name carries the model and local time",
  fileName === "kofem-report-Wall_bracket-20261110-2114.zip",
  fileName,
);
check(
  "an unnamed model gets a plain name",
  reportFileName("  ", created) === "kofem-report-20261110-2114.zip",
);
const mailto = reportMailtoUrl(fileName, "v0.6.0");
const mail = new URL(mailto);
check(
  "the mail link goes to the report address",
  mail.protocol === "mailto:" && mail.pathname === "support@kofem.org",
  mailto,
);
check(
  "subject names the version; body names the file to attach",
  decodeURIComponent(mail.searchParams.get("subject") ?? "") ===
    "KoFEM problem report (v0.6.0)" &&
    mailto.includes(encodeURIComponent(fileName)) &&
    !mailto.includes("+"),
);
for (const bad of ["", "support at kofem.org", "support@", "a@b"]) {
  let message = "";
  try {
    reportMailtoUrl(fileName, "v0.6.0", bad);
  } catch (err) {
    message = err.message;
  }
  check(
    `refuses to build a link to "${bad}"`,
    /not an email address/.test(message),
  );
}

if (failures > 0) {
  console.log(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nAll bug-report checks passed");
