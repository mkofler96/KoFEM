// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Pinned source links for the numerical-methods articles. Update the revision,
// and line numbers together when the implementation changes.
export const revision = "41aa05f99bc99210995b21d1aded942d45ef4729";
export const mfemVersion = "v4.7";
// Continuation merged after the earlier chapters' review. Keep their snapshots.
export const linearSolveRevision = "8b542d8836f39ec4e9c7ae67c5896d39ce970078";
export const linearSolveSource = (path, line, label) =>
  `<a href="https://github.com/mkofler96/KoFEM/blob/${linearSolveRevision}/${path}#L${line}">${label}</a>`;

export const source = (path, line, label) =>
  `<a href="https://github.com/mkofler96/KoFEM/blob/${revision}/${path}#L${line}">${label}</a>`;

// The Rust finite-element module, linked by file on develop: the revision
// above predates it. Pin these to a revision once that change has merged.
export const rustSource = (path, label) =>
  `<a href="https://github.com/mkofler96/KoFEM/blob/develop/${path}">${label}</a>`;

export const mfemSource = (path, line, label) =>
  `<a href="https://github.com/mfem/mfem/blob/${mfemVersion}/${path}#L${line}">${label}</a>`;
