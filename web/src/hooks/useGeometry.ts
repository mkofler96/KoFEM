// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useState } from "react";
import { useModelStore } from "../store/modelStore";
import { sendToWorker } from "../workers/sharedWorker";
import {
  categorizeError,
  setWorkflow,
  startTimer,
  track,
} from "../lib/analytics";

// CAD import: tessellates a STEP/IGES file in the worker and stores the
// resulting surface in the model store. Owns the import-in-flight flag and
// the worker's parse_step protocol.
export function useGeometry() {
  const setStepSurface = useModelStore((s) => s.setStepSurface);
  const stepImportError = useModelStore((s) => s.stepImportError);
  const setStepImportError = useModelStore((s) => s.setStepImportError);
  const isRunning = useModelStore((s) => s.isRunning);
  const setRunning = useModelStore((s) => s.setRunning);
  const setStepBytes = useModelStore((s) => s.setStepBytes);
  const setGeometryFormat = useModelStore((s) => s.setGeometryFormat);
  const setBodies = useModelStore((s) => s.setBodies);

  const [isImporting, setIsImporting] = useState(false);

  async function importCadFile(file: File) {
    // Derive the reader from the extension so the same handler serves both the
    // STEP and IGES file inputs (and a file picked through the "wrong" one).
    const ext = file.name.split(".").pop()?.toLowerCase();
    const format = ext === "igs" || ext === "iges" ? "iges" : "step";
    const label = format === "iges" ? "IGES" : "STEP";
    setStepImportError(null);
    setIsImporting(true);
    setRunning(true);
    const elapsed = startTimer();
    const bytes = new Uint8Array(await file.arrayBuffer());
    sendToWorker<{
      points: [number, number, number][];
      triangles: [number, number, number][];
      bodyIds: number[];
      faceIds: number[];
      bodyCount: number;
    }>("parse_step", { bytes, format })
      .then(({ points, triangles, bodyIds, faceIds, bodyCount }) => {
        if (points.length === 0) {
          setStepImportError("No geometry found.");
          track("geometry_import_failed", {
            format,
            duration_bucket: elapsed(),
            error_category: "invalid_input",
          });
        } else {
          // Retain the raw bytes + format so the geometry can be reloaded for a
          // re-mesh (the worker is reset after each mesh and loses the shape).
          setStepBytes(bytes);
          setGeometryFormat(format);
          setStepSurface({ points, triangles, bodyIds, faceIds });
          // One property per body (#353), all solid until the user says otherwise.
          setBodies(bodyCount);
          setWorkflow("cad_import");
          track("geometry_import_success", {
            format,
            duration_bucket: elapsed(),
          });
        }
      })
      .catch((err) => {
        // eslint-disable-next-line kofem/no-silent-fallback -- fallback text for a rejection that arrived without a message; this is the error path itself, not solver data
        setStepImportError(err.message ?? `${label} import failed`);
        track("geometry_import_failed", {
          format,
          duration_bucket: elapsed(),
          error_category: categorizeError(err),
        });
      })
      .finally(() => {
        setIsImporting(false);
        setRunning(false);
      });
  }

  return { isImporting, isRunning, stepImportError, importCadFile };
}
