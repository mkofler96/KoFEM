// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// The analysis report (KOF-391): what it says, gathered from the model and
// its static result. The numbers come from the Rust module (reportStats) and
// the solve (reactions); this module only arranges them, and refuses the
// report when something it must state is missing, rather than print a
// placeholder. renderReport turns the document into the HTML file.

import type {
  Element,
  Material,
  MeshSizes,
  NamedBcGroup,
  NamedLoadGroup,
  Node,
  Property,
  SolverResult,
  SolveRun,
} from "../../store/modelStore";
import { loadComponents, loadKind } from "../../store/boundaryGroups";
import type { TemperatureLoad } from "../../workers/solverTypes";
import type { ReactionSummary, Vec3 } from "../solve/reactions";
import type { Legend } from "../legend";
import type { FigureImage, ReportFigures } from "./figures";
import type { ReportAssets } from "./assets";
import type { RefinementStudyRun } from "../../store/studySlice";
import type { DensityResult } from "../../store/topOptSlice";
import { verdictLine, type StudyLevel } from "../refinementStudy";
import { safetyRowLabel, type SafetyFactorRow } from "../safetyFactor";
import { elementBodyName, solidName } from "../regions";
import { tr } from "../../i18n/useLocale";
import { reportMessages } from "../../i18n/messages/report";

// The report's result numbers, as reportStats returns them.
export interface ReportStats {
  maxDisplacement: number;
  maxVonMises: number;
  p99VonMises: number;
}

export interface ReportInput {
  modelName: string;
  createdAt: string;
  version: string;
  nodes: Node[];
  elements: Element[];
  properties: Property[];
  materials: Material[];
  bcGroups: NamedBcGroup[];
  loadGroups: NamedLoadGroup[];
  temperature: TemperatureLoad | null;
  meshSizes: MeshSizes | null;
  result: SolverResult | null;
  stats: ReportStats;
  safety: SafetyFactorRow[];
  figures: ReportFigures;
  assets: ReportAssets;
  // The mesh refinement study as the store holds it; reported once it is done.
  refinement: RefinementStudyRun | null;
  topology: ReportTopology | null;
  // The legend of the view the figures show, and the field's name.
  legend: Legend;
  figureField: string;
}

// The topology optimization's run, the density cutoff the view applies and
// the density field drawn in the current view.
export interface ReportTopology {
  result: DensityResult;
  threshold: number;
  figure: FigureImage;
}

export interface ReportRefinement {
  levels: StudyLevel[];
  converged: boolean;
  // The verdict as the study panel words it.
  verdict: string;
}

export type ElementFamily = "solid" | "shell" | "mixed";

export interface BodyRow {
  propertyId: number;
  name: string;
  material: Material;
  family: ElementFamily;
  // The shell thickness in mm; only for shell elements that carry one.
  thickness: number | null;
  elementType: string;
  elementCount: number;
}

export interface SupportRow {
  name: string;
  faces: string[];
  dofs: string;
  value: number;
}

export interface LoadRow {
  name: string;
  kind: string;
  faces: string[];
  // The pressure, or the force or moment vector, in `unit`.
  value: number[];
  unit: "MPa" | "N" | "N mm";
}

export interface ReportSafetyRow {
  key: string;
  body: string;
  maxFactor: number;
  p99Factor: number;
}

export interface ReportDocument {
  modelName: string;
  // When the report was made, as the user's locale writes it, and the
  // KoFEM version that made it.
  date: string;
  version: string;
  bodies: BodyRow[];
  supports: SupportRow[];
  loads: LoadRow[];
  temperature: string | null;
  mesh: {
    nodes: number;
    elements: number;
    // [label, mm] of each size setting; null when the mesh does not record
    // them (a loaded analysis).
    sizes: [string, number][] | null;
  };
  // Null for a result that did not come from a solve here.
  run: SolveRun | null;
  stats: ReportStats;
  safety: ReportSafetyRow[];
  reactions: ReactionSummary | null;
  appliedTotal: Vec3 | null;
  figures: ReportFigures;
  assets: ReportAssets;
  refinement: ReportRefinement | null;
  topology: ReportTopology | null;
  legend: Legend;
  figureField: string;
}

const DOF_NAMES = ["Ux", "Uy", "Uz", "Rx", "Ry", "Rz"];

// A number as the report prints it: four significant digits.
export const reportNumber = (value: number): string =>
  String(Number(value.toPrecision(4)));

function bodyRows(input: ReportInput, run: SolveRun | null): BodyRow[] {
  const text = tr(reportMessages);
  // The bodies and materials the solve used; a result loaded from a file has
  // no run, and the file's own are the model's.
  const { properties, materials } = run ?? input;
  const counts = new Map<number, Map<Element["type"], number>>();
  for (const element of input.elements) {
    const byType = counts.get(element.propertyId) ?? new Map();
    byType.set(element.type, (byType.get(element.type) ?? 0) + 1);
    counts.set(element.propertyId, byType);
  }
  return [...counts.entries()]
    .sort(([a], [b]) => a - b)
    .map(([propertyId, byType]) => {
      const property = properties.find((p) => p.id === propertyId);
      if (!property)
        throw new Error(
          `report: elements use property ${propertyId}, which the model does not have`,
        );
      const material = materials.find((m) => m.id === property.materialId);
      if (!material)
        throw new Error(
          `report: property ${propertyId} uses material ${property.materialId}, which the model does not have`,
        );
      const types: string[] = [];
      let thickness: number | null = null;
      if (byType.has("CTRIA3")) {
        if (property.thickness === undefined)
          throw new Error(
            `report: the shell elements of property ${propertyId} have no thickness`,
          );
        thickness = property.thickness;
        types.push(text.shell(reportNumber(thickness)));
      }
      // A body marked Shell on a solid mesh is idealised in the solve.
      const solidElements = byType.has("CTETRA") || byType.has("CHEXA");
      const shellAtSolve =
        solidElements &&
        run?.path === "auto-shell" &&
        property.discretization === "shell";
      if (shellAtSolve) types.push(text.shellAtSolve);
      else {
        if (byType.has("CTETRA")) types.push(text.solidTets);
        if (byType.has("CHEXA")) types.push(text.solidHexes);
      }
      const family: ElementFamily =
        shellAtSolve || !solidElements
          ? "shell"
          : byType.has("CTRIA3")
            ? "mixed"
            : "solid";
      return {
        propertyId,
        name: elementBodyName(properties, property),
        material,
        family,
        thickness,
        elementType: types.join("; "),
        elementCount: [...byType.values()].reduce((a, b) => a + b, 0),
      };
    });
}

function loadValue(
  group: NamedLoadGroup,
): Pick<LoadRow, "kind" | "value" | "unit"> {
  const text = tr(reportMessages);
  const kind = loadKind(group);
  if (kind === "pressure")
    return { kind: text.pressure, value: [group.totalForce], unit: "MPa" };
  if (kind === "moment")
    return { kind: text.moment, value: loadComponents(group), unit: "N mm" };
  return { kind: text.force, value: loadComponents(group), unit: "N" };
}

// A study still running, or one that failed, has no verdict to report; one
// level cannot be compared.
function refinement(study: RefinementStudyRun | null): ReportRefinement | null {
  if (study === null || study.status !== "done" || study.levels.length < 2)
    return null;
  const { converged, text } = verdictLine(study.levels, study.settings);
  return { levels: study.levels, converged, verdict: text };
}

function topology(given: ReportTopology | null): ReportTopology | null {
  if (given === null) return null;
  if (given.result.history.length === 0)
    throw new Error(tr(reportMessages).noTopologyHistory);
  return given;
}

export function buildReport(input: ReportInput): ReportDocument {
  const text = tr(reportMessages);
  const { result } = input;
  if (result === null) throw new Error(text.noResult);
  const run = result.run ?? null;
  const reactions = result.reactions ?? null;
  return {
    modelName: input.modelName.trim() === "" ? text.untitled : input.modelName,
    date: input.createdAt,
    version: input.version,
    bodies: bodyRows(input, run),
    supports: input.bcGroups.map((group) => ({
      name: group.name,
      faces: group.faces.map((face) => face.label),
      dofs: group.dofs.map((dof) => DOF_NAMES[dof]).join(", "),
      value: group.value,
    })),
    loads: input.loadGroups.map((group) => ({
      name: group.name,
      faces: group.faces.map((face) => face.label),
      ...loadValue(group),
    })),
    temperature:
      input.temperature === null
        ? null
        : text.temperature(input.temperature.formula),
    mesh: {
      nodes: input.nodes.length,
      elements: input.elements.length,
      sizes:
        input.meshSizes === null
          ? null
          : [
              [text.maxSize, input.meshSizes.max],
              [text.minSize, input.meshSizes.min],
              ...Object.entries(input.meshSizes.regions).map(
                ([solid, size]): [string, number] => [
                  text.regionSize(solidName(input.properties, Number(solid))),
                  size,
                ],
              ),
            ],
    },
    run,
    stats: input.stats,
    safety: input.safety.map((row) => ({
      key: row.propertyId === null ? "model" : String(row.propertyId),
      body: safetyRowLabel(
        row,
        (run ?? input).properties,
        (run ?? input).materials,
      ),
      maxFactor: row.maxFactor,
      p99Factor: row.p99Factor,
    })),
    reactions,
    appliedTotal: reactions?.applied ?? null,
    figures: input.figures,
    assets: input.assets,
    refinement: refinement(input.refinement),
    topology: topology(input.topology),
    legend: input.legend,
    figureField: input.figureField,
  };
}
