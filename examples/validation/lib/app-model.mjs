// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// An example as the app holds it, and the things made from it. Two kinds:
//
// A recipe build (lib/pipeline.mjs buildFromRecipe — every example once
// KOF-322 is done): a STEP file meshed by Netgen, supports and loads on whole
// CAD faces, solved by the app's own code.
//
//   buildAnalysisFile()   the .vtu that /app/?example=<id> opens: geometry,
//                         mesh, groups and the static study, UNSOLVED, with
//                         the hand check the Results panel reads;
//   buildResultSurface()  the solved boundary surface, for the page's figure;
//   buildMeshStats()      elements, nodes and DOFs of the solved mesh.
//
// KOF-322: legacy hex path, removed when all cases are recipes — a structured
// hex model built by hand (lib/mesh.mjs) with node-set BCs:
//
//   solveModel()    the solve, with the loads built as the app builds them
//                   (web/src/store/boundarySlice.ts);
//   analysisFile()  the .vtu that /app/?example=<id> opens (the format of
//                   web/src/lib/analysisFile.ts);
//   resultSurface() the solved boundary surface, for the page's figure.
//
// A legacy model, in the app's units (N · mm · MPa · tonne):
//
//   { title,                                  the model name in the app
//     mesh: { vertices, hexahedra },          8-node hexahedra
//     material: { name, young_modulus, poisson_ratio, density },
//     order,                                  1 linear, 2 quadratic
//     support: { nodes, label },              Ux Uy Uz fixed
//     load: { kind, axis, value, nodes, label },
//     resultType }                            the field the app shows
//
// `load.kind` is "force" (value in N along `axis`), "moment" (N·mm about
// `axis`) or "pressure" (MPa, along the inward normal; no axis). Node lists are
// 0-based vertex indices.

// Steel as the app seeds it (web/src/store/modelStore.ts).
export const STEEL = {
  name: "Steel",
  young_modulus: 210000,
  poisson_ratio: 0.3,
  density: 7.85e-9,
};

const HEX_FACES = [
  [0, 1, 2, 3],
  [4, 5, 6, 7],
  [0, 1, 5, 4],
  [2, 3, 7, 6],
  [0, 3, 7, 4],
  [1, 2, 6, 5],
];

// Every hex face whose four nodes all belong to `nodes`, once each: the app's
// loadedFaces(). The engine matches them to its boundary elements by vertex
// set, so the winding does not matter.
export function facesOn(hexahedra, nodes) {
  const inSet = new Set(nodes);
  const seen = new Set();
  const faces = [];
  for (const hex of hexahedra)
    for (const local of HEX_FACES) {
      const face = local.map((i) => hex[i]);
      if (!face.every((v) => inSet.has(v))) continue;
      const key = [...face].sort((a, b) => a - b).join(",");
      if (seen.has(key)) continue;
      seen.add(key);
      faces.push(face);
    }
  if (!faces.length)
    throw new Error("the loaded node set spans no element face");
  return faces;
}

// The app's momentToNodalForces(): tangential forces F = (M/S)·(axis × r)
// about the centroid of the loaded nodes, S = Σ|r⊥|². Zero net force, net
// moment M.
function momentForces(vertices, nodes, axis, moment) {
  const c = [0, 1, 2].map(
    (k) => nodes.reduce((s, v) => s + vertices[v][k], 0) / nodes.length,
  );
  const r = (v) => [0, 1, 2].map((k) => vertices[v][k] - c[k]);
  const perp = ([x, y, z]) =>
    axis === 0 ? y * y + z * z : axis === 1 ? x * x + z * z : x * x + y * y;
  const S = nodes.reduce((s, v) => s + perp(r(v)), 0);
  if (S === 0) throw new Error("every loaded node lies on the moment axis");
  const k = moment / S;
  return nodes.map((vertex) => {
    const [x, y, z] = r(vertex);
    const force =
      axis === 0
        ? [0, -k * z, k * y]
        : axis === 1
          ? [k * z, 0, -k * x]
          : [-k * y, k * x, 0];
    return { vertex, force };
  });
}

/** The engine's boundary conditions for a model, built as the app builds them. */
export function solverBcs(model) {
  const { vertices, hexahedra } = model.mesh;
  const { kind, axis, value, nodes } = model.load;
  const bcs = { fixed_vertices: model.support.nodes };
  if (kind === "force") {
    const force = [0, 0, 0];
    force[axis] = value;
    bcs.surface_loads = [
      { type: "force", force, faces: facesOn(hexahedra, nodes) },
    ];
  } else if (kind === "pressure") {
    bcs.surface_loads = [
      { type: "pressure", pressure: value, faces: facesOn(hexahedra, nodes) },
    ];
  } else if (kind === "moment") {
    bcs.point_loads = momentForces(vertices, nodes, axis, value);
  } else throw new Error(`unknown load kind "${kind}"`);
  return bcs;
}

export function solveModel(solve, model) {
  return solve(model.mesh, model.material, solverBcs(model), model.order);
}

// ── The analysis file ─────────────────────────────────────────────────────────

function fieldData(json) {
  const data = Buffer.from(json, "utf8");
  const bytes = Buffer.alloc(4 + data.length);
  bytes.writeUInt32LE(data.length, 0);
  data.copy(bytes, 4);
  return { b64: bytes.toString("base64"), byteLength: data.length };
}

const dataArray = (type, name, body, components) =>
  `<DataArray type="${type}" Name="${name}"${components === undefined ? "" : ` NumberOfComponents="${components}"`} format="ascii">\n${body}\n</DataArray>`;

const tuples = (values, stride) => {
  const lines = [];
  for (let i = 0; i < values.length; i += stride)
    lines.push(values.slice(i, i + stride).join(" "));
  return lines.join("\n");
};

/** The setup the app restores from the file: materials, support, load. */
export function analysisSetup(model) {
  const { hexahedra } = model.mesh;
  const { kind, axis, value } = model.load;
  const ids = (nodes) => nodes.map((v) => v + 1); // node ids are 1-based
  const group =
    kind === "pressure"
      ? { dof: 0, totalForce: value, kind }
      : { dof: kind === "moment" ? 3 + axis : axis, totalForce: value, kind };
  return {
    format: "kofem-analysis",
    version: 1,
    modelName: model.title,
    mode: "results",
    viewRepr: "surface",
    resultType: model.resultType,
    elementTypes: hexahedra.map(() => "CHEXA"),
    materials: [
      {
        id: 1,
        name: model.material.name,
        young: model.material.young_modulus,
        poisson: model.material.poisson_ratio,
        density: model.material.density,
      },
    ],
    properties: [{ id: 1, type: "PSOLID", materialId: 1 }],
    bcGroups: [
      {
        id: 1,
        name: "BC1",
        dofs: [0, 1, 2],
        value: 0,
        faces: [
          {
            id: 1,
            label: model.support.label,
            nodeIds: ids(model.support.nodes),
          },
        ],
      },
    ],
    loadGroups: [
      {
        id: 1,
        name: "Load1",
        ...group,
        faces: [
          { id: 2, label: model.load.label, nodeIds: ids(model.load.nodes) },
        ],
      },
    ],
    nextBcGroupId: 2,
    nextLoadGroupId: 2,
    nextFaceEntryId: 3,
    nextMatId: 2,
    stepSurface: null,
    volMesh: null,
    surfaceTriangles: null,
    surfaceFaceIds: null,
    elementOrder: model.order,
  };
}

/** The .vtu the app opens: the model, solved. */
export function analysisFile(model, result) {
  const { vertices, hexahedra } = model.mesh;
  const encoded = fieldData(JSON.stringify(analysisSetup(model)));
  return [
    `<?xml version="1.0"?>`,
    `<VTKFile type="UnstructuredGrid" version="1.0" byte_order="LittleEndian" header_type="UInt32">`,
    `<UnstructuredGrid>`,
    `<FieldData>`,
    `<DataArray type="UInt8" Name="KoFEM" NumberOfTuples="${encoded.byteLength}" format="binary">`,
    encoded.b64,
    `</DataArray>`,
    `</FieldData>`,
    `<Piece NumberOfPoints="${vertices.length}" NumberOfCells="${hexahedra.length}">`,
    `<Points>`,
    dataArray(
      "Float64",
      "Points",
      vertices.map((v) => v.join(" ")).join("\n"),
      3,
    ),
    `</Points>`,
    `<Cells>`,
    dataArray(
      "Int64",
      "connectivity",
      hexahedra.map((h) => h.join(" ")).join("\n"),
    ),
    dataArray(
      "Int64",
      "offsets",
      hexahedra.map((_, i) => 8 * (i + 1)).join(" "),
    ),
    dataArray("UInt8", "types", hexahedra.map(() => 12).join(" ")), // VTK_HEXAHEDRON
    `</Cells>`,
    `<PointData>`,
    dataArray("Int64", "NodeId", vertices.map((_, i) => i + 1).join(" ")),
    dataArray("Float64", "Displacement", tuples(result.displacements, 3), 3),
    `</PointData>`,
    `<CellData>`,
    dataArray("Int64", "ElementId", hexahedra.map((_, i) => i + 1).join(" ")),
    dataArray("Int64", "PropertyId", hexahedra.map(() => 1).join(" ")),
    dataArray("Float64", "VonMises", tuples(result.von_mises, 1)),
    `</CellData>`,
    `</Piece>`,
    `</UnstructuredGrid>`,
    `</VTKFile>`,
    ``,
  ].join("\n");
}

/** The setup block embedded in an analysis file, for checking it against a model. */
export function readAnalysisSetup(vtu) {
  const m = /<DataArray type="UInt8" Name="KoFEM"[^>]*>\n([^<\n]+)\n/.exec(vtu);
  if (!m) throw new Error("not a KoFEM analysis file: no KoFEM field data");
  const bytes = Buffer.from(m[1], "base64");
  return JSON.parse(
    bytes.subarray(4, 4 + bytes.readUInt32LE(0)).toString("utf8"),
  );
}

// ── What the app shows ────────────────────────────────────────────────────────

const COMPONENT = { Ux: 0, Uy: 1, Uz: 2 };

/**
 * A displacement read-out of the app's Result summary ("Max Ux", "Min Uy",
 * "Max |U|"), printed as the app prints it: toExponential(3) and the unit.
 */
export function appReadout(result, field, stat) {
  const d = result.displacements;
  const n = d.length / 3;
  const value = (i) =>
    field === "|U|"
      ? Math.hypot(d[3 * i], d[3 * i + 1], d[3 * i + 2])
      : d[3 * i + COMPONENT[field]];
  if (field !== "|U|" && COMPONENT[field] === undefined)
    throw new Error(`no app read-out for field "${field}"`);
  if (stat !== "Min" && stat !== "Max")
    throw new Error(`stat must be "Min" or "Max", got "${stat}"`);
  let out = stat === "Min" ? Infinity : -Infinity;
  for (let i = 0; i < n; i++)
    out = stat === "Min" ? Math.min(out, value(i)) : Math.max(out, value(i));
  return `${out.toExponential(3)} mm`;
}

// ── The solved surface, for the figure ────────────────────────────────────────

/**
 * The boundary of a solved hex model as triangles, for lib/render.mjs:
 * undeformed positions, displacements and one scalar per vertex — the
 * displacement magnitude, or the element von Mises stress averaged to the
 * nodes as the app averages it.
 */
export function resultSurface(model, result, field = "displacement") {
  const { vertices, hexahedra } = model.mesh;
  const faces = new Map();
  hexahedra.forEach((hex, e) => {
    for (const local of HEX_FACES) {
      const face = local.map((i) => hex[i]);
      const key = [...face].sort((a, b) => a - b).join(",");
      const entry = faces.get(key);
      if (entry) entry.count++;
      else faces.set(key, { face, count: 1, e });
    }
  });
  let nodal;
  if (field === "displacement") {
    const d = result.displacements;
    nodal = vertices.map((_, i) =>
      Math.hypot(d[3 * i], d[3 * i + 1], d[3 * i + 2]),
    );
  } else if (field === "vonMises") {
    const sum = new Float64Array(vertices.length);
    const count = new Uint32Array(vertices.length);
    hexahedra.forEach((hex, e) => {
      for (const v of hex) {
        sum[v] += result.von_mises[e];
        count[v]++;
      }
    });
    nodal = Array.from(sum, (s, i) => s / count[i]);
  } else throw new Error(`unknown surface field "${field}"`);

  const index = new Map();
  const positions = [];
  const displacements = [];
  const scalars = [];
  const at = (v) => {
    let i = index.get(v);
    if (i === undefined) {
      i = index.size;
      index.set(v, i);
      positions.push(...vertices[v]);
      displacements.push(
        result.displacements[3 * v],
        result.displacements[3 * v + 1],
        result.displacements[3 * v + 2],
      );
      scalars.push(nodal[v]);
    }
    return i;
  };
  // Each boundary quad as two triangles; the edge mask leaves out the
  // diagonal a–c (bit i: the edge opposite the triangle's i-th vertex).
  const triangles = [];
  const edgeMask = [];
  for (const { face, count } of faces.values()) {
    if (count !== 1) continue;
    const [a, b, c, d] = face.map(at);
    triangles.push(a, b, c, a, c, d);
    edgeMask.push(0b101, 0b011);
  }
  return { positions, displacements, scalars, triangles, edgeMask };
}

// ── Recipe builds (lib/pipeline.mjs) ──────────────────────────────────────────

/**
 * The setup block of a recipe build's analysis file: what the app holds after
 * the recipe's steps (import, splits, mesh, material, supports, loads), opening
 * UNSOLVED on the static study, so the first thing to do is press Run. The
 * fields follow web/src/lib/analysisFile.ts.
 */
export function buildAnalysisSetup(build, title) {
  return {
    format: "kofem-analysis",
    version: 1,
    modelName: title,
    mode: "solve",
    viewRepr: "surface",
    resultType: "Displacement (magnitude)",
    elementTypes: build.elements.map((e) => e.type),
    materials: build.materials,
    properties: build.properties,
    bcGroups: build.bcGroups,
    loadGroups: build.loadGroups,
    tieGroups: [],
    couplingGroups: [],
    nextBcGroupId: build.bcGroups.length + 1,
    nextLoadGroupId: build.loadGroups.length + 1,
    nextTieGroupId: 1,
    nextCouplingGroupId: 1,
    nextFaceEntryId: build.nextFaceEntryId,
    nextMatId: build.materials.length + 1,
    stepSurface: build.stepSurface,
    volMesh: null,
    surfaceTriangles: build.surfaceTriangles,
    surfaceFaceIds: build.surfaceFaceIds,
    elementOrder: build.meshSettings.order,
    ...(build.optimization
      ? optimizeSetup(build.optimization.settings)
      : { handCheck: build.handCheck }),
  };
}

// A recipe with an optimize step opens on its optimization study instead,
// with the Optimize panel filled in as a user types it (strings, as the
// store holds them), ready to run; it carries no hand check.
function optimizeSetup(settings) {
  return {
    mode: "optimize",
    topOpt: {
      method: settings.method,
      objective: settings.objective,
      volumeFraction: String(settings.constraints.volumeFraction),
      complianceLimit: "",
      penalty: String(settings.penalty),
      filterRadius: String(settings.filterRadius),
      moveLimit: String(settings.moveLimit),
      maxIterations: String(settings.maxIterations),
      tolerance: String(settings.tolerance),
    },
  };
}

// The element types a recipe build makes: Netgen's tetrahedra, and the shell
// facets the app idealises a Shell body into (web/src/lib/analysisFile.ts
// vtkCellType).
const VTK_CELL = {
  CTETRA: { nodes: 4, type: 10 }, // VTK_TETRA
  CTRIA3: { nodes: 3, type: 5 }, // VTK_TRIANGLE
};

/** The .vtu of a recipe build, unsolved: no result arrays. */
export function buildAnalysisFile(build, title) {
  const { nodes, elements } = build;
  for (const e of elements)
    if (VTK_CELL[e.type]?.nodes !== e.nodeIds.length)
      throw new Error(
        `analysis file: element ${e.id} is a ${e.nodeIds.length}-node ${e.type}, not a 4-node tetrahedron or a 3-node shell facet`,
      );
  let offset = 0;
  const offsets = elements.map((e) => (offset += e.nodeIds.length));
  const encoded = fieldData(JSON.stringify(buildAnalysisSetup(build, title)));
  return [
    `<?xml version="1.0"?>`,
    `<VTKFile type="UnstructuredGrid" version="1.0" byte_order="LittleEndian" header_type="UInt32">`,
    `<UnstructuredGrid>`,
    `<FieldData>`,
    `<DataArray type="UInt8" Name="KoFEM" NumberOfTuples="${encoded.byteLength}" format="binary">`,
    encoded.b64,
    `</DataArray>`,
    `</FieldData>`,
    `<Piece NumberOfPoints="${nodes.length}" NumberOfCells="${elements.length}">`,
    `<Points>`,
    dataArray(
      "Float64",
      "Points",
      nodes.map((n) => `${n.x} ${n.y} ${n.z}`).join("\n"),
      3,
    ),
    `</Points>`,
    `<Cells>`,
    // Node ids equal point indices, as after meshing in the app.
    dataArray(
      "Int64",
      "connectivity",
      elements.map((e) => e.nodeIds.join(" ")).join("\n"),
    ),
    dataArray("Int64", "offsets", offsets.join(" ")),
    dataArray(
      "UInt8",
      "types",
      elements.map((e) => VTK_CELL[e.type].type).join(" "),
    ),
    `</Cells>`,
    `<PointData>`,
    dataArray("Int64", "NodeId", nodes.map((n) => n.id).join(" ")),
    `</PointData>`,
    `<CellData>`,
    dataArray("Int64", "ElementId", elements.map((e) => e.id).join(" ")),
    dataArray(
      "Int64",
      "PropertyId",
      elements.map((e) => e.propertyId).join(" "),
    ),
    `</CellData>`,
    `</Piece>`,
    `</UnstructuredGrid>`,
    `</VTKFile>`,
    ``,
  ].join("\n");
}

/**
 * The solved boundary of a recipe build for lib/render.mjs: the mesh's surface
 * triangles with the displacement magnitude, or the nodal von Mises stress the
 * caller averaged as the app does (pipeline nodalVonMises).
 */
export function buildResultSurface(build, field, nodalVonMises) {
  const d = build.result.displacements;
  let scalars;
  if (field === "displacement")
    scalars = build.nodes.map((_, i) =>
      Math.hypot(d[3 * i], d[3 * i + 1], d[3 * i + 2]),
    );
  else if (field === "vonMises") scalars = Array.from(nodalVonMises);
  else throw new Error(`unknown surface field "${field}"`);
  return {
    positions: build.nodes.flatMap((n) => [n.x, n.y, n.z]),
    displacements: Array.from(d),
    scalars,
    triangles: build.surfaceTriangles.flat(),
  };
}

/**
 * Elements, nodes and DOFs of a recipe build — a quadratic tetrahedron adds a
 * node on every edge, a shell node carries six DOFs — and the mesher settings,
 * so the page states them.
 */
export function buildMeshStats(build) {
  const { order, maxElementSize, minElementSize } = build.meshSettings;
  const types = new Set(build.elements.map((e) => e.type));
  if (types.size !== 1 || !(types.has("CTETRA") || types.has("CTRIA3")))
    throw new Error(
      `mesh stats: a recipe build is all tetrahedra or all shell facets, got ${[...types].join(", ")}`,
    );
  if (types.has("CTRIA3")) {
    // A DKT/CST facet is linear whatever order the mesh panel shows.
    const shellNodes = build.nodes.length;
    return {
      order: 1,
      elementType: "CTRIA3",
      elements: build.elements.length,
      vertices: shellNodes,
      nodes: shellNodes,
      dofs: 6 * shellNodes,
      maxElementSize,
      minElementSize,
    };
  }
  let nodes = build.nodes.length;
  if (order === 2) {
    const edges = new Set();
    for (const { nodeIds: t } of build.elements)
      for (let i = 0; i < 4; i++)
        for (let j = i + 1; j < 4; j++)
          edges.add(t[i] < t[j] ? `${t[i]},${t[j]}` : `${t[j]},${t[i]}`);
    nodes += edges.size;
  }
  return {
    order,
    elementType: "CTETRA",
    elements: build.elements.length,
    vertices: build.nodes.length,
    nodes,
    dofs: 3 * nodes,
    maxElementSize,
    minElementSize,
  };
}
