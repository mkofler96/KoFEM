// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// What a support or load group card says it applies (KOF-494), so a wrong unit
// or a face picked twice shows before the solve: the area of the group's CAD
// faces, and a load's total and mean traction. The numbers come from the Rust
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
  type LoadKind,
  type NamedLoadGroup,
} from "../store/boundaryGroups";
import { formatMeasure, type CadFaceProperties } from "./cadFaceProperties";
import { MODEL_UNITS } from "./modelUnits";
import type { boundaryMessages } from "../i18n/messages/boundary";

type Text = (typeof boundaryMessages)["en"];

// Which CAD faces a group's selections are. A point, an edge or region picked
// node by node, or a face of a mesh without geometry, has no CAD face area,
// and the group's area is then not the sum of its faces'.
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
 *  with the faces selected more than once. */
export type GroupArea =
  | { state: "empty" }
  | { state: "unmeasured" }
  | { state: "measured"; area: number; repeated: number[] };

export function groupArea(
  faces: readonly BcFaceEntry[],
  cadFaces: readonly CadFaceProperties[] | null,
): GroupArea {
  const selection = cadFaceSelection(faces);
  if (selection.state !== "faces") return selection;
  if (cadFaces === null) return { state: "unmeasured" };
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

/** A load's figures: a force's magnitude and mean traction |F| / A (null on
 *  an area not measured), a moment's magnitude, or a pressure and the total
 *  force p · A it pushes with (null on an area not measured). `value` is null
 *  for a load of zero size, which has nothing to show. */
export type LoadFigures = { area: GroupArea } & (
  | { kind: LoadKind; value: null }
  | { kind: "force"; value: { total: number; meanTraction: number | null } }
  | { kind: "moment"; value: { total: number } }
  | { kind: "pressure"; value: { pressure: number; total: number | null } }
);

function required(value: number | undefined, what: string): number {
  if (value === undefined)
    throw new Error(`The Rust load summary returned no ${what}`);
  return value;
}

export function loadFigures(
  group: NamedLoadGroup,
  cadFaces: readonly CadFaceProperties[] | null,
): LoadFigures {
  const kind = loadKind(group);
  const area = groupArea(group.faces, cadFaces);
  const known = area.state === "measured" ? area.area : undefined;
  const vector = Float64Array.from(loadComponents(group));
  if (kind === "pressure") {
    if (group.totalForce === 0) return { kind, area, value: null };
    const summary = pressureSummary(group.totalForce, known);
    try {
      return {
        kind,
        area,
        value: { pressure: group.totalForce, total: summary.total ?? null },
      };
    } finally {
      summary.free();
    }
  }
  if (vector.every((component) => component === 0))
    return { kind, area, value: null };
  const summary =
    kind === "moment"
      ? momentSummary(vector, known)
      : forceSummary(vector, known);
  try {
    const total = required(summary.total, "total");
    return kind === "moment"
      ? { kind, area, value: { total } }
      : {
          kind,
          area,
          value: { total, meanTraction: summary.meanTraction ?? null },
        };
  } finally {
    summary.free();
  }
}

/** The card's summary line, and a warning when a face is selected twice. */
export interface SummaryText {
  summary: string;
  warning: string | null;
}

const UNIT = {
  force: MODEL_UNITS.force,
  moment: `${MODEL_UNITS.force}·${MODEL_UNITS.length}`,
  stress: MODEL_UNITS.stress,
  area: `${MODEL_UNITS.length}²`,
};

function quantity(value: number, unit: string, intl: string): string {
  return `${formatMeasure(value, intl)} ${unit}`;
}

// The face rows that are one CAD face, by their labels.
function repeatedWarning(
  area: GroupArea,
  faces: readonly BcFaceEntry[],
  text: Text,
  intl: string,
): string | null {
  if (area.state !== "measured" || area.repeated.length === 0) return null;
  return area.repeated
    .map((id) =>
      text.summarySameFace(
        new Intl.ListFormat(intl, { type: "conjunction" }).format(
          faces
            .filter((face) => face.cadFaceId === id)
            .map((face) => face.label),
        ),
      ),
    )
    .join("; ");
}

function areaText(area: GroupArea, text: Text, intl: string): string {
  if (area.state === "empty") return text.summaryNoFaces;
  if (area.state === "unmeasured") return text.summaryNotMeasured;
  return quantity(area.area, UNIT.area, intl);
}

export function loadSummaryText(
  figures: LoadFigures,
  faces: readonly BcFaceEntry[],
  text: Text,
  intl: string,
): SummaryText {
  const { area } = figures;
  if (area.state === "empty")
    return { summary: text.summaryNoFaces, warning: null };
  const warning = repeatedWarning(area, faces, text, intl);
  const areaPart = areaText(area, text, intl);
  if (figures.value === null)
    return { summary: `${text.summaryNoValue} · ${areaPart}`, warning };
  if (figures.kind === "pressure") {
    const { pressure, total } = figures.value;
    const pressed = quantity(pressure, UNIT.stress, intl);
    return {
      summary:
        total === null
          ? `${pressed} · ${areaPart}`
          : `${pressed} × ${areaPart} → ${quantity(total, UNIT.force, intl)}`,
      warning,
    };
  }
  const total =
    figures.kind === "moment"
      ? quantity(figures.value.total, UNIT.moment, intl)
      : quantity(figures.value.total, UNIT.force, intl);
  if (area.state === "unmeasured")
    return { summary: `${total} · ${areaPart}`, warning };
  const over = text.summaryOver(total, areaPart);
  const traction = figures.kind === "force" ? figures.value.meanTraction : null;
  return {
    summary:
      traction === null
        ? over
        : `${over} → ${quantity(traction, UNIT.stress, intl)}`,
    warning,
  };
}

const DOF_NAMES = ["Ux", "Uy", "Uz", "Rx", "Ry", "Rz"];

export function supportSummaryText(
  area: GroupArea,
  dofs: readonly number[],
  value: number,
  faces: readonly BcFaceEntry[],
  text: Text,
  intl: string,
): SummaryText {
  const names = dofs.map((dof) => DOF_NAMES[dof]).join(", ");
  const held =
    value === 0
      ? text.summaryHolds(names)
      : text.summarySets(names, formatMeasure(value, intl));
  return {
    summary: `${areaText(area, text, intl)} · ${held}`,
    warning: repeatedWarning(area, faces, text, intl),
  };
}
