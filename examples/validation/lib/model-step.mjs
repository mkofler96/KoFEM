// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// The geometry an opened example re-meshes from (KOF-322).
//
// An example ships two STEP files in examples/gallery/site/:
//
//   <id>.step        the file the user imports — what the page links;
//   <id>.model.step  the geometry the .vtu's CAD face ids refer to: the
//                    imported file after the recipe's splits, as the engine
//                    wrote it. The app restores this one when it opens the
//                    example (web/src/lib/examples.ts), so a re-mesh carries
//                    every support and load onto the same CAD faces.
//
// Every example ships both, also without splits (then they are the same
// bytes): one rule, and the app never has to guess which file the .vtu's face
// ids belong to.
//
// After a split the engine writes the STEP itself, and OCCT stamps the time
// of writing into the header (FILE_NAME's time_stamp). That stamp is not
// geometry, so two files that differ only there are the same model: the check
// ignores it, and a rewrite keeps the committed file, so a regeneration does
// not churn the file.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** site/<id>.model.step */
export const modelStepPath = (siteDir, id) => join(siteDir, `${id}.model.step`);

// The STEP text with FILE_NAME's time_stamp (its second argument) blanked.
function withoutTimestamp(text, where) {
  const header = /^ISO-10303-21;\s*HEADER;([\s\S]*?)ENDSEC;/.exec(text);
  if (!header) throw new Error(`${where}: not a STEP file with a HEADER`);
  const stamp = /FILE_NAME\(\s*'(?:[^']|'')*'\s*,\s*'[^']*'/;
  if (!stamp.test(header[1]))
    throw new Error(`${where}: the STEP header has no FILE_NAME time stamp`);
  return text.replace(stamp, (m) => m.replace(/'[^']*'$/, "''"));
}

const decode = (bytes) => new TextDecoder().decode(bytes);

/**
 * Whether the file at `path` is the model `bytes` (the build's stepBytes),
 * apart from the time it was written.
 */
export function sameModelStep(path, bytes) {
  if (!existsSync(path)) return false;
  return (
    withoutTimestamp(readFileSync(path, "utf8"), path) ===
    withoutTimestamp(decode(bytes), `the model of ${path}`)
  );
}

/** Write the model `bytes` to `path`, unless only the time stamp differs. */
export function writeModelStep(path, bytes) {
  if (sameModelStep(path, bytes)) return;
  writeFileSync(path, bytes);
}
