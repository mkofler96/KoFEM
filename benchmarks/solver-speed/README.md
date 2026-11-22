# Solver-speed study: where the v0.7.0 speed-up came from

v0.7.0 moved every solve from the C++ engine (MFEM 4.7, Emscripten) to KoFEM's
Rust module, and made algebraic multigrid (AMG) the default preconditioner for
solids. The release notes measured it as 1.4 to 40 times faster. This study
splits that factor into its causes, one controlled change at a time:

| Factor                           | Compared                                                      | Held fixed                             |
| -------------------------------- | ------------------------------------------------------------- | -------------------------------------- |
| Asyncify                         | the shipped C++ build against the same build without Asyncify | everything else                        |
| Optimisation level               | KoFEM's C++ at `-O2` (shipped) against `-O3`                  | everything else                        |
| Implementation (C++/MFEM → Rust) | MFEM's PCG with symmetric Gauss–Seidel against Rust's         | algorithm, preconditioner, mesh, loads |
| SIMD                             | the Rust module with and without `+simd128`                   | everything else                        |
| Algorithm                        | Rust PCG with Gauss–Seidel against Rust PCG with AMG          | implementation                         |

The results, with tables and confidence intervals, are in
[`results/results.md`](results/results.md), and the raw records of every solve
in `results/*.jsonl`.

## Models

Three scientific benchmarks, the validation cases on the example pages, meshed
by their recipes at the levels of their convergence studies
(`examples/validation/convergence.mjs`):

- **Plate with a hole** (Kirsch/Howland), linear and quadratic tetrahedra;
- **Cantilever beam** (Euler–Bernoulli), linear and quadratic;
- **Cook's membrane** (Cook 1974), linear and quadratic.

One real-world part: the **wall bracket**, the app's guided sample
(`web/public/samples/wall-bracket.step`): bolt holes fixed, 2 kN down on the
hub bore, steel, at maximum element sizes 40, 20, 3, 2.5 and 2 mm (linear)
and 40, 20 and 3 mm (quadratic). Its mesh is set by its fillets and holes, not
by the maximum element size, until that drops below about 3 mm, so the sizes
are chosen where the element count actually grows.

`export-models.mjs` builds each model once through the validation pipeline and
writes the app's solve payload: every solver gets exactly the same mesh,
supports and loads. Couplings and the crane holder are left out.

## Method

**Builds.** The C++ side is the last commit that still had it, `1963c81`.
`build-engine-variant.sh` rebuilds its engine with one factor changed. The
shipped configuration rebuilt this way is byte for byte the published engine
`engine-d92699c9ed8f` (SHA-1 `9c806f9f…`), so the variants differ from what
users ran in the named factor only. As shipped, MFEM's kernels (sparse
matrix–vector product, Gauss–Seidel, CG) are prebuilt at `-O3`; KoFEM's glue
compiles at `-O2` (the CMake Release `-O3` is overridden by the target's
`-O2`); the link optimises at `-O3` and applies Asyncify to the CG loop. No
part is built with SIMD.

| Variant    | KoFEM C++ | Asyncify | `kofem_wasm_emcc.wasm` SHA-1               |
| ---------- | --------- | -------- | ------------------------------------------ |
| A, shipped | `-O2`     | on       | `9c806f9faf3332d915e1965ac47fce5d30bb10db` |
| B          | `-O2`     | off      | `32d8a6c4068d0dea3791ec997c61b6e4e6648e5c` |
| C          | `-O3`     | on       | `6b8e8deb3ea0a70b84aa711b5f2fe11bf6b56c47` |
| D          | `-O3`     | off      | `5f4af98302a9a3615d1f3a601d9e8cf68ddd6d43` |

The Rust side of the factor study is the Rust module of the same commit, so
both solve the same problem: they agree to 10⁻⁸ in displacement on every
model (`maxRelDiffToFirst` in the records).

**What is timed.** One solve call each, from the solve payload to the
displacements: assembly, eliminating the supports, preconditioner set-up, the
PCG iterations and the stress recovery. Meshing is excluded. The phases come
from the timestamps of the lines each solver logs (the C++ engine prints
synchronously). Both solvers stop at a relative tolerance of 10⁻⁶, but on
different norms: MFEM on the preconditioned residual, Rust on the force
residual ‖f − K·u‖/‖f‖, which takes 3–7 % more iterations. Time per iteration
compares the implementations independently of that.

**Design.** For each model: one untimed warm-up round, then five timed
rounds. In every round each configuration runs once, in a fresh random order
(seeded), so drift of the machine spreads over all configurations instead of
biasing one. Each C++ solve gets a fresh engine instance, as the app's worker
does. The process is pinned to one core (`taskset -c 3`).

**Statistics.** A factor's effect on one model is the ratio of the medians of
two configurations that differ in that factor only, with a 95 % percentile
bootstrap interval (10 000 resamples of the rounds). Across models the effect
is the geometric mean of the ratios, bootstrapped over models and rounds.

**Runtimes.** The browser runs WebAssembly in its JavaScript engine. Node
(V8, as in Chrome and Edge) is the primary runtime; Bun (JavaScriptCore, as in
Safari) repeats the factor study.

**Machine.** A cloud VM: Intel Xeon at 2.1 GHz, 4 vCPUs, 15 GB, Linux 6.18.
It is shared, which adds noise that no design removes; the bootstrap intervals
show how much. Toolchains: Emscripten 4.0.20, Rust 1.100.0, wasm-bindgen
0.2.129, Node 22.16.0 (V8 12.4), Bun 1.4.4.

## Reproduce

From the repository root, with the WASM dependencies installed
(`scripts/fetch-wasm-deps.sh`):

```bash
git worktree add ../kofem-1963c81 1963c81
(cd ../kofem-1963c81/web && bun install && bun run wasm:prepare)
for v in "A-shipped O2 on" "B-O2-noasync O2 off" "C-O3-async O3 on" "D-O3-noasync O3 off"; do
  set -- $v; benchmarks/solver-speed/build-engine-variant.sh ../kofem-1963c81 ../variants "$1" "$2" "$3"
done
(cd web && bun ../benchmarks/solver-speed/export-models.mjs ../../models)
(cd ../kofem-1963c81/web && bun ../../KoFEM/benchmarks/solver-speed/make-entry.mjs .. ../../entry.mjs --with-mfem)
bun build ../entry.mjs --target=node --format=esm --outfile ../entry.node.mjs
(cd ../kofem-1963c81/web && taskset -c 3 node ../../entry.node.mjs --models ../../models --variants ../../variants \
  --configs mfem:A-shipped,mfem:B-O2-noasync,mfem:C-O3-async,mfem:D-O3-noasync,rust-gs,rust-amg \
  --reps 5 --warmup 1 --seed 7 --out ../../runs.jsonl)
bun benchmarks/solver-speed/analyse.mjs benchmarks/solver-speed/results ../runs.jsonl
```

`results/commands.md` lists the exact runs behind the published results.
