// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Netgen meshing time per stage and the shape quality of the result
// (KOF-456), for STEP files in test_files/. A benchmark, not a test: it
// prints one table. tests/integration/meshing-bench.test.mjs checks what it
// measures.
//
// The engine logs a line as it starts each Netgen stage (mesh_netgen.cpp);
// a stage's time runs from its line to the next one, so no timer is compiled
// into the engine. Step 3 includes the surface optimisation (optsteps_2d)
// and step 4 the volume optimisation (optsteps_3d). Quality is each
// tetrahedron's smallest dihedral angle and aspect ratio (1 when regular),
// computed in the Rust module (kofem_fem::tet_quality).
//
// Usage (from web/):
//   bun tests/bench_meshing.mjs "<step file>:<max element size>[:<options JSON>]" ...
// e.g. bun tests/bench_meshing.mjs "Wall Bracket.stp:3" 'Wall Bracket.stp:3:{"optsteps_3d":1}'
// The options JSON overrides the app's meshing options (APP_OPTIONS) for that
// run; the min element size defaults to a tenth of the max, as in the app.

import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { loadEngine, loadFem } from "./support/wasm.mjs";

const here = dirname(fileURLToPath(import.meta.url));

/** The options the app's solver worker sends to generate_fem_mesh. */
export const APP_OPTIONS = {
  grading: 0.3,
  second_order: false,
  elementsperedge: 2.0,
  elementspercurve: 2.0,
  optsteps_2d: 3,
  optsteps_3d: 3,
};

/** Netgen's stages, in order, as the benchmark names them. */
export const STAGES = ["localSize", "edges", "surface", "volume"];

// The line the engine logs as each stage starts, and the one after the last.
const STAGE_LINES = [
  /\[netgen\] step 1\/4:/,
  /\[netgen\] step 2\/4:/,
  /\[netgen\] step 3\/4: meshing surfaces/,
  /\[netgen\] step 4\/4: Delaunay/,
  /\[netgen\] step 4\/4: volume mesh done/,
];

/**
 * Meshes `step` (STEP bytes) in a fresh engine with the app's options plus
 * `options`, and times it.
 *
 * @returns {Promise<{seconds: number, stages: Record<string, number>,
 *   vertices: Float64Array, tetrahedra: Uint32Array}>}
 */
export async function meshTimed(step, options) {
  if (!(options.max_element_size > 0))
    throw new Error(
      `meshTimed: max_element_size must be positive, got ${options.max_element_size}`,
    );
  const lines = [];
  const stamp = (line) => lines.push({ at: performance.now(), line });
  const engine = await loadEngine({ print: stamp, printErr: stamp });
  engine.tessellate_step(
    new Uint8Array(step),
    JSON.stringify({ deflection_relative: 0.001, angular_deflection: 0.5 }),
  );
  const started = performance.now();
  const mesh = engine.generate_fem_mesh(
    JSON.stringify({
      min_element_size: options.max_element_size / 10,
      ...APP_OPTIONS,
      ...options,
    }),
  );
  const seconds = (performance.now() - started) / 1000;
  if (!mesh.vertices || !mesh.tetrahedra)
    throw new Error(
      `meshing failed: ${JSON.stringify(mesh.overlaps ?? mesh).slice(0, 300)}`,
    );
  const marks = STAGE_LINES.map((pattern) => {
    const found = lines.find(({ line }) => pattern.test(line));
    if (!found)
      throw new Error(`the engine logged no line matching ${pattern}`);
    return found.at;
  });
  const stages = Object.fromEntries(
    STAGES.map((name, i) => [name, (marks[i + 1] - marks[i]) / 1000]),
  );
  return {
    seconds,
    stages,
    vertices: Float64Array.from(mesh.vertices),
    tetrahedra: Uint32Array.from(mesh.tetrahedra),
  };
}

/** The worst and typical shape quality of a mesh of linear tetrahedra. */
export function qualitySummary(fem, vertices, tetrahedra) {
  const quality = fem.tetQuality(vertices, tetrahedra);
  const dihedral = quality.minDihedralDeg.sort();
  const aspect = quality.aspectRatio;
  quality.free();
  const tets = dihedral.length;
  if (tets === 0) throw new Error("qualitySummary: the mesh has no tetrahedra");
  let sum = 0;
  let max = 0;
  for (const value of aspect) {
    sum += value;
    max = Math.max(max, value);
  }
  return {
    tets,
    minDihedralDeg: dihedral[0],
    p01DihedralDeg: dihedral[Math.floor(0.01 * (tets - 1))],
    below10Deg: dihedral.filter((angle) => angle < 10).length,
    meanAspectRatio: sum / tets,
    maxAspectRatio: max,
  };
}

if (import.meta.main) {
  const cases = process.argv.slice(2);
  if (cases.length === 0)
    throw new Error(
      'usage: bench_meshing.mjs "<step>:<size>[:<options JSON>]" ...',
    );
  const fem = await loadFem();
  const secs = (value) => value.toFixed(2);
  console.log(
    "| Model | Size | Options | Tets | Local size | Edges | Surface | Volume | Total | Min dihedral | 1 % dihedral | < 10° | Mean AR | Max AR |",
  );
  console.log(
    "| -- | -- | -- | -- | -- | -- | -- | -- | -- | -- | -- | -- | -- | -- |",
  );
  for (const spec of cases) {
    const [file, sizeText, ...rest] = spec.split(":");
    const overrides = rest.length > 0 ? JSON.parse(rest.join(":")) : {};
    const step = readFileSync(join(here, "../../test_files", file));
    const run = await meshTimed(step, {
      max_element_size: Number(sizeText),
      ...overrides,
    });
    const quality = qualitySummary(fem, run.vertices, run.tetrahedra);
    const { localSize, edges, surface, volume } = run.stages;
    console.log(
      `| ${file} | ${sizeText} | ${rest.length > 0 ? rest.join(":") : "app"} | ${quality.tets} | ` +
        `${secs(localSize)} | ${secs(edges)} | ${secs(surface)} | ${secs(volume)} | ${secs(run.seconds)} | ` +
        `${quality.minDihedralDeg.toFixed(1)}° | ${quality.p01DihedralDeg.toFixed(1)}° | ${quality.below10Deg} | ` +
        `${quality.meanAspectRatio.toFixed(2)} | ${quality.maxAspectRatio.toFixed(1)} |`,
    );
  }
}
