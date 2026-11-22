// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Times the static solve of the exported models (export-models.mjs) with
// every solver configuration of the study, and appends one JSON line per run.
//
// Configurations:
//   mfem:<variant>   the C++ engine's MFEM solve (PCG with symmetric Gauss–
//                    Seidel, MFEM 4.7), one build per variant directory under
//                    --variants (build-engine-variant.sh)
//   rust-gs          the Rust module's PCG with symmetric Gauss–Seidel
//   rust-amg         the Rust module's PCG with smoothed-aggregation AMG
//   rust-gs@<name>,  the same with a second build of the Rust module, loaded
//   rust-amg@<name>  side by side (make-entry.mjs --alt <name>=<dir>), so two
//                    builds are randomised within the same rounds
//
// The app code and the Rust module come from a source tree (make-entry.mjs
// writes an entry that imports them statically), so the same code runs
// against the last commit that still had the C++ solver and against develop,
// under Bun (JavaScriptCore) directly and under Node (V8) after `bun build`.
// Every solve gets the same model file: same mesh, same supports, same loads,
// same element order. Each solve's phases are read from the timestamps of the
// lines it logs (the C++ engine prints them synchronously): assembly, solver
// setup, iterations.
//
// Design: for each model, `--warmup` untimed rounds, then `--reps` timed
// rounds; within a round every configuration runs once, in a fresh random
// order (seeded, so a run can be repeated), so slow drift of the machine
// spreads over all configurations instead of biasing one. Each MFEM solve gets
// a fresh engine instance from its compiled module, as the app's worker does.
//
// Options: --models <dir> --out <file.jsonl> --configs mfem:A,rust-gs,rust-amg
//          [--variants <dir>] [--only <model-file-prefix,...>]
//          [--reps 5] [--warmup 1] [--seed 1]

import { appendFileSync, readFileSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";

const sha1 = (bytes) => createHash("sha1").update(bytes).digest("hex");

export async function runBenchmark(deps, argv) {
  const args = Object.fromEntries(
    argv.reduce((pairs, a, i, all) => {
      if (a.startsWith("--")) pairs.push([a.slice(2), all[i + 1]]);
      return pairs;
    }, []),
  );
  for (const required of ["models", "out", "configs"])
    if (!args[required]) throw new Error(`missing --${required}`);
  const reps = Number(args.reps ?? 5);
  const warmup = Number(args.warmup ?? 1);
  let seed = Number(args.seed ?? 1);
  const BUDGET = 200000; // iterations; no solve here comes near it
  const configs = args.configs.split(",");

  const {
    buildVertexIndexer,
    solveSolidInRust,
    femGlue,
    buildSolidEngineInputs,
  } = deps;
  // Instantiate the Rust module from its bytes (no fetch outside a browser);
  // the app's loader then finds it initialised.
  const femWasm = readFileSync(deps.femWasmPath);
  await femGlue.default({ module_or_path: femWasm });
  const fem = {
    ElasticModel: femGlue.ElasticModel,
    SolveOptions: femGlue.SolveOptions,
    Ties: femGlue.Ties,
  };
  const femId = sha1(femWasm);
  // A second build of the Rust module, as its own glue instance.
  let femAlt = null;
  if (deps.femAlt) {
    const bytes = readFileSync(deps.femAlt.wasmPath);
    await deps.femAlt.glue.default({ module_or_path: bytes });
    femAlt = {
      name: deps.femAlt.name,
      id: sha1(bytes),
      fem: {
        ElasticModel: deps.femAlt.glue.ElasticModel,
        SolveOptions: deps.femAlt.glue.SolveOptions,
        Ties: deps.femAlt.glue.Ties,
      },
    };
  }
  for (const c of configs.filter((c) => c.includes("@")))
    if (!femAlt || c.split("@")[1] !== femAlt.name)
      throw new Error(`${c}: no Rust build "${c.split("@")[1]}" loaded`);

  // One compiled module per MFEM variant; instantiated afresh for every solve.
  const mfem = new Map();
  for (const c of configs.filter((c) => c.startsWith("mfem:"))) {
    if (!args.variants) throw new Error("--variants is required for mfem:*");
    if (!buildSolidEngineInputs)
      throw new Error("this tree has no C++ solve (buildSolidEngineInputs)");
    const dir = join(args.variants, c.slice(5));
    const { default: createModule } = await import(
      join(dir, "kofem_wasm_emcc.js")
    );
    const wasmBinary = readFileSync(join(dir, "kofem_wasm_emcc.wasm"));
    mfem.set(c, {
      createModule,
      wasmBinary: wasmBinary.buffer,
      id: sha1(wasmBinary),
    });
  }

  // mulberry32: a small seeded generator for the run order.
  function random() {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  function shuffled(list) {
    const a = [...list];
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  const first = (lines, pattern) => lines.find(([, l]) => pattern.test(l));

  async function solveMfem(config, model, order) {
    const { createModule, wasmBinary } = mfem.get(config);
    const lines = [];
    const stamp = (line) => lines.push([performance.now(), line]);
    const engine = await createModule({
      wasmBinary,
      print: stamp,
      printErr: stamp,
      onCgLimit: async () => 0,
    });
    engine.cgIterationLimit = BUDGET;
    const vid = buildVertexIndexer(model.nodes);
    const inputs = buildSolidEngineInputs(model, vid);
    const t0 = performance.now();
    const raw = engine.solve_linear_elastic(
      inputs.mesh,
      inputs.matJson,
      inputs.bcsJson,
      order,
    );
    const t1 = performance.now();
    if ("error" in raw) throw new Error(`MFEM: ${raw.error}`);
    const a0 = first(lines, /assembling stiffness matrix/)[0];
    const a1 = first(lines, /assembly done/)[0];
    const c0 = first(lines, /starting CG solve/)[0];
    const done = first(lines, /CG converged/);
    return {
      displacements: Float64Array.from(raw.displacements),
      totalMs: t1 - t0,
      phasesMs: {
        // FE space, BC lookup and the load vector, then the stiffness matrix.
        setupInputs: a0 - t0,
        assembly: a1 - a0,
        // FormLinearSystem: eliminating the supported DOFs.
        eliminate: c0 - a1,
        // GSSmoother set-up (one diagonal pass) and the PCG iterations.
        iterations: done[0] - c0,
        post: t1 - done[0],
      },
      iterations: Number(/(\d+) iterations/.exec(done[1])[1]),
      dofs: Number(
        /CG solve \((\d+) rows\)/.exec(first(lines, /starting CG solve/)[1])[1],
      ),
    };
  }

  async function solveRust(method, model, order, build = fem) {
    const lines = [];
    const vid = buildVertexIndexer(model.nodes);
    const t0 = performance.now();
    const result = await solveSolidInRust(
      build,
      model,
      order,
      method,
      vid,
      vid,
      BUDGET,
      () => {
        throw new Error("iteration budget reached");
      },
      (line) => lines.push([performance.now(), line]),
    );
    const t1 = performance.now();
    const assembled = first(lines, /stiffness entries assembled/);
    const ready = first(lines, /AMG preconditioner ready/);
    const done = first(lines, /CG converged/);
    const startIterations = ready ? ready[0] : assembled[0];
    return {
      displacements: Float64Array.from(result.displacements),
      totalMs: t1 - t0,
      phasesMs: {
        // Packing, model creation, load vector, then assembly.
        assembly: assembled[0] - t0,
        setup: ready ? ready[0] - assembled[0] : 0,
        iterations: done[0] - startIterations,
        post: t1 - done[0],
      },
      iterations: Number(/(\d+) iterations/.exec(done[1])[1]),
      dofs: Number(/(\d+) unknowns/.exec(assembled[1])[1]),
      levels: ready ? /\[(.*)\]/.exec(ready[1])[1] : null,
    };
  }

  function solve(config, model, order) {
    if (config.startsWith("mfem:")) return solveMfem(config, model, order);
    if (config === "rust-gs") return solveRust("gauss-seidel", model, order);
    if (config === "rust-amg") return solveRust("amg", model, order);
    if (femAlt && config === `rust-gs@${femAlt.name}`)
      return solveRust("gauss-seidel", model, order, femAlt.fem);
    if (femAlt && config === `rust-amg@${femAlt.name}`)
      return solveRust("amg", model, order, femAlt.fem);
    throw new Error(`unknown configuration ${config}`);
  }

  function maxRelDiff(reference, other) {
    let peak = 0;
    let diff = 0;
    for (let i = 0; i < reference.length; i++) {
      peak = Math.max(peak, Math.abs(reference[i]));
      diff = Math.max(diff, Math.abs(reference[i] - other[i]));
    }
    return diff / peak;
  }

  // The largest nodal displacement magnitude: a global read-out to follow
  // across meshes (displacements are x, y, z per node).
  function maxDisplacement(u) {
    if (u.length % 3 !== 0)
      throw new Error(`displacements: ${u.length} values, not 3 per node`);
    let peak = 0;
    for (let i = 0; i < u.length; i += 3)
      peak = Math.max(peak, Math.hypot(u[i], u[i + 1], u[i + 2]));
    return peak;
  }

  const only = args.only ? args.only.split(",") : null;
  const files = readdirSync(args.models)
    .filter((f) => f.endsWith(".json"))
    .filter((f) => !only || only.some((p) => f.startsWith(p)))
    .sort();
  if (files.length === 0) throw new Error("no model files selected");

  const runtime =
    typeof Bun !== "undefined"
      ? `bun ${Bun.version} (JavaScriptCore)`
      : `node ${process.version} (V8 ${process.versions.v8})`;
  for (const file of files) {
    const spec = JSON.parse(readFileSync(join(args.models, file), "utf8"));
    const reference = new Map();
    for (let round = 0; round < warmup + reps; round++) {
      for (const config of shuffled(configs)) {
        const r = await solve(config, spec.payload, spec.order);
        const firstDisp = reference.get("first");
        const diff = firstDisp ? maxRelDiff(firstDisp.u, r.displacements) : 0;
        if (!firstDisp) reference.set("first", { config, u: r.displacements });
        const row = {
          model: spec.model,
          order: spec.order,
          h: spec.maxElementSize,
          elements: spec.elements,
          dofs: r.dofs,
          config,
          build: config.startsWith("mfem:")
            ? mfem.get(config).id
            : config.includes("@")
              ? femAlt.id
              : femId,
          round,
          warmup: round < warmup,
          totalMs: r.totalMs,
          phasesMs: r.phasesMs,
          iterations: r.iterations,
          levels: r.levels ?? null,
          maxRelDiffToFirst: diff,
          maxDisplacement: maxDisplacement(r.displacements),
          firstConfig: reference.get("first").config,
          runtime,
          seed: Number(args.seed ?? 1),
        };
        appendFileSync(args.out, JSON.stringify(row) + "\n");
        console.log(
          `${file.padEnd(34)} r${round}${round < warmup ? "w" : " "} ${config.padEnd(18)} ` +
            `${(r.totalMs / 1000).toFixed(2).padStart(8)} s  ${String(r.iterations).padStart(6)} it  ` +
            `Δu ${diff.toExponential(1)}`,
        );
      }
    }
  }
}
