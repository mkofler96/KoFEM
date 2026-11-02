// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Pinned source links for the numerical-methods articles. Update the revision,
// line numbers and the review date in each article together after re-review.
export const revision = "41aa05f99bc99210995b21d1aded942d45ef4729";
export const mfemVersion = "v4.7";

export const source = (path, line, label) =>
  `<a href="https://github.com/mkofler96/KoFEM/blob/${revision}/${path}#L${line}">${label}</a>`;

export const mfemSource = (path, line, label) =>
  `<a href="https://github.com/mfem/mfem/blob/${mfemVersion}/${path}#L${line}">${label}</a>`;
