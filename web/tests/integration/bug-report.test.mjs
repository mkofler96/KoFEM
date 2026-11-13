// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Unit tests for src/lib/zip.ts and src/lib/bugReport.ts (KOF-202): a problem
// report ZIP carries the analysis, the CAD file unless left out, the versions,
// the log and the last error; it opens again to the same analysis and CAD
// bytes; anything that is not a report KoFEM wrote is refused with a reason;
// and the mail link goes to the report address with the file name in its
// body. The dialog is exercised in the browser by tests/feedback.spec.ts.

import { beforeAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createZip, crc32, looksLikeZip, readZip } from "../../src/lib/zip.ts";

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
} = await import("../../src/lib/bugReport.ts");
const { parseAnalysisFile, serializeAnalysis } =
  await import("../../src/lib/analysisFile.ts");

const enc = new TextEncoder();
const dec = new TextDecoder();
const created = new Date(2026, 10, 10, 21, 14, 5);

describe("zip", () => {
  const big = enc.encode("node ".repeat(10_000));
  const tiny = enc.encode("x");
  let zip;

  beforeAll(async () => {
    zip = await createZip(
      [
        { name: "big.txt", data: big },
        { name: "tiny.bin", data: tiny },
        { name: "ümlaut.txt", data: new Uint8Array(0) },
      ],
      new Date(2026, 10, 10, 21, 14, 30),
    );
  });

  test("crc32 of '123456789' is CBF43926", () => {
    expect(crc32(enc.encode("123456789"))).toBe(0xcbf43926);
  });

  test("looksLikeZip recognises the archive", () => {
    expect(looksLikeZip(zip)).toBe(true);
  });

  test("a repetitive entry is compressed", () => {
    expect(zip.length, `${zip.length} bytes`).toBeLessThan(big.length / 10);
  });

  test("entries round-trip in order with names and bytes", async () => {
    const back = await readZip(zip);
    expect(back).toHaveLength(3);
    expect(back[0].name).toBe("big.txt");
    expect(dec.decode(back[0].data)).toBe(dec.decode(big));
    expect(back[1].name).toBe("tiny.bin");
    expect(back[1].data).toHaveLength(1);
    expect(back[1].data[0]).toBe(tiny[0]);
    expect(back[2].name).toBe("ümlaut.txt");
    expect(back[2].data).toHaveLength(0);
  });

  test("Python's zipfile reads and verifies it", () => {
    // The archive must open with a standard tool too: maintainers unzip reports.
    const dir = mkdtempSync(join(tmpdir(), "kofem-zip-"));
    writeFileSync(join(dir, "r.zip"), zip);
    const listing = execFileSync("python3", [
      "-c",
      "import sys,zipfile; z=zipfile.ZipFile(sys.argv[1]); assert z.testzip() is None; print(','.join(z.namelist()))",
      join(dir, "r.zip"),
    ])
      .toString()
      .trim();
    expect(listing).toBe("big.txt,tiny.bin,ümlaut.txt");
  });

  test("a checksum mismatch is refused", async () => {
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
    await expect(readZip(corruptCrc)).rejects.toThrow(/checksum/);
  });

  test("a file that is no ZIP is refused", async () => {
    await expect(readZip(enc.encode("<VTKFile/>"))).rejects.toThrow(
      /no end record/,
    );
  });

  test("looksLikeZip is false for a .vtu", () => {
    expect(looksLikeZip(enc.encode("<?xml"))).toBe(false);
  });

  test("repeated entry names are refused", async () => {
    await expect(
      createZip(
        [
          { name: "a", data: tiny },
          { name: "a", data: tiny },
        ],
        new Date(),
      ),
    ).rejects.toThrow(/repeated/);
  });
});

describe("problem report", () => {
  let vtu;
  let analysis;
  let step;
  let diagnostics;
  let rawError;
  let withCad;
  let withoutCad;
  let manifest;

  beforeAll(async () => {
    vtu = readFileSync(
      new URL(
        "../../../examples/gallery/site/cantilever-beam.vtu",
        import.meta.url,
      ),
      "utf8",
    );
    analysis = parseAnalysisFile(vtu);
    step = readFileSync(new URL("../fixtures/tube.stp", import.meta.url));
    diagnostics = {
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
    rawError = 'Coupling "Bolt flange" has no faces';
    const logs = {
      mesh: ["Netgen: meshing", "Netgen: done"],
      solve: Array.from(
        { length: MAX_LOG_LINES + 20 },
        (_, index) => `iteration ${index}`,
      ),
      optimize: [],
    };
    withCad = await buildReport({
      analysis,
      cad: { bytes: new Uint8Array(step), format: "step" },
      diagnostics,
      lastError: rawError,
      logs,
      created,
    });
    withoutCad = await buildReport({
      analysis,
      cad: null,
      diagnostics,
      lastError: null,
      logs: {},
      created,
    });
    manifest = JSON.parse(
      dec.decode(
        (await readZip(withCad)).find((entry) => entry.name === "report.json")
          .data,
      ),
    );
  });

  describe("report with CAD", () => {
    test("the report holds manifest, analysis, CAD file and log", async () => {
      const names = (await readZip(withCad)).map((entry) => entry.name);
      expect(names.join(",")).toBe(
        "report.json,analysis.vtu,geometry.step,log.txt",
      );
    });

    test("the analysis re-opens identical (re-serialises to the same file)", async () => {
      const opened = await parseReport(withCad);
      expect(serializeAnalysis(opened.analysis)).toBe(
        serializeAnalysis(analysis),
      );
    });

    test("the CAD bytes and format come back unchanged", async () => {
      const opened = await parseReport(withCad);
      expect(opened.cad).not.toBeNull();
      expect(opened.cad.format).toBe("step");
      expect(Buffer.from(opened.cad.bytes)).toEqual(step);
    });

    test("the manifest carries versions, step and the verbatim last error", async () => {
      const opened = await parseReport(withCad);
      expect(opened.manifest.appVersion).toBe(diagnostics.appVersion);
      expect(opened.manifest.engineId).toBe(diagnostics.engineId);
      expect(opened.manifest.browser).toBe("Chrome 130");
      expect(opened.manifest.step).toBe("results");
      expect(opened.manifest.lastError).toBe(rawError);
      expect(opened.manifest.created).toBe(created.toISOString());
    });

    test("the log keeps the newest lines and says how many it dropped", async () => {
      const opened = await parseReport(withCad);
      expect(opened.log).toContain("== mesh ==\nNetgen: meshing");
      expect(opened.log).toContain("(20 earlier lines left out)");
      expect(opened.log).not.toContain("iteration 19\n");
      expect(opened.log).toContain(`iteration ${MAX_LOG_LINES + 19}`);
      expect(opened.log).not.toContain("== optimize ==");
    });

    test("an empty log says so", () => {
      expect(formatReportLog({ mesh: [] })).toBe("(no log)\n");
    });
  });

  describe("report without CAD", () => {
    test("no CAD entry, and the manifest says none", async () => {
      const bare = await parseReport(withoutCad);
      expect(bare.cad).toBeNull();
      expect(bare.manifest.cad).toBeNull();
      expect(
        (await readZip(withoutCad)).some((entry) =>
          entry.name.startsWith("geometry"),
        ),
      ).toBe(false);
    });

    test("the zip holds no byte of the CAD file", () => {
      expect(
        Buffer.from(withoutCad).includes(Buffer.from(step.subarray(0, 200))),
      ).toBe(false);
    });
  });

  describe("refusals", () => {
    function zipOf(entries) {
      return createZip(
        entries.map(([name, text]) => ({ name, data: enc.encode(text) })),
        created,
      );
    }
    const goodEntries = (value) => [
      ["report.json", JSON.stringify(value)],
      ["analysis.vtu", vtu],
      ["geometry.step", "ISO-10303-21;"],
      ["log.txt", ""],
    ];
    const cases = [
      [
        "a zip without report.json",
        () => zipOf([["analysis.vtu", vtu]]),
        /no report\.json/,
      ],
      [
        "a wrong format marker",
        () => zipOf(goodEntries({ ...manifest, format: "something-else" })),
        /wrong format marker/,
      ],
      [
        "a newer report version",
        () => zipOf(goodEntries({ ...manifest, version: 2 })),
        /version 2 is not supported/,
      ],
      [
        "a missing CAD file the manifest names",
        () =>
          zipOf(
            goodEntries(manifest).filter(([name]) => name !== "geometry.step"),
          ),
        /missing geometry\.step/,
      ],
      [
        "an extra file",
        () => zipOf([...goodEntries(manifest), ["notes.txt", "hi"]]),
        /does not write: notes\.txt/,
      ],
      [
        "a CAD entry under another name",
        () =>
          zipOf(
            goodEntries({
              ...manifest,
              cad: { file: "../x.step", format: "step" },
            }),
          ),
        /"cad" must be/,
      ],
      [
        "an analysis that is not a KoFEM file",
        () =>
          zipOf(
            goodEntries(manifest).map(([name, text]) => [
              name,
              name === "analysis.vtu" ? "<VTKFile/>" : text,
            ]),
          ),
        /analysis\.vtu is not a valid analysis/,
      ],
      ["plain text", () => enc.encode("hello"), /not a KoFEM problem report/],
    ];

    test.each(cases)("refuses %s", async (_what, build, reason) => {
      const bytes = await build();
      await expect(parseReport(bytes)).rejects.toThrow(reason);
    });
  });
});

describe("mail", () => {
  const fileName = reportFileName("Wall bracket", created);

  test("the report address is support@kofem.org", () => {
    expect(REPORT_EMAIL).toBe("support@kofem.org");
  });

  test("file name carries the model and local time", () => {
    expect(fileName).toBe("kofem-report-Wall_bracket-20261110-2114.zip");
  });

  test("an unnamed model gets a plain name", () => {
    expect(reportFileName("  ", created)).toBe(
      "kofem-report-20261110-2114.zip",
    );
  });

  test("the mail link goes to the report address", () => {
    const mailto = reportMailtoUrl(fileName, "v0.6.0");
    const mail = new URL(mailto);
    expect(mail.protocol).toBe("mailto:");
    expect(mail.pathname).toBe("support@kofem.org");
  });

  test("subject names the version; body names the file to attach", () => {
    const mailto = reportMailtoUrl(fileName, "v0.6.0");
    const mail = new URL(mailto);
    expect(decodeURIComponent(mail.searchParams.get("subject") ?? "")).toBe(
      "KoFEM problem report (v0.6.0)",
    );
    expect(mailto).toContain(encodeURIComponent(fileName));
    expect(mailto).not.toContain("+");
  });

  test.each(["", "support at kofem.org", "support@", "a@b"])(
    'refuses to build a link to "%s"',
    (bad) => {
      expect(() => reportMailtoUrl(fileName, "v0.6.0", bad)).toThrow(
        /not an email address/,
      );
    },
  );
});
