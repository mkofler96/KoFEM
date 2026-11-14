// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Which CAD reader a picked file goes to, and what a visitor reads when the
// import fails (KOF-347). The extension decides; a file without a known one is
// recognised by its header, and anything else is refused before the engine
// sees it, so "this is not a CAD file" and "this CAD file is broken" stay
// apart, both on screen and in analytics.

import type { ErrorCategory } from "./analytics";

export type CadFormat = "step" | "iges";

export const ACCEPTED_CAD_FORMATS = "STEP (.step, .stp) and IGES (.igs, .iges)";

const EXTENSIONS: Record<string, CadFormat> = {
  step: "step",
  stp: "step",
  iges: "iges",
  igs: "iges",
};

/** The reader a file name asks for, or null when it names none. */
export function cadFormatFromName(name: string): CadFormat | null {
  const dot = name.lastIndexOf(".");
  if (dot < 0) return null;
  return EXTENSIONS[name.slice(dot + 1).toLowerCase()] ?? null;
}

/** The reader a file's first line asks for, or null when it is neither. */
export function sniffCadFormat(bytes: Uint8Array): CadFormat | null {
  // The UTF-8 decoder drops a leading byte-order mark.
  const head = new TextDecoder().decode(bytes.subarray(0, 512));
  // ISO 10303-21 (STEP) opens with its magic, after optional whitespace.
  if (/^\s*ISO-10303-21/.test(head)) return "step";
  // IGES lines are 80 columns: column 73 names the section, and the file opens
  // with line 1 of the Start section.
  const first = head.split(/\r?\n/, 1)[0];
  if (
    first.length >= 80 &&
    first[72] === "S" &&
    /^ *0*1$/.test(first.slice(73, 80))
  )
    return "iges";
  return null;
}

const LABEL: Record<CadFormat, string> = { step: "STEP", iges: "IGES" };

/**
 * What the import panel shows for a failure. A file KoFEM does not import, or
 * one its reader rejects, names the formats it accepts; the engine's own text
 * (still in the worker log) would only name OCCT's reader class.
 */
export function importFailureMessage(
  category: ErrorCategory,
  format: CadFormat | null,
  detail: string,
): string {
  if (category === "unsupported_format")
    return `This file type is not supported. KoFEM imports ${ACCEPTED_CAD_FORMATS} files.`;
  if (category === "parse_error" && format !== null)
    return `Could not read this file as ${LABEL[format]}. Export it again from your CAD program; KoFEM imports ${ACCEPTED_CAD_FORMATS} files.`;
  return detail;
}
