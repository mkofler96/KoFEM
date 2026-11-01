// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Headless linear-static analysis of an arbitrary STEP/IGES file, through the
// engine calls the app makes: tessellate_step → generate_fem_mesh (the worker's
// mesher options) → solve_linear_elastic in a fresh engine instance (the app
// resets its worker between mesh and solve). Supports and loads act on whole
// CAD faces, the way a user picks them in the viewport. Used by the daily-fea
// skill (.claude/skills/daily-fea/), which reports the run to Linear.
//
//   bun scripts/analyze-cad.mjs survey <file> <outDir> [maxElementSize]
//       Meshes the part and writes survey.json + survey.png: bounding box,
//       volume, bodies, and every CAD face with its area, centroid and mean
//       normal, so supports and loads can be chosen. The PNG labels nothing; the
//       face table is the reference.
//
//   bun scripts/analyze-cad.mjs solve <file> <setup.json> <outDir>
//       Runs the analysis described by setup.json and writes report.json,
//       setup.png (supports blue, loads red) and result.png (von Mises on the
//       deformed shape). setup.json:
//         {
//           "maxElementSize": 4,                       // mm
//           "material": { "name": "Steel", "young": 210000, "poisson": 0.3,
//                         "density": 7.85e-9, "yield": 250 },  // MPa, t/mm³
//           "supports": [ { "name": "bolt face", "faceIds": [12], "dofs": [0,1,2] } ],
//           "loads": [ { "name": "hook pull", "faceIds": [7], "force": [0,0,-2000] },
//                      { "name": "pad", "faceIds": [3], "pressure": 1.5 } ],
//           "order": 1,             // FE order, as the app's element-order setting
//           "refine": true          // also solve at 0.5 × maxElementSize, and at
//                                   // order 2 on the same mesh (when order is 1)
//         }
//       Units are the app's: mm, N, MPa. "force" is the total force on the
//       faces; "pressure" acts as −p·n̂ (outward normal, positive pushes in).
//
// Failures are thrown with the stage that failed — a failure is a finding, not
// something to work around.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { deflateSync } from "node:zlib";
import { basename, dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const PKG = join(here, "../src/wasm/pkg");

// ── Engine ────────────────────────────────────────────────────────────────────

const wasmBinary = readFileSync(join(PKG, "kofem_wasm_emcc.wasm")).buffer;
const { default: createModule } = await import(join(PKG, "kofem_wasm_emcc.js"));
const engineLog = [];
const freshEngine = () =>
  createModule({
    wasmBinary,
    print: (l) => engineLog.push(l),
    printErr: (l) => engineLog.push(l),
  });

function formatOf(file) {
  const ext = extname(file).toLowerCase();
  if (ext === ".step" || ext === ".stp") return "step";
  if (ext === ".iges" || ext === ".igs") return "iges";
  throw new Error(
    `${file}: unsupported extension "${ext}" — KoFEM imports STEP and IGES`,
  );
}

const timed = (fn) => {
  const t0 = performance.now();
  const value = fn();
  return [value, (performance.now() - t0) / 1000];
};

// Import + mesh in one engine instance, with the worker's mesher options
// (solver.worker.ts handleVolumeMesh).
async function meshCad(file, maxElementSize) {
  const engine = await freshEngine();
  const bytes = new Uint8Array(readFileSync(file));
  const [tess, tImport] = timed(() =>
    engine.tessellate_step(
      bytes,
      JSON.stringify({
        deflection_relative: 0.001,
        angular_deflection: 0.5,
        format: formatOf(file),
      }),
    ),
  );
  if (tess.bodyCount === 0)
    throw new Error(
      `import: ${basename(file)} holds no closed solid (surface-only geometry that did not sew)`,
    );
  const bbox = bounds(tess.vertices);
  const size = maxElementSize ?? round2(bbox.diagonal / 25);
  const [dto, tMesh] = timed(() =>
    engine.generate_fem_mesh(
      JSON.stringify({
        max_element_size: size,
        min_element_size: size / 10,
        grading: 0.3,
        second_order: false,
        elementsperedge: 2.0,
        elementspercurve: 2.0,
        optsteps_2d: 3,
        optsteps_3d: 3,
      }),
    ),
  );
  if (dto.tetrahedra.length === 0)
    throw new Error(
      `mesh: Netgen produced no tetrahedra at max element size ${size} mm`,
    );
  return {
    bodyCount: tess.bodyCount,
    cadFaceCount: new Set(tess.triangleFaceIds).size,
    bbox,
    maxElementSize: size,
    V: Float64Array.from(dto.vertices),
    tet: Int32Array.from(dto.tetrahedra),
    body: Int32Array.from(dto.bodyIds),
    tri: Int32Array.from(dto.surfaceTriangles),
    triFace: Int32Array.from(dto.surfaceFaceIds),
    seconds: { import: tImport, mesh: tMesh },
  };
}

// ── Geometry helpers ──────────────────────────────────────────────────────────

const round2 = (x) => Number(x.toPrecision(2));
const sig = (x) => Number(x.toPrecision(4));
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a, b) => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const norm = (a) => Math.hypot(a[0], a[1], a[2]);
const unit = (a) => {
  const n = norm(a);
  return [a[0] / n, a[1] / n, a[2] / n];
};
const pt = (V, i) => [V[3 * i], V[3 * i + 1], V[3 * i + 2]];

function bounds(V) {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < V.length; i += 3)
    for (let d = 0; d < 3; d++) {
      min[d] = Math.min(min[d], V[i + d]);
      max[d] = Math.max(max[d], V[i + d]);
    }
  const size = sub(max, min);
  return {
    min: min.map(sig),
    max: max.map(sig),
    size: size.map(sig),
    diagonal: sig(norm(size)),
  };
}

function tetVolume(m, e) {
  const [a, b, c, d] = [0, 1, 2, 3].map((k) => pt(m.V, m.tet[4 * e + k]));
  return Math.abs(dot(sub(b, a), cross(sub(c, a), sub(d, a)))) / 6;
}

// Connected components of the tet mesh. More than one means parts that touch
// nothing — unbonded bodies or floating fragments — and a singular stiffness.
function componentCount(m) {
  const parent = Int32Array.from({ length: m.V.length / 3 }, (_, i) => i);
  const find = (i) => {
    while (parent[i] !== i) i = parent[i] = parent[parent[i]];
    return i;
  };
  for (let e = 0; e < m.tet.length / 4; e++)
    for (let k = 1; k < 4; k++)
      parent[find(m.tet[4 * e + k])] = find(m.tet[4 * e]);
  const roots = new Set();
  for (let e = 0; e < m.tet.length / 4; e++) roots.add(find(m.tet[4 * e]));
  return roots.size;
}

// Per CAD face: area, centroid, mean normal (|n| ≈ 1 ⇒ planar), its nodes.
function cadFaces(m) {
  const faces = new Map();
  for (let t = 0; t < m.triFace.length; t++) {
    const id = m.triFace[t];
    let f = faces.get(id);
    if (!f)
      faces.set(
        id,
        (f = {
          id,
          area: 0,
          c: [0, 0, 0],
          n: [0, 0, 0],
          tris: [],
          nodes: new Set(),
        }),
      );
    const [a, b, c] = [0, 1, 2].map((k) => pt(m.V, m.tri[3 * t + k]));
    const nA = cross(sub(b, a), sub(c, a)); // 2·area·n̂
    const area = norm(nA) / 2;
    f.area += area;
    for (let d = 0; d < 3; d++) {
      f.c[d] += (area * (a[d] + b[d] + c[d])) / 3;
      f.n[d] += nA[d] / 2;
    }
    f.tris.push(t);
    for (let k = 0; k < 3; k++) f.nodes.add(m.tri[3 * t + k]);
  }
  for (const f of faces.values()) {
    f.c = f.c.map((x) => x / f.area);
    f.planarity = norm(f.n) / f.area; // 1 = flat, ~0 = closed cylinder/sphere
    f.n = norm(f.n) > 1e-12 ? unit(f.n) : [0, 0, 0];
  }
  return faces;
}

function faceSummary(f) {
  return {
    id: f.id,
    area: sig(f.area),
    centroid: f.c.map(sig),
    normal: f.planarity < 0.05 ? null : f.n.map((x) => sig(x)),
    kind:
      f.planarity > 0.999
        ? "planar"
        : f.planarity < 0.05
          ? "closed-curved"
          : "curved",
    nodes: f.nodes.size,
  };
}

function meshSummary(m) {
  let volume = 0;
  for (let e = 0; e < m.tet.length / 4; e++) volume += tetVolume(m, e);
  return {
    bodies: m.bodyCount,
    cadFaces: m.cadFaceCount,
    boundingBox: m.bbox,
    maxElementSize: m.maxElementSize,
    nodes: m.V.length / 3,
    tetrahedra: m.tet.length / 4,
    volume: sig(volume),
    // Edge of the regular tet with the mean element volume — what the mesh
    // actually is, which on thin walls is far below maxElementSize.
    meanEdge: sig(Math.cbrt((6 * Math.SQRT2 * volume) / (m.tet.length / 4))),
    connectedComponents: componentCount(m),
    seconds: { import: sig(m.seconds.import), mesh: sig(m.seconds.mesh) },
  };
}

// ── Solve ─────────────────────────────────────────────────────────────────────

function pickFaces(faces, ids, what) {
  return ids.map((id) => {
    const f = faces.get(id);
    if (!f)
      throw new Error(
        `${what}: CAD face ${id} does not exist — faces are 1..${Math.max(...faces.keys())}`,
      );
    return f;
  });
}

async function solveOn(m, setup, order = setup.order ?? 1) {
  if (m.bodyCount !== 1 || componentCount(m) !== 1)
    throw new Error(
      `solve: the mesh has ${m.bodyCount} bodies in ${componentCount(m)} connected pieces — ` +
        "this driver solves one connected solid; multibody bonding goes through the app's coupled path",
    );
  const faces = cadFaces(m);
  const fixedDofs = new Map(); // vertex → Set(dof)
  for (const s of setup.supports)
    for (const f of pickFaces(faces, s.faceIds, `support "${s.name}"`))
      for (const v of f.nodes) {
        const set = fixedDofs.get(v) ?? fixedDofs.set(v, new Set()).get(v);
        for (const d of s.dofs ?? [0, 1, 2]) set.add(d);
      }
  if (fixedDofs.size === 0)
    throw new Error("solve: no supports — the model would be free to move");
  const fixed_vertices = [];
  const fixed_dofs = [];
  for (const [vertex, dofs] of fixedDofs)
    if (dofs.size === 3) fixed_vertices.push(vertex);
    else fixed_dofs.push({ vertex, dofs: [...dofs].sort() });

  const surface_loads = setup.loads.map((l) => {
    const fs = pickFaces(faces, l.faceIds, `load "${l.name}"`);
    const tris = fs.flatMap((f) =>
      f.tris.map((t) => [m.tri[3 * t], m.tri[3 * t + 1], m.tri[3 * t + 2]]),
    );
    if (l.force) return { type: "force", faces: tris, force: l.force };
    if (l.pressure !== undefined)
      return { type: "pressure", faces: tris, pressure: l.pressure };
    throw new Error(
      `load "${l.name}": give either "force" (total N) or "pressure" (MPa)`,
    );
  });

  const engine = await freshEngine(); // a clean instance, as the app's resetWorker
  const mat = setup.material;
  const [result, tSolve] = timed(() =>
    engine.solve_linear_elastic(
      { vertices: m.V, tetrahedra: m.tet, hexahedra: new Int32Array(0) },
      JSON.stringify({
        young_modulus: mat.young,
        poisson_ratio: mat.poisson,
        density: mat.density,
      }),
      JSON.stringify({
        fixed_vertices,
        fixed_dofs,
        prescribed_dofs: [],
        point_loads: [],
        surface_loads,
      }),
      order,
    ),
  );
  if ("error" in result) throw new Error(`solve: ${result.error}`);
  const u = Float64Array.from(result.displacements);
  const vm = Float64Array.from(result.von_mises);
  if (u.length !== m.V.length || vm.length !== m.tet.length / 4)
    throw new Error(
      `solve: order ${order} returned ${u.length / 3} displacements for ${m.V.length / 3} nodes ` +
        `and ${vm.length} stresses for ${m.tet.length / 4} elements`,
    );
  for (let i = 0; i < u.length; i++)
    if (!Number.isFinite(u[i]))
      throw new Error(
        `solve: displacement ${i} is ${u[i]} — the solve diverged`,
      );
  return {
    faces,
    u,
    vm,
    fixedNodes: new Set(fixedDofs.keys()),
    seconds: tSolve,
  };
}

function resultSummary(m, r) {
  const nN = m.V.length / 3;
  let iu = 0;
  let umax = 0;
  for (let i = 0; i < nN; i++) {
    const a = Math.hypot(r.u[3 * i], r.u[3 * i + 1], r.u[3 * i + 2]);
    if (a > umax) [umax, iu] = [a, i];
  }
  const nE = r.vm.length;
  let ie = 0;
  for (let e = 1; e < nE; e++) if (r.vm[e] > r.vm[ie]) ie = e;
  const sorted = Float64Array.from(r.vm).sort();
  const pct = (p) => sorted[Math.min(nE - 1, Math.floor(p * nE))];
  const centroid = [0, 1, 2].map((d) => {
    let s = 0;
    for (let k = 0; k < 4; k++) s += m.V[3 * m.tet[4 * ie + k] + d];
    return sig(s / 4);
  });
  const touchesSupport = [0, 1, 2, 3].some((k) =>
    r.fixedNodes.has(m.tet[4 * ie + k]),
  );
  return {
    maxDisplacement: {
      magnitude: sig(umax),
      components: [0, 1, 2].map((d) => sig(r.u[3 * iu + d])),
      at: pt(m.V, iu).map(sig),
    },
    vonMises: {
      max: sig(r.vm[ie]),
      maxAt: centroid,
      maxElementTouchesSupport: touchesSupport,
      p99: sig(pct(0.99)),
      p95: sig(pct(0.95)),
      median: sig(pct(0.5)),
    },
    solveSeconds: sig(r.seconds),
  };
}

// ── Rendering (software rasteriser → PNG) ────────────────────────────────────

const VIEWS = [
  [1, -1.3, 0.9],
  [-1, 1.3, 0.9],
];
const PANEL = 700;
const SS = 2; // supersampling

function jet(t) {
  const c = (x) => Math.max(0, Math.min(1, x));
  return [
    c(1.5 - Math.abs(4 * t - 3)),
    c(1.5 - Math.abs(4 * t - 2)),
    c(1.5 - Math.abs(4 * t - 1)),
  ].map((x) => Math.round(255 * x));
}

// tris: Int32Array of vertex triples; P: positions; color(t, k) → [r,g,b] for
// corner k of triangle t. Two orthographic iso views side by side, plus an
// optional colour bar.
function render(P, tris, color, { colorBar = false } = {}) {
  const W = (2 * PANEL + (colorBar ? 90 : 0)) * SS;
  const H = PANEL * SS;
  const img = new Uint8Array(W * H * 3).fill(255);
  const zbuf = new Float64Array(W * H);
  const nP = P.length / 3;
  for (let v = 0; v < VIEWS.length; v++) {
    zbuf.fill(Infinity);
    const f = unit(VIEWS[v].map((x) => -x));
    const r = unit(cross(f, [0, 0, 1]));
    const up = cross(r, f);
    const proj = new Float64Array(3 * nP);
    const lo = [Infinity, Infinity];
    const hi = [-Infinity, -Infinity];
    for (let i = 0; i < nP; i++) {
      const p = pt(P, i);
      proj[3 * i] = dot(p, r);
      proj[3 * i + 1] = dot(p, up);
      proj[3 * i + 2] = dot(p, f);
      for (let d = 0; d < 2; d++) {
        lo[d] = Math.min(lo[d], proj[3 * i + d]);
        hi[d] = Math.max(hi[d], proj[3 * i + d]);
      }
    }
    const scale = (0.88 * PANEL * SS) / Math.max(hi[0] - lo[0], hi[1] - lo[1]);
    const ox = v * PANEL * SS + (PANEL * SS) / 2;
    const oy = H / 2;
    const cx = (lo[0] + hi[0]) / 2;
    const cy = (lo[1] + hi[1]) / 2;
    const sx = (i) => ox + (proj[3 * i] - cx) * scale;
    const sy = (i) => oy - (proj[3 * i + 1] - cy) * scale;
    for (let t = 0; t < tris.length / 3; t++) {
      const ids = [tris[3 * t], tris[3 * t + 1], tris[3 * t + 2]];
      const n = cross(
        sub(pt(P, ids[1]), pt(P, ids[0])),
        sub(pt(P, ids[2]), pt(P, ids[0])),
      );
      const nl = norm(n);
      if (nl === 0) continue;
      const shade = 0.4 + 0.6 * Math.abs(dot(n, f) / nl);
      const cols = [0, 1, 2].map((k) => color(t, k).map((c) => c * shade));
      const xs = ids.map(sx);
      const ys = ids.map(sy);
      const zs = ids.map((i) => proj[3 * i + 2]);
      const area =
        (xs[1] - xs[0]) * (ys[2] - ys[0]) - (xs[2] - xs[0]) * (ys[1] - ys[0]);
      if (area === 0) continue;
      const x0 = Math.max(v * PANEL * SS, Math.floor(Math.min(...xs)));
      const x1 = Math.min((v + 1) * PANEL * SS - 1, Math.ceil(Math.max(...xs)));
      const y0 = Math.max(0, Math.floor(Math.min(...ys)));
      const y1 = Math.min(H - 1, Math.ceil(Math.max(...ys)));
      for (let y = y0; y <= y1; y++)
        for (let x = x0; x <= x1; x++) {
          const px = x + 0.5;
          const py = y + 0.5;
          const w0 =
            ((xs[1] - px) * (ys[2] - py) - (xs[2] - px) * (ys[1] - py)) / area;
          const w1 =
            ((xs[2] - px) * (ys[0] - py) - (xs[0] - px) * (ys[2] - py)) / area;
          const w2 = 1 - w0 - w1;
          if (w0 < 0 || w1 < 0 || w2 < 0) continue;
          const z = w0 * zs[0] + w1 * zs[1] + w2 * zs[2];
          const o = y * W + x;
          if (z >= zbuf[o]) continue;
          zbuf[o] = z;
          for (let c = 0; c < 3; c++)
            img[3 * o + c] =
              w0 * cols[0][c] + w1 * cols[1][c] + w2 * cols[2][c];
        }
    }
  }
  if (colorBar)
    for (let y = 0.1 * H; y < 0.9 * H; y++)
      for (
        let x = 2 * PANEL * SS + 30 * SS;
        x < 2 * PANEL * SS + 60 * SS;
        x++
      ) {
        const c = jet(1 - (y - 0.1 * H) / (0.8 * H));
        img.set(c, 3 * (Math.floor(y) * W + x));
      }
  return downsample(img, W, H);
}

function downsample(img, W, H) {
  const w = W / SS;
  const h = H / SS;
  const out = new Uint8Array(w * h * 3);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++)
      for (let c = 0; c < 3; c++) {
        let s = 0;
        for (let j = 0; j < SS; j++)
          for (let i = 0; i < SS; i++)
            s += img[3 * ((y * SS + j) * W + x * SS + i) + c];
        out[3 * (y * w + x) + c] = s / (SS * SS);
      }
  return { w, h, rgb: out };
}

const CRC = Uint32Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function png({ w, h, rgb }) {
  const raw = new Uint8Array(h * (1 + 3 * w));
  for (let y = 0; y < h; y++)
    raw.set(rgb.subarray(3 * w * y, 3 * w * (y + 1)), y * (1 + 3 * w) + 1);
  const chunk = (type, data) => {
    const b = Buffer.alloc(12 + data.length);
    b.writeUInt32BE(data.length, 0);
    b.write(type, 4, "ascii");
    Buffer.from(data).copy(b, 8);
    b.writeUInt32BE(crc32(b.subarray(4, 8 + data.length)), 8 + data.length);
    return b;
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr.set([8, 2, 0, 0, 0], 8); // 8-bit RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", new Uint8Array(0)),
  ]);
}

const GREY = [205, 205, 210];
function renderSetup(m, roleOfFace) {
  const roleColor = { support: [60, 110, 230], load: [225, 60, 50] };
  return png(
    render(m.V, m.tri, (t) => roleColor[roleOfFace.get(m.triFace[t])] ?? GREY),
  );
}

function renderResult(m, r, umax) {
  const nN = m.V.length / 3;
  // Nodal von Mises: average of the elements sharing the node.
  const sum = new Float64Array(nN);
  const cnt = new Float64Array(nN);
  for (let e = 0; e < r.vm.length; e++)
    for (let k = 0; k < 4; k++) {
      sum[m.tet[4 * e + k]] += r.vm[e];
      cnt[m.tet[4 * e + k]] += 1;
    }
  const nodal = sum.map((s, i) => (cnt[i] ? s / cnt[i] : 0));
  const top = Math.max(...nodal);
  // Deformation scaled so the largest displacement reads as 5 % of the part.
  const k = umax > 0 ? (0.05 * m.bbox.diagonal) / umax : 0;
  const P = m.V.map((x, i) => x + k * r.u[i]);
  const image = png(
    render(P, m.tri, (t, c) => jet(nodal[m.tri[3 * t + c]] / top), {
      colorBar: true,
    }),
  );
  return { image, scale: sig(k), nodalMax: sig(top) };
}

// ── Commands ──────────────────────────────────────────────────────────────────

const [cmd, file, ...rest] = process.argv.slice(2);
if (cmd === "survey") {
  const [outDir, size] = rest;
  mkdirSync(outDir, { recursive: true });
  const m = await meshCad(file, size ? parseFloat(size) : undefined);
  const faces = [...cadFaces(m).values()].sort((a, b) => b.area - a.area);
  const survey = {
    file: basename(file),
    ...meshSummary(m),
    faces: faces.map(faceSummary),
  };
  writeFileSync(join(outDir, "survey.json"), JSON.stringify(survey, null, 2));
  writeFileSync(join(outDir, "survey.png"), renderSetup(m, new Map()));
  const { faces: _all, ...head } = survey;
  console.log(JSON.stringify(head, null, 2));
  console.log(`${faces.length} CAD faces, largest first (all in survey.json):`);
  for (const f of survey.faces.slice(0, 30)) console.log(JSON.stringify(f));
} else if (cmd === "solve") {
  const [setupPath, outDir] = rest;
  mkdirSync(outDir, { recursive: true });
  const setup = JSON.parse(readFileSync(setupPath, "utf8"));
  const m = await meshCad(file, setup.maxElementSize);
  const r = await solveOn(m, setup);
  const roles = new Map();
  for (const s of setup.supports)
    for (const id of s.faceIds) roles.set(id, "support");
  for (const l of setup.loads)
    for (const id of l.faceIds) roles.set(id, "load");
  const summary = resultSummary(m, r);
  const rendered = renderResult(m, r, summary.maxDisplacement.magnitude);
  writeFileSync(join(outDir, "setup.png"), renderSetup(m, roles));
  writeFileSync(join(outDir, "result.png"), rendered.image);
  const facesUsed = (ids) => ids.map((id) => faceSummary(r.faces.get(id)));
  const report = {
    file: basename(file),
    mesh: meshSummary(m),
    material: setup.material,
    supports: setup.supports.map((s) => ({
      ...s,
      faces: facesUsed(s.faceIds),
    })),
    loads: setup.loads.map((l) => {
      const area = l.faceIds.reduce((a, id) => a + r.faces.get(id).area, 0);
      const F = l.force ? norm(l.force) : undefined;
      return {
        ...l,
        area: sig(area),
        meanTraction: F ? sig(F / area) : undefined,
        faces: facesUsed(l.faceIds),
      };
    }),
    result: summary,
    render: {
      deformationScale: rendered.scale,
      colorBarMax: rendered.nodalMax,
      colorBarMin: 0,
    },
  };
  if (setup.material.yield)
    report.result.safetyFactor = {
      onMax: sig(setup.material.yield / summary.vonMises.max),
      onP99: sig(setup.material.yield / summary.vonMises.p99),
    };
  if (setup.refine) {
    const rel = (a, b) => sig((100 * (b - a)) / a);
    const check = (mesh, sum) => ({
      maxElementSize: mesh.maxElementSize,
      meanEdge: meshSummary(mesh).meanEdge,
      tetrahedra: mesh.tet.length / 4,
      maxDisplacement: sum.maxDisplacement.magnitude,
      vonMisesMax: sum.vonMises.max,
      vonMisesP99: sum.vonMises.p99,
      changePercent: {
        maxDisplacement: rel(
          summary.maxDisplacement.magnitude,
          sum.maxDisplacement.magnitude,
        ),
        vonMisesMax: rel(summary.vonMises.max, sum.vonMises.max),
        vonMisesP99: rel(summary.vonMises.p99, sum.vonMises.p99),
      },
    });
    // h: half the element size, same order.
    const fine = await meshCad(file, round2(0.5 * m.maxElementSize));
    report.hRefinement = check(
      fine,
      resultSummary(fine, await solveOn(fine, setup)),
    );
    // p: quadratic elements on the same mesh — the honest check for linear
    // tets in bending, which are too stiff with one or two through a wall.
    if ((setup.order ?? 1) === 1)
      report.pRefinement = {
        order: 2,
        ...check(m, resultSummary(m, await solveOn(m, setup, 2))),
      };
  }
  writeFileSync(join(outDir, "report.json"), JSON.stringify(report, null, 2));
  console.log(
    JSON.stringify(report, (k, v) => (k === "faces" ? undefined : v), 2),
  );
} else {
  throw new Error(
    "usage: bun scripts/analyze-cad.mjs survey <file> <outDir> [maxElementSize]\n" +
      "       bun scripts/analyze-cad.mjs solve <file> <setup.json> <outDir>",
  );
}
