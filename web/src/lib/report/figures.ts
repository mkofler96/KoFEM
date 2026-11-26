// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// The analysis report's figures (KOF-391), drawn by the viewport's canvas
// (ReportCapture registers the capture while the canvas is mounted), as PNG
// data URLs so the report file holds them itself.

import { tr } from "../../i18n/useLocale";
import { reportMessages } from "../../i18n/messages/report";

// One figure, cropped to what the canvas drew; its size in pixels lets the
// report lay it out before the image decodes.
export interface FigureImage {
  src: string;
  width: number;
  height: number;
}

export interface ReportFigures {
  // The view as the user left it, once it has settled.
  current: FigureImage;
  // The whole model from the isometric direction (1, 1, 1).
  isometric: FigureImage;
}

export interface CapturedViews {
  current: FigureImage;
  // Null when the caller asked for the current view alone.
  isometric: FigureImage | null;
}

type Capture = (isometric: boolean) => Promise<CapturedViews>;

let capture: Capture | null = null;

/** Register the canvas's capture; returns the call that removes it. */
export function registerFigureCapture(next: Capture): () => void {
  capture = next;
  return () => {
    if (capture === next) capture = null;
  };
}

/** The settled view, and with `isometric` the isometric view as well. */
export function captureViews(isometric: boolean): Promise<CapturedViews> {
  if (capture === null) throw new Error(tr(reportMessages).noViewport);
  return capture(isometric);
}
