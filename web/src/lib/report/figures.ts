// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// The analysis report's figures (KOF-391), drawn by the viewport's canvas
// (ReportCapture registers the capture while the canvas is mounted), as PNG
// data URLs so the report file holds them itself.

import { tr } from "../../i18n/useLocale";
import { reportMessages } from "../../i18n/messages/report";

export interface ReportFigures {
  // The view as the user left it, once it has settled.
  current: string;
  // The whole model from the isometric direction (1, 1, 1).
  isometric: string;
}

type Capture = () => Promise<ReportFigures>;

let capture: Capture | null = null;

/** Register the canvas's capture; returns the call that removes it. */
export function registerFigureCapture(next: Capture): () => void {
  capture = next;
  return () => {
    if (capture === next) capture = null;
  };
}

export function captureFigures(): Promise<ReportFigures> {
  if (capture === null) throw new Error(tr(reportMessages).noViewport);
  return capture();
}
