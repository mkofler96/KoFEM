// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

import type {
  AppMode,
  Element,
  ElementType,
  Material,
  NamedBcGroup,
  NamedLoadGroup,
  Node,
  Property,
  ResultType,
  StepSurfaceMesh,
  VolMesh,
} from "../store/modelStore";
import { RESULT_TYPES } from "../store/modelStore";

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
  viewRepr: "geometry" | "surface" | "volume" | "wireframe";
  nodes: Node[];
  elements: Element[];
  materials: Material[];
  properties: Property[];
  bcGroups: NamedBcGroup[];
  loadGroups: NamedLoadGroup[];
  nextBcGroupId: number;
  nextLoadGroupId: number;
  nextFaceEntryId: number;
  nextMatId: number;
  stepSurface: StepSurfaceMesh | null;
  volMesh: VolMesh | null;
  surfaceTriangles: [number, number, number][] | null;
  surfaceFaceIds: number[] | null;
  result: { displacements: Float64Array; vonMises?: Float64Array } | null;
  resultType: ResultType;
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
  viewRepr: "geometry" | "surface" | "volume" | "wireframe";
  resultType: ResultType;
  elementTypes: ElementType[];
  materials: Material[];
  properties: Property[];
  bcGroups: NamedBcGroup[];
  loadGroups: NamedLoadGroup[];
  nextBcGroupId: number;
  nextLoadGroupId: number;
  nextFaceEntryId: number;
  nextMatId: number;
  stepSurface: StepSurfaceMesh | null;
  volMesh: VolMesh | null;
  surfaceTriangles: [number, number, number][] | null;
  surfaceFaceIds: number[] | null;
}

// ── VTK cell types (vtkCellType.h) ────────────────────────────────────────────

function vtkCellType(type: ElementType, nNodes: number): number {
  switch (type) {
    case "CTETRA":
      return nNodes === 10 ? 24 : 10; // VTK_(QUADRATIC_)TETRA
    case "CHEXA":
      return nNodes === 20 ? 25 : 12; // VTK_(QUADRATIC_)HEXAHEDRON
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
    nextBcGroupId: state.nextBcGroupId,
    nextLoadGroupId: state.nextLoadGroupId,
    nextFaceEntryId: state.nextFaceEntryId,
    nextMatId: state.nextMatId,
    stepSurface: state.stepSurface,
    volMesh: state.volMesh,
    surfaceTriangles: state.surfaceTriangles,
    surfaceFaceIds: state.surfaceFaceIds,
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
  const base = (modelName || "analysis").replace(/[^\w-]+/g, "_");
  return `${base}.vtu`;
}

// ── Parsing ───────────────────────────────────────────────────────────────────

const APP_MODES: AppMode[] = ["geometry", "constraints", "solve", "results"];
const VIEW_REPRS = ["geometry", "surface", "volume", "wireframe"] as const;
const ELEMENT_TYPES: ElementType[] = ["CTETRA", "CHEXA"];

function dataArrayContent(xml: string, name: string): string {
  const m = xml.match(
    new RegExp(`<DataArray[^>]*Name="${name}"[^>]*>([\\s\\S]*?)</DataArray>`),
  );
  if (!m) throw new Error(`Invalid analysis file: missing DataArray "${name}"`);
  return m[1].trim();
}

function parseNumbers(text: string, context: string): number[] {
  if (!text) return [];
  return text.split(/\s+/).map((token) => {
    const v = Number(token);
    if (Number.isNaN(v) && token !== "NaN")
      throw new Error(
        `Invalid analysis file: non-numeric value "${token}" in "${context}"`,
      );
    return v;
  });
}

function expectLength(actual: number, expected: number, context: string): void {
  if (actual !== expected)
    throw new Error(
      `Invalid analysis file: "${context}" has ${actual} values, expected ${expected}`,
    );
}

function parseMetadata(xml: string): KofemFieldDataV1 {
  const m = xml.match(
    /<DataArray[^>]*Name="KoFEM"[^>]*>([\s\S]*?)<\/DataArray>/,
  );
  if (!m)
    throw new Error(
      'Not a KoFEM analysis file: missing the "KoFEM" FieldData entry — only .vtu files saved by KoFEM can be loaded',
    );
  let raw: unknown;
  try {
    raw = JSON.parse(decodeVtkBinary(m[1].trim()));
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
  }

  return {
    modelName: meta.modelName,
    mode: meta.mode,
    viewRepr: meta.viewRepr,
    nodes,
    elements,
    materials: meta.materials,
    properties: meta.properties,
    bcGroups: meta.bcGroups,
    loadGroups: meta.loadGroups,
    nextBcGroupId: meta.nextBcGroupId,
    nextLoadGroupId: meta.nextLoadGroupId,
    nextFaceEntryId: meta.nextFaceEntryId,
    nextMatId: meta.nextMatId,
    stepSurface: meta.stepSurface,
    volMesh: meta.volMesh,
    surfaceTriangles: meta.surfaceTriangles,
    surfaceFaceIds: meta.surfaceFaceIds,
    result,
    resultType: meta.resultType,
  };
}
