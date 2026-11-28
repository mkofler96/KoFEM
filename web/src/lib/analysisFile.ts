// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { LargeDeformation, TemperatureLoad } from "../workers/solverTypes";
import {
  DEFAULT_LOAD_INCREMENTS,
  isLoadIncrementCount,
  MAX_LOAD_INCREMENTS,
} from "./solve/largeDeformation";
import {
  cornerCount,
  SHELL_SURFACES,
  uniformStress,
  type ElementStress,
} from "./stressFields";
import type { ContactResult } from "./contact";
import type {
  AppMode,
  ContactGroup,
  CouplingGroup,
  Element,
  ElementType,
  Material,
  NamedBcGroup,
  NamedLoadGroup,
  Node,
  Property,
  ResultType,
  StepTessellation,
  TieGroup,
  StressAggregation,
  TopOptMethod,
  TopOptObjective,
  TopOptSettingsState,
  VolMesh,
} from "../store/modelStore";
import { DEFAULT_TOPOPT_SETTINGS, RESULT_TYPES } from "../store/modelStore";
import type { FaceSize, MeshSizes } from "../store/geometrySlice";
import { parseHandCheck, type HandCheck } from "./handCheck";
import { tieMethod, type TieMethod } from "./tie";
import { restoreInterfaces, type BodyInterface } from "./interfaces";
import type { ViewRepr } from "../store/viewSlice";

// ── KoFEM analysis file format (.vtu) ─────────────────────────────────────────
//
// A single VTK XML UnstructuredGrid file (industry-standard .vtu) holding the
// complete analysis state.  The file opens directly in ParaView / VisIt /
// meshio: the FEM mesh is stored as the unstructured grid, result fields as
// PointData arrays, and node / element identity as PointData / CellData
// integer arrays.
//
//   <VTKFile type="UnstructuredGrid" ...>
//     <UnstructuredGrid>
//       <FieldData>
//         <DataArray type="UInt8" Name="KoFEM" format="binary">  ← setup JSON
//         Stress, or StressTop / StressMiddle / StressBottom (Float64 ×6 per
//                       element corner; corners in each cell's node order)
//       </FieldData>
//       <Piece NumberOfPoints=... NumberOfCells=...>
//         <Points>      Float64 ×3 node coordinates (in store order)
//         <Cells>       connectivity / offsets / VTK cell types
//         <PointData>   NodeId (Int64), Displacement (Float64 ×3, per node)
//         <CellData>    ElementId, PropertyId (Int64),
//                       VonMises (Float64, per element)
//       result arrays are present only when the analysis was solved
//
// Everything ParaView has no native representation for — materials,
// properties, named BC / load groups, the tessellated STEP surface, view /
// mode state — travels as a UTF-8 JSON document in the
// "KoFEM" FieldData array.  It is a plain UInt8 DataArray (base64 "binary"
// VTK encoding: little-endian UInt32 byte count followed by the payload)
// rather than a VTK string array, because strict readers like meshio reject
// string arrays; numeric field data is ignored gracefully by every reader.
//
// The embedded JSON is versioned (`format` marker + `version`); bump
// ANALYSIS_FILE_VERSION and add a migration in parseAnalysisFile when the
// schema changes.  Derived state (flat constraint / load arrays) is NOT
// stored — it is rebuilt from the named groups on load.
//
// The writer is deterministic (fixed element order, shortest-round-trip
// number formatting, fixed JSON key order), so loading a file and re-saving
// it produces byte-identical output.  parseAnalysisFile only accepts files
// written by KoFEM (it requires the KoFEM FieldData entry) — arbitrary .vtu
// files from other tools are rejected with a clear error.

export const ANALYSIS_FILE_FORMAT = "kofem-analysis";
export const ANALYSIS_FILE_VERSION = 1;

// The subset of the model store an analysis file is built from / restored into.
export interface AnalysisState {
  modelName: string;
  mode: AppMode;
  viewRepr: ViewRepr;
  nodes: Node[];
  elements: Element[];
  materials: Material[];
  properties: Property[];
  bcGroups: NamedBcGroup[];
  loadGroups: NamedLoadGroup[];
  tieGroups: TieGroup[];
  contactGroups: ContactGroup[];
  couplingGroups: CouplingGroup[];
  // A temperature change over the model (KOF-449), or null for none.
  temperature: TemperatureLoad | null;
  nextBcGroupId: number;
  nextLoadGroupId: number;
  nextTieGroupId: number;
  nextContactGroupId: number;
  nextCouplingGroupId: number;
  nextFaceEntryId: number;
  nextMatId: number;
  stepSurface: StepTessellation | null;
  // Body-to-body interfaces of stepSurface (lib/interfaces); null when the
  // tessellation carries no face ids to find them by.
  interfaces: BodyInterface[] | null;
  volMesh: VolMesh | null;
  surfaceTriangles: [number, number, number][] | null;
  surfaceFaceIds: number[] | null;
  result: {
    displacements: Float64Array;
    vonMises?: Float64Array;
    stress?: ElementStress;
    contact?: ContactResult | null;
  } | null;
  resultType: ResultType;
  // Topology-optimization setup (KOF-232). Absent in files written before TO
  // existed — such a file restores the default settings. The density field a
  // run produces is a transient result and is not saved.
  topOpt?: TopOptSettingsState;
  // FE polynomial order of the solve (1 linear, 2 quadratic).
  elementOrder: number;
  // The Solve panel's large-deformation option and its load increments.
  largeDeformation: boolean;
  loadIncrements: number;
  // The closed-form check a gallery example carries (lib/handCheck), or null.
  handCheck: HandCheck | null;
  // Element sizes on selected CAD faces (KOF-394); empty for none.
  faceSizes: FaceSize[];
  // The element sizes the mesh was made with, or null when unknown.
  meshSizes: MeshSizes | null;
}

// Setup state embedded as JSON in the "KoFEM" FieldData string array.
// `elementTypes` records the source element type of each cell so the
// round-trip preserves it independently of the VTK cell-type number; the
// mesh itself lives in the native VTU sections.
interface KofemFieldDataV1 {
  format: typeof ANALYSIS_FILE_FORMAT;
  version: 1;
  modelName: string;
  mode: AppMode;
  // "volume": a view files written before KOF-429 may hold (savedViewRepr).
  viewRepr: ViewRepr | "volume";
  resultType: ResultType;
  elementTypes: ElementType[];
  materials: Material[];
  properties: Property[];
  bcGroups: NamedBcGroup[];
  loadGroups: NamedLoadGroup[];
  // Tie (connector) conditions. Absent in files written before connections
  // became a named model object — such a file simply has no ties. A tie's
  // `method` is absent in files written before the constraint tie existed.
  tieGroups?: (Omit<TieGroup, "method"> & { method?: TieMethod })[];
  // Contacts (KOF-485). Absent in files written before contact existed —
  // such a file simply has none.
  contactGroups?: ContactGroup[];
  // What the solve found at the contacts (KOF-485), with a result that has
  // one: per slave node, as in ContactResult.
  contactResult?: SavedContactResult;
  // Surface-to-point couplings. Absent in files written before couplings
  // existed — such a file simply has none. The reference points themselves need
  // no separate entry: they are nodes, and travel in the VTU point list.
  couplingGroups?: CouplingGroup[];
  // A temperature change (KOF-449). Absent in files written before it
  // existed — such a file has none.
  temperature?: TemperatureLoad | null;
  nextBcGroupId: number;
  nextLoadGroupId: number;
  nextTieGroupId?: number;
  nextContactGroupId?: number;
  nextCouplingGroupId?: number;
  nextFaceEntryId: number;
  nextMatId: number;
  stepSurface: StepTessellation | null;
  // The body-to-body interfaces and their types. Written only when the
  // geometry has some, so single-body files are unchanged; absent in files
  // written before interfaces existed (all bonded, as re-detection yields).
  // Validated against the interfaces re-detected from stepSurface on load.
  interfaces?: BodyInterface[];
  volMesh: VolMesh | null;
  surfaceTriangles: [number, number, number][] | null;
  surfaceFaceIds: number[] | null;
  // Topology-optimization setup. Absent in files written before TO existed.
  topOpt?: TopOptSettingsState;
  // Absent in files written before the order was saved; they were solved with
  // whatever order the session had, and reopen linear (the app's default).
  elementOrder?: number;
  // Written only while on (KOF-486), so files without it are unchanged; such
  // a file reopens with the option off and the default increments.
  largeDeformation?: LargeDeformation;
  // Only gallery examples carry one.
  handCheck?: HandCheck;
  // Written only when there are some (KOF-394), so files without face sizes
  // are unchanged.
  faceSizes?: FaceSize[];
  // Written only when known: absent in files written before the sizes were
  // saved, and for a mesh whose sizes the session did not know.
  meshSizes?: MeshSizes;
}

// ── VTK cell types (vtkCellType.h) ────────────────────────────────────────────

function vtkCellType(type: ElementType, nNodes: number): number {
  switch (type) {
    case "CTETRA":
      return nNodes === 10 ? 24 : 10; // VTK_(QUADRATIC_)TETRA
    case "CHEXA":
      return nNodes === 20 ? 25 : 12; // VTK_(QUADRATIC_)HEXAHEDRON
    case "CTRIA3":
      return 5; // VTK_TRIANGLE — 3-node Kirchhoff shell facet
    default:
      throw new Error(
        `Cannot serialize analysis: unknown element type "${type}"`,
      );
  }
}

// ── base64 helpers (browser + node/bun) ───────────────────────────────────────

function bytesToBase64(bytes: Uint8Array): string {
  let bin = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk)
    bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
  return btoa(bin);
}

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// VTK "binary" DataArray encoding: base64 of a little-endian UInt32 byte
// count followed by the raw payload (header_type="UInt32").
function encodeVtkBinary(text: string): { b64: string; byteLength: number } {
  const data = new TextEncoder().encode(text);
  const bytes = new Uint8Array(4 + data.length);
  new DataView(bytes.buffer).setUint32(0, data.length, true);
  bytes.set(data, 4);
  return { b64: bytesToBase64(bytes), byteLength: data.length };
}

function decodeVtkBinary(b64: string): string {
  const bytes = base64ToBytes(b64);
  if (bytes.length < 4)
    throw new Error(
      "Invalid analysis file: KoFEM FieldData payload is too short",
    );
  const len = new DataView(bytes.buffer).getUint32(0, true);
  if (4 + len > bytes.length)
    throw new Error(
      `Invalid analysis file: KoFEM FieldData header declares ${len} bytes but only ${bytes.length - 4} are present`,
    );
  return new TextDecoder().decode(bytes.subarray(4, 4 + len));
}

// ── Serialization ─────────────────────────────────────────────────────────────

function joinTuples(values: ArrayLike<number>, stride: number): string {
  const lines: string[] = [];
  for (let i = 0; i < values.length; i += stride) {
    const parts: string[] = [];
    for (let j = 0; j < stride && i + j < values.length; j++)
      parts.push(String(values[i + j]));
    lines.push(parts.join(" "));
  }
  return lines.join("\n");
}

function dataArray(
  type: string,
  name: string,
  body: string,
  components?: number,
): string {
  const comp =
    components !== undefined ? ` NumberOfComponents="${components}"` : "";
  return `<DataArray type="${type}" Name="${name}"${comp} format="ascii">\n${body}\n</DataArray>`;
}

// A contact result as the file's JSON holds it: plain arrays.
interface SavedContactResult {
  nodeIds: number[];
  pressure: number[];
  gap: number[];
  closed: number[];
  area: number[];
  force: number;
  iterations: number;
}

function savedContactResult(contact: ContactResult): SavedContactResult {
  return {
    nodeIds: contact.nodeIds,
    pressure: Array.from(contact.pressure),
    gap: Array.from(contact.gap),
    closed: Array.from(contact.closed),
    area: Array.from(contact.area),
    force: contact.force,
    iterations: contact.iterations,
  };
}

function restoredContactResult(
  saved: SavedContactResult,
  nodeIds: Set<number>,
): ContactResult {
  const invalid = (why: string) =>
    new Error(`Invalid analysis file: the contact result ${why}`);
  if (typeof saved !== "object" || saved === null)
    throw invalid("is not an object");
  const lists = ["nodeIds", "pressure", "gap", "closed", "area"] as const;
  for (const name of lists)
    if (
      !Array.isArray(saved[name]) ||
      !saved[name].every((value) => Number.isFinite(value))
    )
      throw invalid(`has no list of numbers "${name}"`);
  const count = saved.nodeIds.length;
  for (const name of lists)
    if (saved[name].length !== count)
      throw invalid(`has ${saved[name].length} ${name} for ${count} nodes`);
  const unknown = saved.nodeIds.find((id) => !nodeIds.has(id));
  if (unknown !== undefined)
    throw invalid(`names node ${unknown}, which the mesh does not have`);
  if (saved.closed.some((closed) => closed !== 0 && closed !== 1))
    throw invalid("marks a node touching with a value other than 0 or 1");
  if (!Number.isFinite(saved.force) || !Number.isInteger(saved.iterations))
    throw invalid("has no force or iteration count");
  return {
    nodeIds: saved.nodeIds,
    pressure: Float64Array.from(saved.pressure),
    gap: Float64Array.from(saved.gap),
    closed: Uint8Array.from(saved.closed),
    area: Float64Array.from(saved.area),
    force: saved.force,
    iterations: saved.iterations,
  };
}

export function serializeAnalysis(state: AnalysisState): string {
  const { nodes, elements, result } = state;

  if (result && result.displacements.length !== 3 * nodes.length)
    throw new Error(
      `Cannot save analysis: displacement field has ${result.displacements.length} values but the mesh has ${nodes.length} nodes (expected ${3 * nodes.length})`,
    );
  if (result?.vonMises && result.vonMises.length !== elements.length)
    throw new Error(
      `Cannot save analysis: von Mises field has ${result.vonMises.length} values but the mesh has ${elements.length} elements (von Mises is stored per element)`,
    );
  const corners = elements.reduce((n, el) => n + cornerCount(el), 0);
  if (result?.stress)
    for (const surface of SHELL_SURFACES)
      if (result.stress[surface].length !== 6 * corners)
        throw new Error(
          `Cannot save analysis: the ${surface} stress tensors have ${result.stress[surface].length} values but the mesh's elements have ${corners} corners (expected six per corner)`,
        );

  const idToIndex = new Map(nodes.map((n, i) => [n.id, i]));
  const connectivity: string[] = [];
  const offsets: number[] = [];
  const types: number[] = [];
  let offset = 0;
  for (const el of elements) {
    const idxs = el.nodeIds.map((id) => {
      const idx = idToIndex.get(id);
      if (idx === undefined)
        throw new Error(
          `Cannot save analysis: element ${el.id} references unknown node ${id}`,
        );
      return idx;
    });
    connectivity.push(idxs.join(" "));
    offset += el.nodeIds.length;
    offsets.push(offset);
    types.push(vtkCellType(el.type, el.nodeIds.length));
  }

  const meta: KofemFieldDataV1 = {
    format: ANALYSIS_FILE_FORMAT,
    version: ANALYSIS_FILE_VERSION,
    modelName: state.modelName,
    mode: state.mode,
    viewRepr: state.viewRepr,
    resultType: state.resultType,
    elementTypes: elements.map((el) => el.type),
    materials: state.materials,
    properties: state.properties,
    bcGroups: state.bcGroups,
    loadGroups: state.loadGroups,
    tieGroups: state.tieGroups,
    couplingGroups: state.couplingGroups,
    temperature: state.temperature,
    nextBcGroupId: state.nextBcGroupId,
    nextLoadGroupId: state.nextLoadGroupId,
    nextTieGroupId: state.nextTieGroupId,
    nextCouplingGroupId: state.nextCouplingGroupId,
    nextFaceEntryId: state.nextFaceEntryId,
    nextMatId: state.nextMatId,
    stepSurface: state.stepSurface,
    ...(state.interfaces && state.interfaces.length > 0
      ? { interfaces: state.interfaces }
      : {}),
    volMesh: state.volMesh,
    surfaceTriangles: state.surfaceTriangles,
    surfaceFaceIds: state.surfaceFaceIds,
    topOpt: state.topOpt,
    elementOrder: state.elementOrder,
    ...(state.largeDeformation
      ? { largeDeformation: { increments: state.loadIncrements } }
      : {}),
    ...(state.handCheck ? { handCheck: state.handCheck } : {}),
    // A model that never had a contact saves as it did before contact
    // existed (KOF-485).
    ...(state.contactGroups.length > 0 || state.nextContactGroupId > 1
      ? {
          contactGroups: state.contactGroups,
          nextContactGroupId: state.nextContactGroupId,
        }
      : {}),
    ...(result?.contact
      ? { contactResult: savedContactResult(result.contact) }
      : {}),
    ...(state.faceSizes.length > 0 ? { faceSizes: state.faceSizes } : {}),
    ...(state.meshSizes ? { meshSizes: state.meshSizes } : {}),
  };

  const pointData: string[] = [
    dataArray("Int64", "NodeId", nodes.map((n) => n.id).join(" ")),
  ];
  if (result) {
    pointData.push(
      dataArray(
        "Float64",
        "Displacement",
        joinTuples(result.displacements, 3),
        3,
      ),
    );
  }

  const cellData = [
    dataArray("Int64", "ElementId", elements.map((el) => el.id).join(" ")),
    dataArray(
      "Int64",
      "PropertyId",
      elements.map((el) => el.propertyId).join(" "),
    ),
  ];
  if (result?.vonMises)
    cellData.push(
      dataArray("Float64", "VonMises", joinTuples(result.vonMises, 1)),
    );
  // One tensor per element corner (σxx σyy σzz τxy τyz τzx): field data, as a
  // value per corner is no cell array. A model with shells keeps each surface;
  // one without holds the same tensors on all three.
  const fieldData: string[] = [];
  if (result?.stress) {
    const { top, middle, bottom } = result.stress;
    if (top === middle && middle === bottom)
      fieldData.push(dataArray("Float64", "Stress", joinTuples(top, 6), 6));
    else
      for (const [name, values] of [
        ["StressTop", top],
        ["StressMiddle", middle],
        ["StressBottom", bottom],
      ] as const)
        fieldData.push(dataArray("Float64", name, joinTuples(values, 6), 6));
  }

  const points = nodes.map((n) => `${n.x} ${n.y} ${n.z}`).join("\n");
  const encodedMeta = encodeVtkBinary(JSON.stringify(meta));

  return [
    `<?xml version="1.0"?>`,
    `<VTKFile type="UnstructuredGrid" version="1.0" byte_order="LittleEndian" header_type="UInt32">`,
    `<UnstructuredGrid>`,
    `<FieldData>`,
    `<DataArray type="UInt8" Name="KoFEM" NumberOfTuples="${encodedMeta.byteLength}" format="binary">`,
    encodedMeta.b64,
    `</DataArray>`,
    ...fieldData,
    `</FieldData>`,
    `<Piece NumberOfPoints="${nodes.length}" NumberOfCells="${elements.length}">`,
    `<Points>`,
    dataArray("Float64", "Points", points, 3),
    `</Points>`,
    `<Cells>`,
    dataArray("Int64", "connectivity", connectivity.join("\n")),
    dataArray("Int64", "offsets", offsets.join(" ")),
    dataArray("UInt8", "types", types.join(" ")),
    `</Cells>`,
    `<PointData>`,
    ...pointData,
    `</PointData>`,
    `<CellData>`,
    ...cellData,
    `</CellData>`,
    `</Piece>`,
    `</UnstructuredGrid>`,
    `</VTKFile>`,
    ``,
  ].join("\n");
}

export function analysisFileName(modelName: string): string {
  // eslint-disable-next-line kofem/no-silent-fallback -- download filename for an unnamed model; cosmetic, never fed back into the analysis
  const base = (modelName || "analysis").replace(/[^\w-]+/g, "_");
  return `${base}.vtu`;
}

// ── Parsing ───────────────────────────────────────────────────────────────────

const APP_MODES: AppMode[] = [
  "geometry",
  "constraints",
  "solve",
  "optimize",
  "results",
];
const TOPOPT_OBJECTIVES: TopOptObjective[] = ["min_compliance", "min_volume"];
const TOPOPT_METHODS: TopOptMethod[] = ["simp", "level_set"];
const TOPOPT_NUMERIC_FIELDS: (keyof TopOptSettingsState)[] = [
  "volumeFraction",
  "complianceLimit",
  "penalty",
  "filterRadius",
  "moveLimit",
  "maxIterations",
  "tolerance",
];
// The max-stress settings (KOF-236) postdate the first TO settings blocks, so a
// file may lack all of them; they are then filled from the defaults (stress
// constraint off). A file that carries any of them must carry all, well-typed.
const TOPOPT_STRESS_FIELDS = [
  "stressConstraint",
  "maxStress",
  "stressAggregation",
  "stressP",
] as const;
const STRESS_AGGREGATIONS: StressAggregation[] = ["pnorm", "ks"];
const VIEW_REPRS = ["geometry", "surface", "volume", "wireframe"] as const;

// The Volume view drew every element edge under an opaque surface, so it
// looked the same as the Surface view; it was retired (KOF-429) and a file
// saved in it opens in the Surface view.
function savedViewRepr(saved: KofemFieldDataV1["viewRepr"]): ViewRepr {
  return saved === "volume" ? "surface" : saved;
}
const ELEMENT_TYPES: ElementType[] = ["CTETRA", "CHEXA", "CTRIA3"];

function dataArrayContent(xml: string, name: string): string {
  const match = xml.match(
    new RegExp(`<DataArray[^>]*Name="${name}"[^>]*>([\\s\\S]*?)</DataArray>`),
  );
  if (!match)
    throw new Error(`Invalid analysis file: missing DataArray "${name}"`);
  return match[1].trim();
}

function parseNumbers(text: string, context: string): number[] {
  if (!text) return [];
  return text.split(/\s+/).map((token) => {
    const value = Number(token);
    if (Number.isNaN(value) && token !== "NaN")
      throw new Error(
        `Invalid analysis file: non-numeric value "${token}" in "${context}"`,
      );
    return value;
  });
}

function expectLength(actual: number, expected: number, context: string): void {
  if (actual !== expected)
    throw new Error(
      `Invalid analysis file: "${context}" has ${actual} values, expected ${expected}`,
    );
}

const isPositiveId = (v: unknown): boolean =>
  typeof v === "number" && Number.isInteger(v) && v > 0;
const isPositive = (v: unknown): boolean =>
  typeof v === "number" && Number.isFinite(v) && v > 0;

function isSizeTable(v: unknown): boolean {
  return (
    typeof v === "object" &&
    v !== null &&
    !Array.isArray(v) &&
    Object.entries(v).every(
      ([id, size]) => isPositiveId(Number(id)) && isPositive(size),
    )
  );
}

// Face sizes as the store holds them: faces by id, each entry's size as typed.
function checkFaceSizes(value: unknown): void {
  const valid =
    Array.isArray(value) &&
    value.every(
      (e: unknown) =>
        typeof e === "object" &&
        e !== null &&
        Array.isArray((e as FaceSize).faceIds) &&
        (e as FaceSize).faceIds.length > 0 &&
        (e as FaceSize).faceIds.every(isPositiveId) &&
        typeof (e as FaceSize).size === "string",
    );
  if (!valid)
    throw new Error(
      'Invalid analysis file: "faceSizes" must list entries of face ids and a size',
    );
}

function checkLargeDeformation(value: unknown): void {
  const increments =
    typeof value === "object" && value !== null
      ? (value as Partial<LargeDeformation>).increments
      : undefined;
  if (typeof increments !== "number" || !isLoadIncrementCount(increments))
    throw new Error(
      `Invalid analysis file: "largeDeformation" must give its load increments, a whole number from 1 to ${MAX_LOAD_INCREMENTS}`,
    );
}

// A material's yield strength (KOF-496) is optional, but one given is a
// positive number of MPa.
function checkYieldStrengths(materials: Record<string, unknown>[]): void {
  for (const material of materials)
    if (
      material.yieldStrength !== undefined &&
      !isPositive(material.yieldStrength)
    )
      throw new Error(
        `Invalid analysis file: material ${String(material.id)} has the yield strength ${JSON.stringify(material.yieldStrength)}, which is not a positive number`,
      );
}

function checkMeshSizes(value: unknown): void {
  const sizes = value as Partial<MeshSizes> | null;
  const valid =
    typeof sizes === "object" &&
    sizes !== null &&
    isPositive(sizes.max) &&
    typeof sizes.min === "number" &&
    sizes.min >= 0 &&
    isSizeTable(sizes.regions) &&
    isSizeTable(sizes.faces);
  if (!valid)
    throw new Error(
      'Invalid analysis file: "meshSizes" must hold max, min, regions and faces sizes',
    );
}

function parseMetadata(xml: string): KofemFieldDataV1 {
  const match = xml.match(
    /<DataArray[^>]*Name="KoFEM"[^>]*>([\s\S]*?)<\/DataArray>/,
  );
  if (!match)
    throw new Error(
      'Not a KoFEM analysis file: missing the "KoFEM" FieldData entry — only .vtu files saved by KoFEM can be loaded',
    );
  let raw: unknown;
  try {
    raw = JSON.parse(decodeVtkBinary(match[1].trim()));
  } catch (err) {
    throw new Error(
      `Invalid analysis file: KoFEM FieldData is not valid JSON: ${(err as Error).message}`,
    );
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw))
    throw new Error(
      "Invalid analysis file: KoFEM FieldData is not a JSON object",
    );
  const meta = raw as Record<string, unknown>;

  if (meta.format !== ANALYSIS_FILE_FORMAT)
    throw new Error(
      `Not a KoFEM analysis file: expected format "${ANALYSIS_FILE_FORMAT}", got "${meta.format}"`,
    );
  if (meta.version !== ANALYSIS_FILE_VERSION)
    throw new Error(
      `Unsupported analysis file version ${meta.version} — this build of KoFEM supports version ${ANALYSIS_FILE_VERSION}`,
    );

  for (const field of [
    "elementTypes",
    "materials",
    "properties",
    "bcGroups",
    "loadGroups",
  ])
    if (!Array.isArray(meta[field]))
      throw new Error(
        `Invalid analysis file: "${field}" must be an array, got ${typeof meta[field]}`,
      );

  // A support or load is told apart by its name alone (KOF-339): the Name
  // field refuses a blank one, and so does the file.
  for (const [field, what] of [
    ["bcGroups", "support"],
    ["loadGroups", "load"],
  ] as const)
    for (const group of meta[field] as Record<string, unknown>[]) {
      if (typeof group.name !== "string")
        throw new Error(
          `Invalid analysis file: ${what} ${String(group.id)} has no name`,
        );
      if (group.name.trim() === "")
        throw new Error(
          `Invalid analysis file: ${what} ${String(group.id)} has a blank name`,
        );
    }

  checkYieldStrengths(meta.materials as Record<string, unknown>[]);
  if (meta.faceSizes !== undefined) checkFaceSizes(meta.faceSizes);
  if (meta.meshSizes !== undefined) checkMeshSizes(meta.meshSizes);
  if (meta.largeDeformation !== undefined)
    checkLargeDeformation(meta.largeDeformation);

  // Ties postdate the first analysis files, so absence is legitimate — but a
  // present entry of the wrong shape is not.
  if (meta.tieGroups !== undefined && !Array.isArray(meta.tieGroups))
    throw new Error(
      `Invalid analysis file: "tieGroups" must be an array, got ${typeof meta.tieGroups}`,
    );
  if (meta.contactGroups !== undefined && !Array.isArray(meta.contactGroups))
    throw new Error(
      `Invalid analysis file: "contactGroups" must be an array, got ${typeof meta.contactGroups}`,
    );
  if (meta.couplingGroups !== undefined && !Array.isArray(meta.couplingGroups))
    throw new Error(
      `Invalid analysis file: "couplingGroups" must be an array, got ${typeof meta.couplingGroups}`,
    );
  const temperature: unknown = meta.temperature;
  if (
    temperature !== undefined &&
    temperature !== null &&
    !(
      typeof temperature === "object" &&
      typeof (temperature as { formula?: unknown }).formula === "string" &&
      (temperature as { formula: string }).formula.trim() !== ""
    )
  )
    throw new Error(
      `Invalid analysis file: "temperature" must be null or { formula: "…" }, got ${JSON.stringify(temperature)}`,
    );

  // TO settings postdate the first analysis files, so absence is legitimate —
  // but a present block of the wrong shape is not. The numeric fields are the
  // raw strings the user typed (validated when a run starts), so only their
  // type is checked here, not their range.
  if (meta.topOpt !== undefined) {
    const topOptRaw = meta.topOpt;
    if (
      typeof topOptRaw !== "object" ||
      topOptRaw === null ||
      Array.isArray(topOptRaw)
    )
      throw new Error(
        `Invalid analysis file: "topOpt" must be an object, got ${typeof topOptRaw}`,
      );
    const to = topOptRaw as Record<string, unknown>;
    // Legacy: files written before the level-set method carry no `method` — every
    // one of them was a SIMP setup.
    if (to.method === undefined) to.method = "simp";
    if (!TOPOPT_METHODS.includes(to.method as TopOptMethod))
      throw new Error(
        `Invalid analysis file: unknown topOpt method "${to.method}"`,
      );
    if (!TOPOPT_OBJECTIVES.includes(to.objective as TopOptObjective))
      throw new Error(
        `Invalid analysis file: unknown topOpt objective "${to.objective}"`,
      );
    for (const field of TOPOPT_NUMERIC_FIELDS)
      if (typeof to[field] !== "string")
        throw new Error(
          `Invalid analysis file: topOpt.${field} must be a string, got ${typeof to[field]}`,
        );
    if (TOPOPT_STRESS_FIELDS.every((field) => to[field] === undefined)) {
      for (const field of TOPOPT_STRESS_FIELDS)
        to[field] = DEFAULT_TOPOPT_SETTINGS[field];
    } else {
      if (typeof to.stressConstraint !== "boolean")
        throw new Error(
          `Invalid analysis file: topOpt.stressConstraint must be a boolean, got ${typeof to.stressConstraint}`,
        );
      for (const field of ["maxStress", "stressP"] as const)
        if (typeof to[field] !== "string")
          throw new Error(
            `Invalid analysis file: topOpt.${field} must be a string, got ${typeof to[field]}`,
          );
      if (
        !STRESS_AGGREGATIONS.includes(to.stressAggregation as StressAggregation)
      )
        throw new Error(
          `Invalid analysis file: unknown topOpt.stressAggregation "${to.stressAggregation}"`,
        );
    }
  }

  if (
    meta.elementOrder !== undefined &&
    meta.elementOrder !== 1 &&
    meta.elementOrder !== 2
  )
    throw new Error(
      `Invalid analysis file: "elementOrder" must be 1 or 2, got ${JSON.stringify(meta.elementOrder)}`,
    );
  // Legacy: a block in the v0.5.0 / v0.6.0 shape is migrated by parseHandCheck.
  if (meta.handCheck !== undefined)
    meta.handCheck = parseHandCheck(meta.handCheck);

  if (typeof meta.modelName !== "string")
    throw new Error('Invalid analysis file: "modelName" must be a string');
  // Legacy: the standalone "Mesh" mode was merged into "geometry".
  if (meta.mode === "mesh") meta.mode = "geometry";
  if (!APP_MODES.includes(meta.mode as AppMode))
    throw new Error(`Invalid analysis file: unknown mode "${meta.mode}"`);
  if (!VIEW_REPRS.includes(meta.viewRepr as (typeof VIEW_REPRS)[number]))
    throw new Error(
      `Invalid analysis file: unknown viewRepr "${meta.viewRepr}"`,
    );
  if (!RESULT_TYPES.includes(meta.resultType as ResultType))
    throw new Error(
      `Invalid analysis file: unknown resultType "${meta.resultType}"`,
    );
  for (const t of meta.elementTypes as unknown[])
    if (!ELEMENT_TYPES.includes(t as ElementType))
      throw new Error(`Invalid analysis file: unknown element type "${t}"`);

  return meta as unknown as KofemFieldDataV1;
}

export function parseAnalysisFile(text: string): AnalysisState {
  if (!/<VTKFile[^>]*type="UnstructuredGrid"/.test(text))
    throw new Error(
      "Not a KoFEM analysis file: expected a VTK XML UnstructuredGrid (.vtu) document",
    );

  const meta = parseMetadata(text);

  const piece = text.match(
    /<Piece[^>]*NumberOfPoints="(\d+)"[^>]*NumberOfCells="(\d+)"/,
  );
  if (!piece)
    throw new Error(
      "Invalid analysis file: missing <Piece> with NumberOfPoints / NumberOfCells",
    );
  const nPoints = Number(piece[1]);
  const nCells = Number(piece[2]);

  const coords = parseNumbers(dataArrayContent(text, "Points"), "Points");
  expectLength(coords.length, 3 * nPoints, "Points");
  const nodeIds = parseNumbers(dataArrayContent(text, "NodeId"), "NodeId");
  expectLength(nodeIds.length, nPoints, "NodeId");

  const nodes: Node[] = [];
  for (let i = 0; i < nPoints; i++)
    nodes.push({
      id: nodeIds[i],
      x: coords[3 * i],
      y: coords[3 * i + 1],
      z: coords[3 * i + 2],
    });

  const connectivity = parseNumbers(
    dataArrayContent(text, "connectivity"),
    "connectivity",
  );
  const offsets = parseNumbers(dataArrayContent(text, "offsets"), "offsets");
  expectLength(offsets.length, nCells, "offsets");
  const elementIds = parseNumbers(
    dataArrayContent(text, "ElementId"),
    "ElementId",
  );
  expectLength(elementIds.length, nCells, "ElementId");
  const propertyIds = parseNumbers(
    dataArrayContent(text, "PropertyId"),
    "PropertyId",
  );
  expectLength(propertyIds.length, nCells, "PropertyId");
  expectLength(meta.elementTypes.length, nCells, "elementTypes");

  const elements: Element[] = [];
  let start = 0;
  for (let c = 0; c < nCells; c++) {
    const end = offsets[c];
    if (end < start || end > connectivity.length)
      throw new Error(
        `Invalid analysis file: cell ${c} has offset ${end} outside the connectivity array (length ${connectivity.length})`,
      );
    const elNodeIds: number[] = [];
    for (let i = start; i < end; i++) {
      const idx = connectivity[i];
      if (idx < 0 || idx >= nPoints)
        throw new Error(
          `Invalid analysis file: cell ${c} references point index ${idx}, but the file has ${nPoints} points`,
        );
      elNodeIds.push(nodeIds[idx]);
    }
    elements.push({
      id: elementIds[c],
      type: meta.elementTypes[c],
      nodeIds: elNodeIds,
      propertyId: propertyIds[c],
    });
    start = end;
  }

  let result: AnalysisState["result"] = null;
  if (/<DataArray[^>]*Name="Displacement"/.test(text)) {
    const disp = parseNumbers(
      dataArrayContent(text, "Displacement"),
      "Displacement",
    );
    expectLength(disp.length, 3 * nPoints, "Displacement");
    result = { displacements: new Float64Array(disp) };
    if (/<DataArray[^>]*Name="VonMises"/.test(text)) {
      const vm = parseNumbers(dataArrayContent(text, "VonMises"), "VonMises");
      expectLength(vm.length, nCells, "VonMises");
      result.vonMises = new Float64Array(vm);
    }
    const corners = elements.reduce((n, el) => n + cornerCount(el), 0);
    const tensors = (name: string): Float64Array => {
      const values = parseNumbers(dataArrayContent(text, name), name);
      expectLength(values.length, 6 * corners, name);
      return new Float64Array(values);
    };
    const has = (name: string) =>
      new RegExp(`<DataArray[^>]*Name="${name}"`).test(text);
    if (has("Stress")) result.stress = uniformStress(tensors("Stress"));
    else if (has("StressTop") || has("StressMiddle") || has("StressBottom"))
      result.stress = {
        top: tensors("StressTop"),
        middle: tensors("StressMiddle"),
        bottom: tensors("StressBottom"),
      };
    if (meta.contactResult !== undefined)
      result.contact = restoredContactResult(
        meta.contactResult,
        new Set(nodes.map((node) => node.id)),
      );
  }

  // A file written before ties existed carries none. The counter is then not
  // guessed but derived from the ties actually present, so an id can never be
  // reused whatever the file contained.
  // A tie saved before the constraint method existed was a node-merge.
  const tieGroups = (meta.tieGroups ?? []).map((tie) => ({
    ...tie,
    method: tieMethod(tie),
  }));
  const nextTieGroupId =
    meta.nextTieGroupId ??
    tieGroups.reduce((highest, tie) => Math.max(highest, tie.id), 0) + 1;
  const contactGroups = meta.contactGroups ?? [];
  const nextContactGroupId =
    meta.nextContactGroupId ??
    contactGroups.reduce((highest, c) => Math.max(highest, c.id), 0) + 1;
  const couplingGroups = meta.couplingGroups ?? [];
  const nextCouplingGroupId =
    meta.nextCouplingGroupId ??
    couplingGroups.reduce((highest, c) => Math.max(highest, c.id), 0) + 1;

  return {
    modelName: meta.modelName,
    mode: meta.mode,
    viewRepr: savedViewRepr(meta.viewRepr),
    nodes,
    elements,
    materials: meta.materials,
    properties: meta.properties,
    bcGroups: meta.bcGroups,
    loadGroups: meta.loadGroups,
    tieGroups,
    contactGroups,
    couplingGroups,
    // A file written before temperature changes existed (KOF-449) has none.
    temperature: meta.temperature ?? null,
    nextBcGroupId: meta.nextBcGroupId,
    nextLoadGroupId: meta.nextLoadGroupId,
    nextTieGroupId,
    nextContactGroupId,
    nextCouplingGroupId,
    nextFaceEntryId: meta.nextFaceEntryId,
    nextMatId: meta.nextMatId,
    stepSurface: meta.stepSurface,
    interfaces: restoreInterfaces(meta.stepSurface, meta.interfaces),
    volMesh: meta.volMesh,
    surfaceTriangles: meta.surfaceTriangles,
    surfaceFaceIds: meta.surfaceFaceIds,
    result,
    resultType: meta.resultType,
    topOpt: meta.topOpt,
    // eslint-disable-next-line kofem/no-silent-fallback -- files written before the order was saved carry none; linear is the app's documented default order
    elementOrder: meta.elementOrder ?? 1,
    largeDeformation: meta.largeDeformation !== undefined,
    loadIncrements:
      // eslint-disable-next-line kofem/no-silent-fallback -- a file without large deformation was solved with it off; the count matters only once the user turns it on, and starts at the app's default as in a new analysis
      meta.largeDeformation?.increments ?? DEFAULT_LOAD_INCREMENTS,
    // Only gallery examples carry a hand check.
    handCheck: meta.handCheck ?? null,
    faceSizes: meta.faceSizes ?? [],
    meshSizes: meta.meshSizes ?? null,
  };
}
