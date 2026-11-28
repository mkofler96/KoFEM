// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// What a support or load group card says it applies (KOF-494), so a wrong unit
// or a face picked twice shows before the solve: the area of the group's CAD
// faces, and what a load's value comes to over it. The numbers come from the Rust
// module (crates/kofem-fem/src/boundary_summary.rs) on the engine's CAD face
// areas, the status bar's figures (KOF-493); the Rust module must be loaded
// first (loadFemModule). Display only: the solve builds its loads elsewhere
// (store/boundaryRebuild).

import {
  forceSummary,
  momentSummary,
  pressureSummary,
  selectedArea,
} from "../wasm/fem/kofem_wasm.js";
import {
  loadComponents,
  loadKind,
  type BcFaceEntry,
  type NamedLoadGroup,
} from "../store/boundaryGroups";
import { isNodalFace } from "../store/boundaryRebuild";
import type { CouplingGroup } from "../store/couplingSlice";
import { referencePointIds } from "./coupling";
import { formatMeasure, type CadFaceProperties } from "./cadFaceProperties";
import { MODEL_UNITS } from "./modelUnits";
import type { boundaryMessages } from "../i18n/messages/boundary";

type Text = (typeof boundaryMessages)["en"];

// Which CAD faces a group's selections are. A point, or an edge or region
// picked node by node, has no CAD face area, and the group's area is then not
// the sum of its faces'.
export type CadFaceSelection =
  | { state: "empty" }
  | { state: "unmeasured" }
  | { state: "faces"; ids: number[] };

export function cadFaceSelection(
  faces: readonly BcFaceEntry[],
): CadFaceSelection {
  if (faces.length === 0) return { state: "empty" };
  const ids: number[] = [];
  for (const face of faces) {
    if (face.geometry === "point" || face.cadFaceId === undefined)
      return { state: "unmeasured" };
    ids.push(face.cadFaceId);
  }
  return { state: "faces", ids };
}

/** The area a group covers: the sum of its distinct CAD faces' areas (mm²),
 *  with the faces selected more than once. "noGeometry": its faces are whole
 *  CAD faces, but the model has no CAD geometry to measure them on (an
 *  analysis file opened without its STEP file). */
export type GroupArea =
  | { state: "empty" }
  | { state: "unmeasured" }
  | { state: "noGeometry" }
  | { state: "measured"; area: number; repeated: number[] };

export function groupArea(
  faces: readonly BcFaceEntry[],
  cadFaces: readonly CadFaceProperties[] | null,
): GroupArea {
  const selection = cadFaceSelection(faces);
  if (selection.state !== "faces") return selection;
  if (cadFaces === null) return { state: "noGeometry" };
  const measured = selectedArea(
    Float64Array.from(cadFaces, (face) => face.area),
    Uint32Array.from(selection.ids),
  );
  try {
    return {
      state: "measured",
      area: measured.area,
      repeated: Array.from(measured.repeated),
    };
  } finally {
    measured.free();
  }
}

/** What a load group's value comes to over its area (Rust's force, moment
 *  and pressure summaries). `value` is null for a load of zero, and for a
 *  group without faces, which has nothing to apply it to. `axes` counts the
 *  non-zero components, as the card shows |F| or |M| only for more than one. */
export type LoadFigures = { area: GroupArea } & (
  | {
      kind: "force";
      axes: number;
      value: { total: number; meanTraction: number | null } | null;
    }
  | {
      kind: "moment";
      axes: number;
      value: { each: number; applied: number; total: number } | null;
    }
  | {
      kind: "pressure";
      value: { pressure: number; total: number | null } | null;
    }
);

// How many times the solve applies a moment group's vector: in full on each
// face selection (momentToNodalForces), and shared by its nodal selections
// (rebuildLoads), told apart by the solve's own test.
function momentApplications(
  group: NamedLoadGroup,
  couplingGroups: readonly CouplingGroup[],
): number {
  const refPoints = referencePointIds([...couplingGroups]);
  const nodal = group.faces.filter((face) => isNodalFace(face, refPoints));
  return group.faces.length - nodal.length + (nodal.length > 0 ? 1 : 0);
}

// Copy a Rust summary's fields out and free it.
function read<T extends { free(): void }, R>(
  summary: T | undefined,
  fields: (summary: T) => R,
): R | null {
  if (summary === undefined) return null;
  try {
    return fields(summary);
  } finally {
    summary.free();
  }
}

export function loadFigures(
  group: NamedLoadGroup,
  cadFaces: readonly CadFaceProperties[] | null,
  couplingGroups: readonly CouplingGroup[],
): LoadFigures {
  const kind = loadKind(group);
  const area = groupArea(group.faces, cadFaces);
  const known = area.state === "measured" ? area.area : undefined;
  const vector = Float64Array.from(loadComponents(group));
  const axes = vector.filter((component) => component !== 0).length;
  const faces = area.state !== "empty";
  if (kind === "pressure")
    return {
      kind,
      area,
      value: faces
        ? read(pressureSummary(group.totalForce, known), (summary) => ({
            pressure: summary.pressure,
            total: summary.total ?? null,
          }))
        : null,
    };
  if (kind === "moment")
    return {
      kind,
      area,
      axes,
      value: faces
        ? read(
            momentSummary(
              vector,
              momentApplications(group, couplingGroups),
              known,
            ),
            (summary) => ({
              each: summary.each,
              applied: summary.applied,
              total: summary.total,
            }),
          )
        : null,
    };
  return {
    kind,
    area,
    axes,
    value: faces
      ? read(forceSummary(vector, known), (summary) => ({
          total: summary.total,
          meanTraction: summary.meanTraction ?? null,
        }))
      : null,
  };
}

/** The card's summary line; a hint saying why an area is not measured; and a
 *  warning when a face is selected twice. */
export interface SummaryText {
  summary: string;
  hint: string | undefined;
  warning: string | null;
}

const UNIT = {
  force: MODEL_UNITS.force,
  moment: `${MODEL_UNITS.force}·${MODEL_UNITS.length}`,
  stress: MODEL_UNITS.stress,
  area: `${MODEL_UNITS.length}²`,
};

// An area that is not measured shows as a dash, with the reason in the hint.
const NOT_MEASURED = "—";

function quantity(value: number, unit: string, intl: string): string {
  return `${formatMeasure(value, intl)} ${unit}`;
}

// The face rows that are one CAD face, by their labels.
function repeatedWarning(
  area: GroupArea,
  faces: readonly BcFaceEntry[],
  intl: string,
  sameFace: (labels: string) => string,
): string | null {
  if (area.state !== "measured" || area.repeated.length === 0) return null;
  return area.repeated
    .map((id) =>
      sameFace(
        new Intl.ListFormat(intl, { type: "conjunction" }).format(
          faces
            .filter((face) => face.cadFaceId === id)
            .map((face) => face.label),
        ),
      ),
    )
    .join("; ");
}

function areaHint(area: GroupArea, text: Text): string | undefined {
  if (area.state === "unmeasured") return text.summaryNotMeasured;
  if (area.state === "noGeometry") return text.summaryNoGeometry;
  return undefined;
}

function areaText(area: GroupArea, intl: string): string {
  return area.state === "measured"
    ? quantity(area.area, UNIT.area, intl)
    : NOT_MEASURED;
}

export function loadSummaryText(
  figures: LoadFigures,
  faces: readonly BcFaceEntry[],
  text: Text,
  intl: string,
): SummaryText {
  const { area } = figures;
  if (area.state === "empty")
    return { summary: text.summaryNoFaces, hint: undefined, warning: null };
  const hint = areaHint(area, text);
  // A moment is applied in full to each selection, a repeated face included.
  const warning = repeatedWarning(
    area,
    faces,
    intl,
    figures.kind === "moment"
      ? text.summarySameFaceMoment
      : text.summarySameFace,
  );
  const areaPart = areaText(area, intl);
  if (figures.value === null)
    return { summary: `${text.summaryNoValue} · ${areaPart}`, hint, warning };
  const parts: string[] = [];
  if (figures.kind === "pressure") {
    const { total } = figures.value;
    parts.push(
      total === null
        ? areaPart
        : `${areaPart} → ${quantity(total, UNIT.force, intl)}`,
    );
  } else if (figures.kind === "moment") {
    const { each, applied, total } = figures.value;
    if (figures.axes > 1)
      parts.push(`|M| = ${quantity(each, UNIT.moment, intl)}`);
    if (applied > 1)
      parts.push(
        text.summaryAppliedEach(applied, quantity(total, UNIT.moment, intl)),
      );
    parts.push(areaPart);
  } else {
    const { total, meanTraction } = figures.value;
    if (figures.axes > 1)
      parts.push(`|F| = ${quantity(total, UNIT.force, intl)}`);
    parts.push(
      meanTraction === null
        ? areaPart
        : `${areaPart} → ${quantity(meanTraction, UNIT.stress, intl)}`,
    );
  }
  return { summary: parts.join(" · "), hint, warning };
}

export function supportSummaryText(
  area: GroupArea,
  faces: readonly BcFaceEntry[],
  text: Text,
  intl: string,
): SummaryText {
  return {
    summary:
      area.state === "empty" ? text.summaryNoFaces : areaText(area, intl),
    hint: areaHint(area, text),
    warning: repeatedWarning(area, faces, intl, text.summarySameFace),
  };
}
