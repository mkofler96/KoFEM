// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useState } from "react";
import { useModelStore } from "../store/modelStore";
import { sendToWorker } from "../workers/sharedWorker";
import { clearWorkerLogs } from "./useWorkerLogs";
import {
  cadFormatFromName,
  importFailureMessage,
  sniffCadFormat,
} from "../lib/cadFormat";
import {
  categorizeError,
  setWorkflow,
  type ErrorCategory,
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

  // Resolves true once the geometry is in the store. `exampleId` marks the
  // file as one KoFEM ships (the empty workspace's sample), so the funnel
  // counts it as an example rather than as the user's own CAD.
  async function importCadFile(
    file: File,
    exampleId?: string,
  ): Promise<boolean> {
    // The extension picks the reader, so the same handler serves both the STEP
    // and IGES file inputs (and a file picked through the "wrong" one). A file
    // without a known extension is recognised by its header once read.
    let format = cadFormatFromName(file.name);
    setStepImportError(null);
    setIsImporting(true);
    setRunning(true);
    const elapsed = startTimer();
    const failed = (errorCategory: ErrorCategory, message: string) => {
      setStepImportError(message);
      if (exampleId)
        track("example_load_failed", {
          example_id: exampleId,
          error_category: errorCategory,
        });
      else
        track("geometry_import_failed", {
          workflow: "cad_import",
          // eslint-disable-next-line kofem/no-silent-fallback -- analytics enum, not solver data: no format means the file was not recognised as STEP or IGES
          format: format ?? "other",
          duration_bucket: elapsed(),
          error_category: errorCategory,
        });
    };
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      format ??= sniffCadFormat(bytes);
      if (format === null) {
        failed(
          "unsupported_format",
          importFailureMessage("unsupported_format", null, ""),
        );
        return false;
      }
      const { points, triangles, bodyIds, faceIds, bodyCount } =
        await sendToWorker<{
          points: [number, number, number][];
          triangles: [number, number, number][];
          bodyIds: number[];
          faceIds: number[];
          bodyCount: number;
        }>("parse_step", { bytes, format });
      if (points.length === 0) {
        failed("empty_geometry", "No geometry found.");
        return false;
      }
      // Retain the raw bytes + format so the geometry can be reloaded for a
      // re-mesh (the worker is reset after each mesh and loses the shape).
      setStepBytes(bytes);
      setGeometryFormat(format);
      setStepSurface({ points, triangles, bodyIds, faceIds });
      // A new part is a new model: the previous one's logs no longer apply.
      clearWorkerLogs();
      // One property per body (#353), all solid until the user says otherwise.
      setBodies(bodyCount);
      if (exampleId) {
        setWorkflow("example");
        track("example_loaded", {
          example_id: exampleId,
          duration_bucket: elapsed(),
        });
      } else {
        setWorkflow("cad_import");
        track("geometry_import_success", {
          workflow: "cad_import",
          format,
          duration_bucket: elapsed(),
        });
      }
      return true;
    } catch (err) {
      const category = categorizeError(err);
      const detail =
        err instanceof Error && err.message
          ? err.message
          : `${format === "iges" ? "IGES" : "STEP"} import failed`;
      failed(category, importFailureMessage(category, format, detail));
      return false;
    } finally {
      setIsImporting(false);
      setRunning(false);
    }
  }

  return { isImporting, isRunning, stepImportError, importCadFile };
}
