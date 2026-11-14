// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Pinned source links for the Theory Guide. Update the revision and line
// numbers together when the implementation changes.
//
// The finite-element solve runs in the Rust module (crates/kofem-fem,
// crates/kofem-wasm) and the TypeScript that drives it (web/src/lib/solve).
// `codeSource` links that code at the reviewed revision.
export const codeRevision = "ae27e683fa8cb55c16103fdd398fc27a452daa76";
export const codeSource = (path, line, label) =>
  `<a href="https://github.com/mkofler96/KoFEM/blob/${codeRevision}/${path}#L${line}">${label}</a>`;

// App code (stores, panels, loads) reviewed for the earlier chapters. Keep
// their snapshot while those lines are unchanged.
export const revision = "41aa05f99bc99210995b21d1aded942d45ef4729";
export const source = (path, line, label) =>
  `<a href="https://github.com/mkofler96/KoFEM/blob/${revision}/${path}#L${line}">${label}</a>`;

// Parts of the Rust module are ported from MFEM; these link the MFEM code
// they follow.
export const mfemVersion = "v4.7";
export const mfemSource = (path, line, label) =>
  `<a href="https://github.com/mfem/mfem/blob/${mfemVersion}/${path}#L${line}">${label}</a>`;
