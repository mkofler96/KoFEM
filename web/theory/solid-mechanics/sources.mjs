// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Pinned source links for the solid-mechanics articles. Update the revision,
// and line numbers together when the implementation changes.
export const revision = "6ba4db0ed963d6c8c0cb3263edf6737763994b6c";
export const mfemVersion = "v4.7";

export const source = (path, line, label) =>
  `<a href="https://github.com/mkofler96/KoFEM/blob/${revision}/${path}#L${line}">${label}</a>`;

export const mfemSource = (path, line, label) =>
  `<a href="https://github.com/mfem/mfem/blob/${mfemVersion}/${path}#L${line}">${label}</a>`;
