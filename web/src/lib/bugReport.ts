// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Problem reports (KOF-202): a ZIP the user downloads and emails to the
// maintainer. KoFEM sends nothing itself — it saves the file and opens the
// user's email program with the address, a subject and a short body filled in;
// the user attaches the ZIP and sends it.
//
// A report holds everything needed to reproduce the problem:
//
//   report.json    format marker and version, app and engine versions,
//                  browser and OS, the current step, the last error the UI
//                  showed (verbatim), and which files follow
//   analysis.vtu   the analysis file (lib/analysisFile): settings, supports,
//                  loads, mesh, and results when solved
//   geometry.step  the CAD file the model is built from — left out when the
//    or .iges      user chose "Without CAD", or when there is none (an
//                  analysis loaded from a .vtu carries no CAD file)
//   log.txt        the recent mesher, solver and optimizer log
//
// The same app opens a report again (parseReport) to reproduce the problem.
// It accepts only a report it could have written: anything else is refused
// with the reason.

import {
  parseAnalysisFile,
  serializeAnalysis,
  type AnalysisState,
} from "./analysisFile";
import type { GeometryFormat } from "../store/geometrySlice";
import type { TreeGroup } from "../store/viewSlice";
import type { Diagnostics } from "./feedback";
import { createZip, readZip, type ZipEntry } from "./zip";

// Where reports go. Public: the app shows it and puts it in the mail link.
export const REPORT_EMAIL = "support@kofem.org";

export const REPORT_FORMAT = "kofem-report";
export const REPORT_VERSION = 1;
export const REPORT_MANIFEST = "report.json";
export const REPORT_ANALYSIS = "analysis.vtu";
export const REPORT_LOG = "log.txt";
const CAD_FILES: Record<GeometryFormat, string> = {
  step: "geometry.step",
  iges: "geometry.iges",
};
// The newest log lines kept per log (mesh, solve, optimize).
export const MAX_LOG_LINES = 500;

const EMAIL_RE = /^[^\s@<>()[\]\\,;:"]+@[a-z0-9-]+(?:\.[a-z0-9-]+)+$/iu;

export interface ReportManifest {
  readonly format: typeof REPORT_FORMAT;
  readonly version: typeof REPORT_VERSION;
  readonly created: string;
  readonly appVersion: string;
  readonly engineId: string | null;
  readonly browser: string;
  readonly os: string;
  readonly webAssembly: boolean;
  readonly webGl: string;
  readonly step: TreeGroup;
  readonly lastError: string | null;
  readonly analysis: typeof REPORT_ANALYSIS;
  readonly cad: {
    readonly file: string;
    readonly format: GeometryFormat;
  } | null;
  readonly log: typeof REPORT_LOG;
}

export interface ReportCad {
  readonly bytes: Uint8Array;
  readonly format: GeometryFormat;
}

export interface ReportInput {
  readonly analysis: AnalysisState;
  // Null when the user chose "Without CAD" or there is no CAD file.
  readonly cad: ReportCad | null;
  // Version, browser and environment facts, as the feedback dialog gathers
  // them. Its redacted error text is not used: the report carries the
  // verbatim one (`lastError`), since it goes to the maintainer only.
  readonly diagnostics: Diagnostics;
  readonly lastError: string | null;
  // Log lines per log, oldest first.
  readonly logs: Readonly<Record<string, readonly string[]>>;
  readonly created: Date;
}

/** The recent log as plain text, one section per log, newest lines kept. */
export function formatReportLog(
  logs: Readonly<Record<string, readonly string[]>>,
): string {
  const sections = Object.entries(logs)
    .filter(([, lines]) => lines.length > 0)
    .map(([channel, lines]) => {
      const kept = lines.slice(-MAX_LOG_LINES);
      const cut = lines.length - kept.length;
      return [
        `== ${channel} ==`,
        ...(cut > 0 ? [`(${cut} earlier lines left out)`] : []),
        ...kept,
      ].join("\n");
    });
  return sections.length > 0 ? `${sections.join("\n\n")}\n` : "(no log)\n";
}

/** Build the report ZIP. */
export function buildReport(input: ReportInput): Promise<Uint8Array> {
  const diag = input.diagnostics;
  const manifest: ReportManifest = {
    format: REPORT_FORMAT,
    version: REPORT_VERSION,
    created: input.created.toISOString(),
    appVersion: diag.appVersion,
    engineId: diag.engineId,
    browser: diag.browser,
    os: diag.os,
    webAssembly: diag.webAssembly,
    webGl: diag.webGl,
    step: diag.step,
    lastError: input.lastError,
    analysis: REPORT_ANALYSIS,
    cad: input.cad && {
      file: CAD_FILES[input.cad.format],
      format: input.cad.format,
    },
    log: REPORT_LOG,
  };
  const encoder = new TextEncoder();
  const entries: ZipEntry[] = [
    {
      name: REPORT_MANIFEST,
      data: encoder.encode(`${JSON.stringify(manifest, null, 2)}\n`),
    },
    {
      name: REPORT_ANALYSIS,
      data: encoder.encode(serializeAnalysis(input.analysis)),
    },
  ];
  if (input.cad)
    entries.push({ name: CAD_FILES[input.cad.format], data: input.cad.bytes });
  entries.push({
    name: REPORT_LOG,
    data: encoder.encode(formatReportLog(input.logs)),
  });
  return createZip(entries, input.created);
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

/** e.g. kofem-report-bracket-20261110-2114.zip, in local time. */
export function reportFileName(modelName: string, created: Date): string {
  const base = modelName.trim().replace(/[^\w-]+/gu, "_");
  const stamp =
    `${created.getFullYear()}${pad(created.getMonth() + 1)}${pad(created.getDate())}` +
    `-${pad(created.getHours())}${pad(created.getMinutes())}`;
  return base === ""
    ? `kofem-report-${stamp}.zip`
    : `kofem-report-${base}-${stamp}.zip`;
}

/**
 * The mailto: link that opens the user's email program with the report
 * address, a subject and a body that asks for the steps and names the file to
 * attach. Refuses to build a link without a usable address.
 */
export function reportMailtoUrl(
  fileName: string,
  appVersion: string,
  address: string = REPORT_EMAIL,
): string {
  if (!EMAIL_RE.test(address))
    throw new Error(
      `reportMailtoUrl: "${address}" is not an email address — set REPORT_EMAIL in lib/bugReport.ts`,
    );
  const subject = `KoFEM problem report (${appVersion})`;
  const body = [
    "What happened:",
    "",
    "",
    "What did you expect instead:",
    "",
    "",
    "Steps to reproduce:",
    "",
    "",
    `Please attach the report: ${fileName} (saved to your downloads).`,
  ].join("\n");
  // encodeURIComponent, not URLSearchParams: mail programs show a "+" from
  // form encoding literally instead of as a space.
  return `mailto:${address}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
}

export interface OpenedReport {
  readonly manifest: ReportManifest;
  readonly analysis: AnalysisState;
  readonly cad: ReportCad | null;
  readonly log: string;
}

const TREE_GROUPS: TreeGroup[] = [
  "geometry",
  "materials",
  "mesh",
  "boundary",
  "studies",
  "results",
];

function field<T>(
  obj: Record<string, unknown>,
  key: string,
  ok: (v: unknown) => v is T,
  what: string,
): T {
  const value = obj[key];
  if (!ok(value))
    throw new Error(`${REPORT_MANIFEST}: "${key}" is missing or not ${what}`);
  return value;
}
const isString = (v: unknown): v is string => typeof v === "string";
const isStringOrNull = (v: unknown): v is string | null =>
  v === null || typeof v === "string";
const isBoolean = (v: unknown): v is boolean => typeof v === "boolean";

function parseManifest(text: string): ReportManifest {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error(`${REPORT_MANIFEST} is not valid JSON`);
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw))
    throw new Error(`${REPORT_MANIFEST} is not a JSON object`);
  const obj = raw as Record<string, unknown>;
  if (obj.format !== REPORT_FORMAT)
    throw new Error("not a KoFEM problem report (wrong format marker)");
  if (obj.version !== REPORT_VERSION)
    throw new Error(
      `report version ${String(obj.version)} is not supported (this KoFEM reads version ${REPORT_VERSION})`,
    );
  const step = field(
    obj,
    "step",
    (v): v is TreeGroup => TREE_GROUPS.includes(v as TreeGroup),
    "a model step",
  );
  if (obj.analysis !== REPORT_ANALYSIS)
    throw new Error(
      `${REPORT_MANIFEST}: "analysis" must be ${REPORT_ANALYSIS}`,
    );
  if (obj.log !== REPORT_LOG)
    throw new Error(`${REPORT_MANIFEST}: "log" must be ${REPORT_LOG}`);
  let cad: ReportManifest["cad"];
  if (obj.cad === null) cad = null;
  else {
    const entry = obj.cad as Record<string, unknown> | undefined;
    const format = entry?.format;
    if (
      typeof entry !== "object" ||
      (format !== "step" && format !== "iges") ||
      entry.file !== CAD_FILES[format]
    )
      throw new Error(
        `${REPORT_MANIFEST}: "cad" must be null or name ${CAD_FILES.step} or ${CAD_FILES.iges} with its format`,
      );
    cad = { file: CAD_FILES[format], format };
  }
  return {
    format: REPORT_FORMAT,
    version: REPORT_VERSION,
    created: field(obj, "created", isString, "a date"),
    appVersion: field(obj, "appVersion", isString, "text"),
    engineId: field(obj, "engineId", isStringOrNull, "text or null"),
    browser: field(obj, "browser", isString, "text"),
    os: field(obj, "os", isString, "text"),
    webAssembly: field(obj, "webAssembly", isBoolean, "true or false"),
    webGl: field(obj, "webGl", isString, "text"),
    step,
    lastError: field(obj, "lastError", isStringOrNull, "text or null"),
    analysis: REPORT_ANALYSIS,
    cad,
    log: REPORT_LOG,
  };
}

/** Open a report ZIP. Throws, with the reason, on anything but a valid one. */
export async function parseReport(bytes: Uint8Array): Promise<OpenedReport> {
  let entries: ZipEntry[];
  try {
    entries = await readZip(bytes);
  } catch (err) {
    throw new Error(`not a KoFEM problem report: ${(err as Error).message}`, {
      cause: err,
    });
  }
  const byName = new Map(entries.map((e) => [e.name, e.data]));
  const manifestBytes = byName.get(REPORT_MANIFEST);
  if (!manifestBytes)
    throw new Error(`not a KoFEM problem report (no ${REPORT_MANIFEST})`);
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const manifest = parseManifest(decoder.decode(manifestBytes));

  const expected = [REPORT_MANIFEST, REPORT_ANALYSIS, REPORT_LOG];
  if (manifest.cad) expected.push(manifest.cad.file);
  for (const name of expected)
    if (!byName.has(name)) throw new Error(`the report is missing ${name}`);
  const extra = entries.map((e) => e.name).filter((n) => !expected.includes(n));
  if (extra.length > 0)
    throw new Error(
      `the report contains files KoFEM does not write: ${extra.join(", ")}`,
    );

  const analysisBytes = byName.get(REPORT_ANALYSIS);
  const logBytes = byName.get(REPORT_LOG);
  if (!analysisBytes || !logBytes)
    throw new Error("parseReport: entries vanished after the check");
  let analysis: AnalysisState;
  try {
    analysis = parseAnalysisFile(decoder.decode(analysisBytes));
  } catch (err) {
    throw new Error(
      `the report's ${REPORT_ANALYSIS} is not a valid analysis: ${(err as Error).message}`,
      { cause: err },
    );
  }
  let cad: ReportCad | null = null;
  if (manifest.cad) {
    const cadBytes = byName.get(manifest.cad.file);
    if (!cadBytes || cadBytes.length === 0)
      throw new Error(`the report's ${manifest.cad.file} is empty`);
    cad = { bytes: cadBytes, format: manifest.cad.format };
  }
  return { manifest, analysis, cad, log: decoder.decode(logBytes) };
}
