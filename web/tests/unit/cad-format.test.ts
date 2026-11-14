// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Which CAD reader a picked file goes to (KOF-347). The extension decides; a
// file without a known one is recognised by its header, and anything else is
// refused before the engine sees it, with a message naming what KoFEM accepts.

import { describe, expect, test } from "bun:test";
import {
  ACCEPTED_CAD_FORMATS,
  cadFormatFromName,
  importFailureMessage,
  sniffCadFormat,
} from "../../src/lib/cadFormat.ts";

const text = (s: string) => new TextEncoder().encode(s);

describe("cadFormatFromName", () => {
  test.each([
    ["bracket.step", "step"],
    ["bracket.stp", "step"],
    ["BRACKET.STEP", "step"],
    ["hull.igs", "iges"],
    ["hull.IGES", "iges"],
    ["part.v2.stp", "step"],
  ])("%s is %s", (name, format) => {
    expect(cadFormatFromName(name)).toBe(format);
  });

  test.each(["bracket.stl", "bracket.x_t", "bracket.step.zip", "bracket", ""])(
    "%p has no CAD extension",
    (name) => {
      expect(cadFormatFromName(name)).toBeNull();
    },
  );
});

describe("sniffCadFormat", () => {
  test("a STEP header is STEP", () => {
    expect(sniffCadFormat(text("ISO-10303-21;\nHEADER;\n"))).toBe("step");
  });

  test("leading whitespace and a byte-order mark do not hide a STEP header", () => {
    expect(sniffCadFormat(text("\uFEFF  \r\nISO-10303-21;\n"))).toBe("step");
  });

  test("an IGES start line is IGES", () => {
    const start = `${"KoFEM test part".padEnd(72)}S      1`;
    expect(sniffCadFormat(text(`${start}\r\n`))).toBe("iges");
  });

  test.each([
    ["an STL file", "solid bracket\n  facet normal 0 0 1\n"],
    ["a short line with S", "S      1"],
    ["empty bytes", ""],
  ])("%s is not CAD", (_label, content) => {
    expect(sniffCadFormat(text(content))).toBeNull();
  });
});

describe("importFailureMessage", () => {
  test("the accepted formats name every extension the import cards take", () => {
    for (const ext of [".step", ".stp", ".igs", ".iges"])
      expect(ACCEPTED_CAD_FORMATS).toContain(ext);
  });

  test("an unsupported file names the formats KoFEM imports", () => {
    expect(importFailureMessage("unsupported_format", null, "ignored")).toBe(
      `This file type is not supported. KoFEM imports ${ACCEPTED_CAD_FORMATS} files.`,
    );
  });

  test("a file the reader rejects says which reader and how to fix it", () => {
    const message = importFailureMessage(
      "parse_error",
      "iges",
      "std::runtime_error: IGESControl_Reader::ReadFile failed — invalid IGES file",
    );
    expect(message).toContain("as IGES");
    expect(message).toContain(ACCEPTED_CAD_FORMATS);
    expect(message).not.toContain("IGESControl_Reader");
  });

  test("other failures keep the engine's own text", () => {
    expect(
      importFailureMessage(
        "tessellation_failure",
        "step",
        "std::runtime_error: BRepMesh_IncrementalMesh failed",
      ),
    ).toBe("std::runtime_error: BRepMesh_IncrementalMesh failed");
  });
});
