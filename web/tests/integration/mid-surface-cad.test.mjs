// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// The shell mid-surface built from the CAD geometry (KOF-498, stage 1 of
// KOF-343). A body marked Shell whose faces form opposite pairs (parallel
// planes or coaxial cylinders, constant thickness) gets its mid-surface from
// the B-rep: the engine pairs the faces, offsets each top face by half the
// thickness and meshes only that surface. The top side is fixed by the
// geometry, so it is the same on every mesh (KOF-451). A body it cannot pair
// keeps the mesh-based path, and the route names the face and the reason.
//
// Engine contract, as the worker calls it:
//   plan_shell_bodies(opts) → [{ body, path: "cad", walls: [{ kind,
//     thickness, top, bottom, sides }] } | { body, path: "mesh", face, reason }]
//   generate_fem_mesh(opts) with opts.shell_bodies → the usual DTO plus
//     shellRoutes (as above) and, when a body takes the CAD path,
//     midSurface { vertices, triangles, midFace, faces: [{ body, top, bottom,
//     thickness }], rimEdges: [a, b, sideFace, ...] }
// Both take opts.thin_wall { max_wall, body_share }: the thickest wall that is
// thin is max(max_wall, body_share × the body's bounding-box diagonal), the
// rule of crates/kofem-shellize (ExtractOptions::max_wall,
// SHELL_BODY_WALL_SHARE).

import { beforeAll, describe, expect, test } from "bun:test";
import {
  annulusStep,
  prismStep,
} from "../../../examples/gallery/step-prism.mjs";
import { loadEngine } from "../support/wasm.mjs";
import { TESSELLATION_OPTIONS } from "../support/step-parts.mjs";
import {
  allFaces,
  distanceFromLine,
  faceWhere,
} from "../support/cad-faces.mjs";

const THIN_WALL = { max_wall: 15, body_share: 0.1 };

function meshOptions(maxElementSize, shellBodies) {
  return JSON.stringify({
    max_element_size: maxElementSize,
    min_element_size: 0,
    shell_bodies: shellBodies,
    thin_wall: THIN_WALL,
    grading: 0.3,
    second_order: false,
    elementsperedge: 2,
    elementspercurve: 2,
    optsteps_2d: 3,
    optsteps_3d: 3,
  });
}

const planOptions = (shellBodies) =>
  JSON.stringify({ shell_bodies: shellBodies, thin_wall: THIN_WALL });

async function engineWith(step) {
  const log = [];
  const engine = await loadEngine({
    print: (line) => log.push(line),
    printErr: (line) => log.push(line),
  });
  const tessellation = engine.tessellate_step(
    new TextEncoder().encode(step),
    TESSELLATION_OPTIONS,
  );
  return { engine, tessellation, log };
}

function meshOf(engine, maxElementSize, shellBodies = [1]) {
  const dto = engine.generate_fem_mesh(
    meshOptions(maxElementSize, shellBodies),
  );
  if ("overlaps" in dto)
    throw new Error(`did not mesh: ${JSON.stringify(dto.overlaps)}`);
  return dto;
}

const point = (vertices, i) => [
  vertices[3 * i],
  vertices[3 * i + 1],
  vertices[3 * i + 2],
];

// The unit normal of each mid-surface triangle, from its winding.
function triangleNormals({ vertices, triangles }) {
  const normals = [];
  for (let t = 0; t < triangles.length / 3; t++) {
    const [a, b, c] = [0, 1, 2].map((k) =>
      point(vertices, triangles[3 * t + k]),
    );
    const ab = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const ac = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    const n = [
      ab[1] * ac[2] - ab[2] * ac[1],
      ab[2] * ac[0] - ab[0] * ac[2],
      ab[0] * ac[1] - ab[1] * ac[0],
    ];
    const length = Math.hypot(...n);
    normals.push(n.map((x) => x / length));
  }
  return normals;
}

function triangleCentroid({ vertices, triangles }, t) {
  const corners = [0, 1, 2].map((k) => point(vertices, triangles[3 * t + k]));
  return [0, 1, 2].map(
    (axis) => (corners[0][axis] + corners[1][axis] + corners[2][axis]) / 3,
  );
}

const rimEdgesOf = ({ rimEdges }) =>
  Array.from({ length: rimEdges.length / 3 }, (_, e) => ({
    a: rimEdges[3 * e],
    b: rimEdges[3 * e + 1],
    sideFace: rimEdges[3 * e + 2],
  }));

// ── NAFEMS LE6: the skew plate of examples/validation ────────────────────────

const LE6_SIDE = 1000; // mm
const LE6_THICKNESS = 10; // mm
const cos30 = Math.cos(Math.PI / 6);
const sin30 = Math.sin(Math.PI / 6);
const LE6_RHOMBUS = [
  [0, 0],
  [LE6_SIDE, 0],
  [LE6_SIDE * (1 + cos30), LE6_SIDE * sin30],
  [LE6_SIDE * cos30, LE6_SIDE * sin30],
];
const LE6_STEP = prismStep(LE6_RHOMBUS, LE6_THICKNESS, "NAFEMS LE6 skew plate");
// The sizes of the LE6 mesh study (KOF-451): at 100 and 50 mm the mesh-based
// path kept the lower face, at the others the upper one.
const LE6_SIZES = [100, 50, 25, 12.5, 8];

describe("a flat plate takes the CAD path (NAFEMS LE6)", () => {
  let tessellation = null;
  let top = 0;
  let bottom = 0;
  let sides = [];
  let plan = null;
  const meshes = new Map();
  let volumeFillLogged = false;

  beforeAll(async () => {
    const loaded = await engineWith(LE6_STEP);
    ({ tessellation } = loaded);
    top = faceWhere(
      tessellation,
      (_x, _y, z) => Math.abs(z - LE6_THICKNESS) < 1e-6,
    );
    bottom = faceWhere(tessellation, (_x, _y, z) => Math.abs(z) < 1e-6);
    sides = allFaces(tessellation).filter((f) => f !== top && f !== bottom);
    plan = loaded.engine.plan_shell_bodies(planOptions([1]));
    for (const size of LE6_SIZES) {
      loaded.log.length = 0;
      meshes.set(size, meshOf(loaded.engine, size));
      volumeFillLogged ||= loaded.log.some((line) => line.includes("step 4/4"));
    }
  });

  test("the plan pairs the upper and lower faces into one planar wall", () => {
    expect(plan).toEqual([
      {
        body: 1,
        path: "cad",
        walls: [
          {
            kind: "planar",
            thickness: LE6_THICKNESS,
            top: [top],
            bottom: [bottom],
            sides,
          },
        ],
      },
    ]);
  });

  test("meshing runs no volume mesh", () => {
    for (const [size, dto] of meshes) {
      expect({ size, tets: dto.tetrahedra.length }).toEqual({ size, tets: 0 });
      expect(dto.shellRoutes).toEqual(plan);
    }
    expect(volumeFillLogged).toBe(false);
  });

  test("the mid-surface lies halfway through the plate on every mesh", () => {
    for (const [size, { midSurface }] of meshes) {
      let worst = 0;
      for (let i = 0; i < midSurface.vertices.length / 3; i++)
        worst = Math.max(
          worst,
          Math.abs(midSurface.vertices[3 * i + 2] - LE6_THICKNESS / 2),
        );
      expect({ size, within: worst < 1e-9 }).toEqual({ size, within: true });
    }
  });

  test("the top side is the upper face on every mesh (KOF-451)", () => {
    for (const [size, { midSurface }] of meshes) {
      expect(midSurface.faces.map((f) => ({ size, ...f }))).toEqual([
        { size, body: 1, top, bottom, thickness: LE6_THICKNESS },
      ]);
      const downward = triangleNormals(midSurface).filter(
        (n) => n[2] < 1 - 1e-6,
      ).length;
      expect({ size, downward }).toEqual({ size, downward: 0 });
      expect(Array.from(midSurface.midFace).every((k) => k === 0)).toBe(true);
    }
  });

  test("each rim edge lies on the side face it came from", () => {
    const { midSurface } = meshes.get(25);
    const rim = rimEdgesOf(midSurface);
    expect(
      [...new Set(rim.map((e) => e.sideFace))].sort((a, b) => a - b),
    ).toEqual(sides);
    // Side face i joins rhombus corners i and i + 1: a rim node on it lies on
    // the line through them.
    const lineOfSide = new Map(
      LE6_RHOMBUS.map((start, i) => {
        const end = LE6_RHOMBUS[(i + 1) % 4];
        const face = faceWhere(
          tessellation,
          (x, y) => distanceFromLine(start, end, x, y) < 1e-6,
        );
        return [face, [start, end]];
      }),
    );
    for (const edge of rim)
      for (const node of [edge.a, edge.b]) {
        const [x, y] = point(midSurface.vertices, node);
        const [start, end] = lineOfSide.get(edge.sideFace);
        expect(distanceFromLine(start, end, x, y)).toBeLessThan(1e-6);
      }
  });
});

// ── A tube: coaxial cylinders ────────────────────────────────────────────────

const TUBE_INNER = 45; // mm
const TUBE_OUTER = 50; // mm
const TUBE_LENGTH = 300; // mm
const TUBE_MEAN = (TUBE_INNER + TUBE_OUTER) / 2;

describe("a tube gets a cylindrical mid-surface at the mean radius", () => {
  let outer = 0;
  let bore = 0;
  let ends = [];
  let dto = null;

  beforeAll(async () => {
    const { engine, tessellation } = await engineWith(
      annulusStep(TUBE_INNER, TUBE_OUTER, TUBE_LENGTH, "Tube"),
    );
    const onRadius = (r) => (x, y) => Math.abs(Math.hypot(x, y) - r) < 1e-3;
    outer = faceWhere(tessellation, onRadius(TUBE_OUTER));
    bore = faceWhere(tessellation, onRadius(TUBE_INNER));
    ends = allFaces(tessellation).filter((f) => f !== outer && f !== bore);
    dto = meshOf(engine, 10);
  });

  test("the route is the CAD path with one cylindrical wall", () => {
    expect(dto.shellRoutes).toEqual([
      {
        body: 1,
        path: "cad",
        walls: [
          {
            kind: "cylindrical",
            thickness: TUBE_OUTER - TUBE_INNER,
            top: [outer],
            bottom: [bore],
            sides: ends,
          },
        ],
      },
    ]);
    expect(dto.tetrahedra.length).toBe(0);
  });

  test("every mid-surface node lies at the mean radius", () => {
    const { vertices } = dto.midSurface;
    let worst = 0;
    for (let i = 0; i < vertices.length / 3; i++)
      worst = Math.max(
        worst,
        Math.abs(Math.hypot(vertices[3 * i], vertices[3 * i + 1]) - TUBE_MEAN),
      );
    expect(worst).toBeLessThan(1e-6 * TUBE_MEAN);
  });

  test("the outer face is the top side", () => {
    const { midSurface } = dto;
    expect(midSurface.faces).toEqual([
      { body: 1, top: outer, bottom: bore, thickness: TUBE_OUTER - TUBE_INNER },
    ]);
    const normals = triangleNormals(midSurface);
    const inward = normals.filter((n, t) => {
      const [x, y] = triangleCentroid(midSurface, t);
      return n[0] * x + n[1] * y <= 0;
    }).length;
    expect(inward).toBe(0);
  });

  test("the rim edges come from the two end faces", () => {
    const rim = rimEdgesOf(dto.midSurface);
    expect(
      [...new Set(rim.map((e) => e.sideFace))].sort((a, b) => a - b),
    ).toEqual(ends);
  });
});

// ── Top and bottom split differently ─────────────────────────────────────────

const PLATE = [
  [0, 0],
  [200, 0],
  [200, 100],
  [0, 100],
];
const PLATE_THICKNESS = 5; // mm
const TOP_SPLIT = 80; // mm, x of the cut across the upper face
const BOTTOM_SPLIT = 120; // mm, x of the cut across the lower face

describe("a plate whose two faces are split at different places", () => {
  let faces = null;
  let dto = null;

  beforeAll(async () => {
    const { engine, tessellation: plain } = await engineWith(
      prismStep(PLATE, PLATE_THICKNESS, "Split plate"),
    );
    const split = (tessellation, faceId, x) =>
      engine.tessellate_step(
        engine.split_geometry(
          JSON.stringify({
            mode: "faces",
            origin: [x, 0, 0],
            normal: [1, 0, 0],
            faceIds: [faceId],
          }),
        ).bytes,
        TESSELLATION_OPTIONS,
      );
    const upper = (t) =>
      faceWhere(t, (_x, _y, z) => Math.abs(z - PLATE_THICKNESS) < 1e-6);
    const lower = (t) => faceWhere(t, (_x, _y, z) => Math.abs(z) < 1e-6);
    const once = split(plain, upper(plain), TOP_SPLIT);
    const twice = split(once, lower(once), BOTTOM_SPLIT);
    const onZ = (z) => (_x, _y, pz) => Math.abs(pz - z) < 1e-6;
    const within = (from, to, z) => (x, y, pz) =>
      onZ(z)(x, y, pz) && x >= from - 1e-6 && x <= to + 1e-6;
    faces = {
      topLeft: faceWhere(twice, within(0, TOP_SPLIT, PLATE_THICKNESS)),
      topRight: faceWhere(twice, within(TOP_SPLIT, 200, PLATE_THICKNESS)),
      bottomLeft: faceWhere(twice, within(0, BOTTOM_SPLIT, 0)),
      bottomRight: faceWhere(twice, within(BOTTOM_SPLIT, 200, 0)),
    };
    dto = meshOf(engine, 10);
  });

  test("the plan keeps it on the CAD path", () => {
    expect(dto.shellRoutes.map((r) => r.path)).toEqual(["cad"]);
    const [wall] = dto.shellRoutes[0].walls;
    expect(wall.top).toEqual(
      [faces.topLeft, faces.topRight].sort((a, b) => a - b),
    );
    expect(wall.bottom).toEqual(
      [faces.bottomLeft, faces.bottomRight].sort((a, b) => a - b),
    );
  });

  test("each mid face has exactly one top and one bottom source", () => {
    const pairs = dto.midSurface.faces
      .map((f) => `${f.top}/${f.bottom}`)
      .sort();
    expect(pairs).toEqual(
      [
        `${faces.topLeft}/${faces.bottomLeft}`,
        `${faces.topRight}/${faces.bottomLeft}`,
        `${faces.topRight}/${faces.bottomRight}`,
      ].sort(),
    );
  });

  test("each mid face covers the overlap of its two sources", () => {
    const span = (face) =>
      face === faces.topLeft || face === faces.bottomLeft
        ? [0, face === faces.topLeft ? TOP_SPLIT : BOTTOM_SPLIT]
        : [face === faces.topRight ? TOP_SPLIT : BOTTOM_SPLIT, 200];
    const { midSurface } = dto;
    for (let t = 0; t < midSurface.midFace.length; t++) {
      const { top, bottom } = midSurface.faces[midSurface.midFace[t]];
      const [topFrom, topTo] = span(top);
      const [bottomFrom, bottomTo] = span(bottom);
      const [x] = triangleCentroid(midSurface, t);
      expect(x).toBeGreaterThanOrEqual(Math.max(topFrom, bottomFrom));
      expect(x).toBeLessThanOrEqual(Math.min(topTo, bottomTo));
    }
  });
});

// ── Bodies stage 1 cannot pair keep the mesh-based path ──────────────────────

describe("a body stage 1 cannot pair keeps the mesh-based path", () => {
  const cases = [
    {
      label: "an L-bracket (two walls meeting at an L junction)",
      step: prismStep(
        [
          [0, 0],
          [100, 0],
          [100, 5],
          [5, 5],
          [5, 100],
          [0, 100],
        ],
        100,
        "L-bracket",
      ),
    },
    {
      label: "a stepped plate (5 mm, then 10 mm thick)",
      step: prismStep(
        [
          [0, 0],
          [200, 0],
          [200, 10],
          [100, 10],
          [100, 5],
          [0, 5],
        ],
        200,
        "Stepped plate",
      ),
    },
  ];

  for (const { label, step } of cases)
    test(label, async () => {
      const { engine, tessellation } = await engineWith(step);
      const [route] = engine.plan_shell_bodies(planOptions([1]));
      expect(route).toEqual({
        body: 1,
        path: "mesh",
        face: expect.any(Number),
        reason: expect.any(String),
      });
      expect(allFaces(tessellation)).toContain(route.face);
      expect(route.reason.length).toBeGreaterThan(0);

      const dto = meshOf(engine, 10);
      expect(dto.shellRoutes).toEqual([route]);
      expect(dto.midSurface).toBeUndefined();
      expect(dto.tetrahedra.length).toBeGreaterThan(0);
    });
});

// The message of what `call` throws: a C++ exception through the engine's
// getExceptionMessage, a JavaScript error as it is.
function refusalOf(engine, call) {
  try {
    call();
  } catch (error) {
    if (error instanceof Error) return error.message;
    return String(engine.getExceptionMessage(error));
  }
  return null;
}

describe("the shell options are required", () => {
  test("a plan without thin_wall is refused by name", async () => {
    const { engine } = await engineWith(LE6_STEP);
    const message = refusalOf(engine, () =>
      engine.plan_shell_bodies(JSON.stringify({ shell_bodies: [1] })),
    );
    expect(message).toContain("thin_wall");
  });

  test("a body that is not in the geometry is refused by name", async () => {
    const { engine } = await engineWith(LE6_STEP);
    const message = refusalOf(engine, () =>
      engine.plan_shell_bodies(planOptions([2])),
    );
    expect(message).toContain("body 2");
  });
});
