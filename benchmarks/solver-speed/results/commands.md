# Runs behind the published results

Each run file is one randomised experiment: one runtime, one set of builds,
one seed. `analyse.mjs` never pools rounds of different runs. All runs were
pinned to one core (`taskset -c 3`) on the machine named in the README, on
2026-11-22. `<old>` is a worktree of `1963c81` (the last commit with the C++
solver), `<dev>` this branch; the entries are written by `make-entry.mjs`
(`entry-old.mjs` with `--with-mfem`) and bundled for Node with
`bun build --target=node --format=esm`.

| Run file                     | Question                                              | Tree    | Runtime         |
| ---------------------------- | ----------------------------------------------------- | ------- | --------------- |
| `e1-factors-node.jsonl`      | Asyncify, -O2/-O3, C++ against Rust, GS against AMG   | `<old>` | Node 22.16 (V8) |
| `e2-scaling-node.jsonl`      | How the factors change with model size, all 29 models | `<old>` | Node 22.16 (V8) |
| `e3-develop-node.jsonl`      | GS against AMG in today's Rust module                 | `<dev>` | Node 22.16 (V8) |
| `e4-factors-bun.jsonl`       | The factor study repeated on JavaScriptCore           | `<old>` | Bun 1.4.4 (JSC) |
| `e5-wall-bracket-node.jsonl` | The wall bracket's largest displacement on every mesh | `<dev>` | Node 22.16 (V8) |

```bash
# E1: 8 models, all six configurations, 1 warm-up + 5 timed rounds
(cd <old>/web && taskset -c 3 node entry-old.node.mjs --models models --variants variants \
  --configs mfem:A-shipped,mfem:B-O2-noasync,mfem:C-O3-async,mfem:D-O3-noasync,rust-gs,rust-amg \
  --only cantilever-beam_p1_h12.5,cantilever-beam_p2_h25,cooks-membrane_p2_h2,plate-with-hole_p1_h1,plate-with-hole_p2_h4,wall-bracket_p1_h2.json,wall-bracket_p1_h3,wall-bracket_p2_h40 \
  --reps 5 --warmup 1 --seed 7 --out e1-factors-node.jsonl)
```

```bash
# E2: all 29 models with a C++ solve, shipped C++ and both Rust preconditioners, 3 timed rounds
(cd <old>/web && taskset -c 3 node entry-old.node.mjs --models models --variants variants \
  --configs mfem:A-shipped,rust-gs,rust-amg --only <the 29 models in the table> \
  --reps 3 --warmup 0 --seed 11 --out e2-scaling-node.jsonl)
```

```bash
# E3: today's Rust module, the same 29 models, 1 warm-up + 3 timed rounds; AMG alone on the
# finest quadratic bracket (Gauss–Seidel would take minutes per solve there)
(cd <dev>/web && taskset -c 3 node entry-dev.node.mjs --models models --configs rust-gs,rust-amg \
  --only <the 29 models> --reps 3 --warmup 1 --seed 13 --out e3-develop-node.jsonl)
(cd <dev>/web && taskset -c 3 node entry-dev.node.mjs --models models --configs rust-amg \
  --only wall-bracket_p2_h3.json --reps 3 --warmup 1 --seed 13 --out e3-develop-node.jsonl)
```

```bash
# E4: Bun runs the uncompiled entry directly; 3 models, 1 warm-up + 5 timed rounds
(cd <old>/web && taskset -c 3 bun entry-old.mjs --models models --variants variants \
  --configs mfem:A-shipped,mfem:B-O2-noasync,mfem:C-O3-async,mfem:D-O3-noasync,rust-gs,rust-amg \
  --only cooks-membrane_p2_h2,plate-with-hole_p1_h1,wall-bracket_p1_h3 \
  --reps 5 --warmup 1 --seed 17 --out e4-factors-bun.jsonl)
```

```bash
# E5: one AMG solve per bracket mesh, for the read-out (bench.mjs records maxDisplacement)
(cd <dev>/web && taskset -c 3 node entry-dev.node.mjs --models models --configs rust-amg \
  --only wall-bracket --reps 1 --warmup 0 --seed 19 --out e5-wall-bracket-node.jsonl)
```

```bash
# E6 and E7: the 8 models of E1, today's module with (f08feac…) and without (2bc1a4b…) +simd128,
# loaded side by side (make-entry.mjs --alt nosimd=<dir>), 1 warm-up + 5 timed rounds
M=cantilever-beam_p1_h12.5.json,cantilever-beam_p2_h25.json,cooks-membrane_p2_h2.json,plate-with-hole_p1_h1.json,plate-with-hole_p2_h4.json,wall-bracket_p1_h2.json,wall-bracket_p1_h3.json,wall-bracket_p2_h40.json
C=rust-gs,rust-amg,rust-gs@nosimd,rust-amg@nosimd
(cd <dev>/web && taskset -c 3 node entry-simd.node.mjs --models models --configs $C --only $M \
  --reps 5 --warmup 1 --seed 23 --out e6-simd-node.jsonl)
(cd <dev>/web && taskset -c 3 bun entry-simd.mjs --models models --configs $C --only $M \
  --reps 5 --warmup 1 --seed 29 --out e7-simd-bun.jsonl)
```

```bash
cd benchmarks/solver-speed/results
bun ../analyse.mjs . e1-factors-node.jsonl e2-scaling-node.jsonl e3-develop-node.jsonl e4-factors-bun.jsonl e6-simd-node.jsonl e7-simd-bun.jsonl
bun ../wall-bracket.mjs . e5-wall-bracket-node.jsonl e2-scaling-node.jsonl e3-develop-node.jsonl
```

A pilot run before E1 (2 timed rounds, used to choose the models and the
number of rounds) is not published and not analysed.
