// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

import { sendToWorker } from "../workers/sharedWorker";
import type { GeometryFormat } from "../store/geometrySlice";
import type { CadFaceProperties } from "./cadFaceProperties";

// The engine's description of the CAD faces of a geometry file the store takes
// without importing it (an example's file, a problem report's). An import or
// an edit describes its own faces.
export async function describeCadFaces(
  bytes: Uint8Array,
  format: GeometryFormat,
): Promise<CadFaceProperties[]> {
  const { cadFaces } = await sendToWorker<{ cadFaces: CadFaceProperties[] }>(
    "cad_face_properties",
    { bytes, format },
  );
  return cadFaces;
}
