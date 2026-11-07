// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Update the snapshot, line numbers and both review dates together.
export const revision = "0db1e95ae2016d2c625932babf68d8ff672d9f69";
export const source = (path, line, label) =>
  `<a href="https://github.com/mkofler96/KoFEM/blob/${revision}/${path}#L${line}">${label}</a>`;
