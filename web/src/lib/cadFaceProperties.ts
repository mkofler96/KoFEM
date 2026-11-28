// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Per-face CAD properties from the engine (cad_face_properties, KOF-493): what
// each CAD face is, measured on the exact CAD surface. Indexed by CAD face id − 1,
// the ids the tessellation, the mesh's surfaceFaceIds and face picks carry.

import type { CadFacePropertyArrays } from "../wasm/pkg/kofem_wasm";

export type Vec3 = [number, number, number];

/** One CAD face: its surface type and area (mm²), a plane's outward normal,
 *  a cylinder's or cone's axis direction (unit, either sign) and a cylinder's
 *  radius (mm). */
export type CadFaceProperties =
  | { kind: "plane"; area: number; normal: Vec3 }
  | { kind: "cylinder"; area: number; axis: Vec3; radius: number }
  | { kind: "cone"; area: number; axis: Vec3 }
  | { kind: "other"; area: number };

// The engine's surface type codes (engine/cpp/face_properties.h).
const SURFACE_KINDS = ["plane", "cylinder", "cone", "other"] as const;

/** The engine's flat arrays as one entry per CAD face. */
export function decodeCadFaceProperties(
  raw: CadFacePropertyArrays,
): CadFaceProperties[] {
  const n = raw.surfaceTypes.length;
  if (
    raw.areas.length !== n ||
    raw.radii.length !== n ||
    raw.directions.length !== 3 * n
  )
    throw new Error(
      `cad_face_properties: array lengths disagree (${n} types, ${raw.areas.length} areas, ${raw.radii.length} radii, ${raw.directions.length / 3} directions)`,
    );
  const faces: CadFaceProperties[] = [];
  for (let i = 0; i < n; i++) {
    const kind = SURFACE_KINDS[raw.surfaceTypes[i]];
    if (kind === undefined)
      throw new Error(
        `cad_face_properties: face ${i + 1} has unknown surface type ${raw.surfaceTypes[i]}`,
      );
    const area = raw.areas[i];
    const direction: Vec3 = [
      raw.directions[3 * i],
      raw.directions[3 * i + 1],
      raw.directions[3 * i + 2],
    ];
    if (kind === "plane") faces.push({ kind, area, normal: direction });
    else if (kind === "cylinder")
      faces.push({ kind, area, axis: direction, radius: raw.radii[i] });
    else if (kind === "cone") faces.push({ kind, area, axis: direction });
    else faces.push({ kind, area });
  }
  return faces;
}

// The messages cadFaceLabel builds its text from (i18n/messages/shell.ts).
export interface CadFaceText {
  faceLabel(id: number): string;
  facePlane: string;
  faceCylinder(diameter: string): string;
  faceCone: string;
  faceOther: string;
  faceNormal(direction: string): string;
  faceAxis(direction: string): string;
  faceVector(x: string, y: string, z: string): string;
}

// A measure to three significant figures, but never rounding away whole units:
// 37, 3.2, 0.0123, 149, 12,345.
function measure(value: number, intl: string): string {
  return new Intl.NumberFormat(
    intl,
    Math.abs(value) >= 100
      ? { maximumFractionDigits: 0 }
      : { maximumSignificantDigits: 3 },
  ).format(value);
}

// Closer to a coordinate axis than this, a unit direction is named by it.
const AXIS_ALIGNED = 1 - 1e-9;
const AXES = ["X", "Y", "Z"] as const;

// A unit direction as its axis (+Z, −X) or, off the axes, its components. An
// axis has no sign, so it is shown as its axis letter alone, or with its first
// non-zero component positive.
function direction(
  d: Vec3,
  signed: boolean,
  text: CadFaceText,
  intl: string,
): string {
  const along = d.findIndex((c) => Math.abs(c) > AXIS_ALIGNED);
  if (along >= 0)
    return signed ? `${d[along] > 0 ? "+" : "−"}${AXES[along]}` : AXES[along];
  const first = d.find((c) => Math.abs(c) > 0.005);
  const flip = !signed && first !== undefined && first < 0 ? -1 : 1;
  const format = new Intl.NumberFormat(intl, {
    maximumFractionDigits: 2,
    signDisplay: "negative",
  });
  const component = (c: number) => format.format(flip * c);
  return text.faceVector(component(d[0]), component(d[1]), component(d[2]));
}

/** The status bar's description of CAD face `id`: its type (a cylinder with
 *  its diameter), area in `lengthUnit`², and a plane's normal or a cylinder's
 *  or cone's axis, e.g. "Face 39 · cylinder Ø3.2 · 37 mm² · axis Z". */
export function cadFaceLabel(
  id: number,
  face: CadFaceProperties,
  text: CadFaceText,
  intl: string,
  lengthUnit: string,
): string {
  const area = `${measure(face.area, intl)} ${lengthUnit}²`;
  const parts = [text.faceLabel(id)];
  if (face.kind === "plane")
    parts.push(
      text.facePlane,
      area,
      text.faceNormal(direction(face.normal, true, text, intl)),
    );
  else if (face.kind === "cylinder")
    parts.push(
      text.faceCylinder(measure(2 * face.radius, intl)),
      area,
      text.faceAxis(direction(face.axis, false, text, intl)),
    );
  else if (face.kind === "cone")
    parts.push(
      text.faceCone,
      area,
      text.faceAxis(direction(face.axis, false, text, intl)),
    );
  else parts.push(text.faceOther, area);
  return parts.join(" · ");
}
