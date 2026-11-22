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
| SIMD                             | today's Rust module with and without `+simd128`               | everything else                        |
| Algorithm                        | Rust PCG with Gauss–Seidel against Rust PCG with AMG          | implementation                         |

The full tables, with a 95 % confidence interval on every ratio, are in
[`results/results.md`](results/results.md) and
[`results/wall-bracket.md`](results/wall-bracket.md). The raw record of every
solve is in `results/*.jsonl`, and [`results/commands.md`](results/commands.md)
lists the runs.

## Results

A ratio is the time of the first configuration over the second, as a
geometric mean over the models with its 95 % bootstrap interval. Above 1 means
the first is slower; an interval that contains 1 is no detectable effect.

| Factor                                   | Node (V8), 8 models | Bun (JavaScriptCore), 3 models |
| ---------------------------------------- | ------------------- | ------------------------------ |
| Asyncify, at `-O2`                       | 1.03 [0.97, 1.09]   | 1.18 [1.03, 1.29]              |
| Asyncify, at `-O3`                       | 0.99 [0.94, 1.06]   | 1.14 [0.97, 1.28]              |
| `-O2` against `-O3`, with Asyncify       | 1.02 [0.96, 1.09]   | 0.99 [0.93, 1.05]              |
| `-O2` against `-O3`, without Asyncify    | 0.98 [0.94, 1.05]   | 0.96 [0.89, 1.01]              |
| SIMD off against on, Rust Gauss–Seidel   | pending             | pending                        |
| SIMD off against on, Rust AMG            | pending             | pending                        |
| C++/MFEM against Rust, same Gauss–Seidel | 1.25 [1.11, 1.46]   | 1.52 [0.98, 1.94]              |
| … time per iteration                     | 1.05 [0.99, 1.14]   | 1.14 [0.99, 1.26]              |
| … assembly                               | 8.5 [7.3, 9.9]      | 12.3 [5.5, 20.1]               |
| Gauss–Seidel against AMG, Rust           | 3.4 [2.5, 5.0]      | 3.8 [1.7, 11.2]                |
| Shipped C++ against Rust AMG             | 4.2 [3.4, 5.8]      | 5.7 [3.2, 10.6]                |

- **Asyncify and `-O3`** make no detectable difference on V8. On
  JavaScriptCore Asyncify costs about a quarter on the two linear models and
  nothing detectable on the quadratic one; three models are too few to say
  more, and we have not traced why.
- **SIMD** is being measured (runs E6 and E7 in `results/commands.md`).
- **Rust against C++, same algorithm**: Rust assembles the stiffness matrix
  about 8 times faster (specialised tetrahedron kernels against MFEM's general
  integrator), but iterates at about the same speed: the PCG iterations are
  memory-bound sparse products and a sequential Gauss–Seidel sweep in both.
  Rust takes 4 % more iterations because it stops on the force residual.
- **AMG** is most of the speed-up. Over all 29 models (scaling run) the
  change users saw, shipped C++ to Rust AMG, is 4.3 [3.4, 5.3] times, from
  2.0 (coarsest linear bracket) to 16.5 (finest quadratic Cook's membrane).
  It grows with model size for quadratic elements, as DOF^0.36 [0.24, 0.48],
  but not detectably for linear ones (DOF^0.04 [−0.04, 0.15]). For linear
  elements two trends cancel: AMG's lead over Gauss–Seidel grows
  (DOF^0.15 [0.04, 0.26]), while Rust's assembly advantage weighs less as the
  iterations take over.
- **Today's Rust module** (`develop`) gives the same Gauss–Seidel against AMG
  factor as the one that shipped: 3.2 [2.5, 4.2] over the 29 models.
- **The wall bracket**, the real-world case: getting its largest displacement
  within 5 % of the finest quadratic mesh takes 8.7 s with v0.6 (quadratic
  elements at 40 mm) and 2.5 s with v0.7; within about 1 %, 102 s against
  11 s. Linear elements stay above 7 % on every mesh up to 98 000 DOF.

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

The SIMD runs load a second build of today's Rust module next to the first,
so both are randomised within the same rounds:

```bash
RUSTFLAGS="-C target-feature=-simd128" CARGO_TARGET_DIR=../target-nosimd \
  cargo build --locked --release --package kofem-wasm --target wasm32-unknown-unknown
wasm-bindgen --target web --out-dir ../fem-nosimd ../target-nosimd/wasm32-unknown-unknown/release/kofem_wasm.wasm
(cd web && bun ../benchmarks/solver-speed/make-entry.mjs .. ../../entry-simd.mjs --alt nosimd=../../fem-nosimd)
```

`results/commands.md` lists the exact runs behind the published results.
