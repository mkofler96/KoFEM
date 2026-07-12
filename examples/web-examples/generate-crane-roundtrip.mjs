// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Generates the "Crane hook — full roundtrip" gallery card. It is a normal
// pre-solved showcase card like every other example: "Open in KoFEM web" opens
// the coupled crane analysis (crane-hook-shell) — the full assembly with the thin
// holder as shells, the pin and hook solid, 2 kN total on the pin and the top face
// fully fixed. The card is the roundtrip framing of that solved model, so it
// reuses its openable analysis and preview surface rather than duplicating the
// solved .vtu.
//
//   bun examples/web-examples/generate-crane-roundtrip.mjs
//
// Run after generate-crane-shell.mjs (it reads that card's viewer from the
// manifest). Appends/replaces the "crane-hook-roundtrip" entry in examples.json.

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const manifestPath = join(here, "../../web/public/examples/examples.json");
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));

const source = manifest.find((e) => e.id === "crane-hook-shell");
if (!source)
  throw new Error(
    "crane-hook-shell entry not found — run generate-crane-shell.mjs first",
  );

const entry = {
  id: "crane-hook-roundtrip",
  title: "Crane hook — full roundtrip",
  blurb:
    "The full crane assembly, meshed and solved end to end: the thin holder is " +
    "idealised as shells and the pin and hook stay solid (the per-body element " +
    "type, auto-preselected from the geometry), 2 kN total is applied on the pin " +
    "and the top face is fully fixed. The coupled shell+solid solve carries it " +
    "where the all-solid thin part stalls (#358).",
  showcase: true,
  // Opens the coupled crane analysis (the roundtrip result), like every other
  // showcase card's "Open in KoFEM web".
  appId: "crane-hook-shell",
  metrics: [
    { k: "load", v: "2 kN total on pin" },
    { k: "coupled solve", v: "holder shell · pin/hook solid", pass: true },
  ],
  referenceLabel: "import → mesh → 2 kN on pin, top fixed → coupled solve",
  colorLabel: source.colorLabel ?? "Displacement magnitude",
  viewer: source.viewer,
};

const next = manifest.filter((e) => e.id !== entry.id);
next.push(entry);
writeFileSync(manifestPath, JSON.stringify(next));
console.log(`crane-hook-roundtrip: opens ${entry.appId} → ${manifestPath}`);
