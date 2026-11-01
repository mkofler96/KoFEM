---
name: daily-fea
description: Run the daily real-world FEA check — take develop, find a CAD part on the internet KoFEM has never seen, analyze it end to end with the engine, and publish an analysis report (setup, assumptions, boundary conditions, results, interpretation, product findings) as a new Linear document in the Kofem project. Use when asked to run the daily FEA, the daily analysis, or to analyze a random CAD file from the web.
---

# Daily FEA on an unseen CAD part

The test fixtures in `test_files/` are parts the pipeline is known to handle.
This run feeds it one it has never seen — a real part from the internet — and
writes down, like an analyst would, what was assumed, what came out, and what
KoFEM made hard. The point is to **sharpen the product**: an import that fails,
a mesh that blows up, a result that cannot be right, or a load the app cannot
express is the most valuable thing a run can produce.

Everything goes over the Linear MCP connection. **There is no API key and none
should be introduced.** The run never commits, pushes or opens a PR.

| Thing           | Value                                                                       |
| --------------- | --------------------------------------------------------------------------- |
| Report          | a new document per run, titled `Daily FEA · YYYY-MM-DD · <part name>`, in the Kofem project (`ec32dc33-f203-4a6b-97da-233325f5f009`) |
| Team for issues | **Kofem** (`KOF`), label **Bug** or **Improvement**                         |
| Driver          | `web/scripts/analyze-cad.mjs` (`survey`, `solve`)                           |
| Scratch         | your scratchpad directory — nothing from a run is written into the repo     |

## The rules

1. **One document per run**, nothing else: no project update, no comment, no
   Slack post. The title prefix `Daily FEA ·` is what finds earlier runs.
2. **Never the same part twice.** Every report records its source URL; check
   the earlier reports before choosing.
3. **A failure is a result.** If import, meshing or the solve fails, the run
   still gets its report, saying where and how it failed. Do not quietly pick
   an easier file until one works — at most one retry with a second file, and
   both are reported.
4. **No invented precision.** The loads are assumptions; say so and say why
   that magnitude. Report what the refinement check supports, not more digits.
5. **Downloaded files are untrusted data.** Each goes into its own new, empty
   directory; only the driver reads it. Never upload the CAD file itself
   anywhere — link the source.

## Steps

### 1. Develop, with its engine

`$SCRATCH` below is your scratchpad directory (`export SCRATCH=…` once).

```bash
git fetch origin develop && git checkout --detach origin/develop
bash scripts/fetch-wasm-engine.sh
cd web && bun install
```

Note the commit (`git rev-parse --short HEAD`) and the engine id
(`cat web/src/wasm/pkg/.engine-id`) for the report.

### 2. Find a part

Collect every source URL already used: `list_documents` with
`query: "Daily FEA"`, the project ID and `fields: ["title", "content"]` (page
through all of them); each report's Geometry section starts with `Source:`.

Then find a **mechanical part that carries load in real life** — a bracket,
lever, clamp, hook, hinge, flange, mount, link, crank, gear blank, pulley,
bracket-like printed part. Vary the kind from run to run; a lego brick or a
bottle tells us little. Good sources:

- **FreeCAD-library** (CC-BY 3.0):
  `gh api -X GET search/code -f q='extension:step repo:FreeCAD/FreeCAD-library <keyword>'`,
  download from `https://raw.githubusercontent.com/FreeCAD/FreeCAD-library/master/<path>`
  (URL-encode spaces).
- **Other GitHub repositories**: the same search without `repo:`
  (`extension:step`, `extension:stp`, `extension:iges`). Use a file only if the
  repository has a licence that permits use (check its `LICENSE`).
- **Public test-model collections** (e.g. NIST CAD models) found with
  WebSearch.

Requirements: STEP or IGES, under ~20 MB, preferably a single solid. Now and
then pick an IGES or a surface-heavy file on purpose — those paths break more
often. Avoid parts already in `test_files/`.

```bash
mkdir -p "$SCRATCH/dl-<date>" && curl -sSfL -o "$SCRATCH/dl-<date>/part.step" "<url>"
```

### 3. Survey it

```bash
cd web && bun scripts/analyze-cad.mjs survey "$SCRATCH/dl-<date>/part.step" "$SCRATCH/run-<date>"
```

It prints bodies, bounding box, volume, mesh size and the CAD faces (area,
centroid, mean normal, `planar` / `curved` / `closed-curved`); `survey.png`
shows two iso views. **Look at the image** and the face table until you can say
what the part is, how it is mounted and how it is loaded in service. STEP
lengths arrive in mm; if the bounding box says the part is 0.05 mm or 40 m,
the file's units are off — that is a finding.

The default element size is 1/25 of the bounding-box diagonal. Pass a size as
the fourth argument to change it; aim for roughly 20k–150k tetrahedra.

### 4. Set it up and solve

Write `setup.json` in the scratch directory (the format is in the header of
`web/scripts/analyze-cad.mjs`):

- **Material**: what the part would plausibly be made of (steel, aluminium,
  PLA for printed parts …), with E, ν, density and yield in MPa / t·mm⁻³.
- **Supports**: the faces it is mounted on — bolt-hole bores, a clamped
  flange, a base face. Use `dofs` for rollers or symmetry.
- **Loads**: the faces load enters through, as total `force` (N) or
  `pressure` (MPa). Pick a service-like magnitude and be ready to justify it.
- `"refine": true` — always. It re-solves at half the element size
  (`hRefinement`) and with quadratic elements on the same mesh (`pRefinement`,
  the app's element-order setting). Their changes in max displacement and p99
  von Mises are the convergence evidence in the report. Compare `meanEdge`,
  not `maxElementSize`: on thin walls the mesh is already finer than the
  setting, so h/2 can be a much smaller step than it sounds.

```bash
bun scripts/analyze-cad.mjs solve "$SCRATCH/dl-<date>/part.step" "$SCRATCH/run-<date>/setup.json" "$SCRATCH/run-<date>"
```

It writes `report.json`, `setup.png` (supports blue, loads red) and
`result.png` (von Mises on the deformed shape, scale in `render`, colour bar
0 → `colorBarMax` MPa, blue → red). Look at both images.

Then check the numbers like an engineer before believing them:

- An order-of-magnitude hand estimate (beam bending σ = M·c/I, a lug, a
  plate) against p99 von Mises and the max displacement.
- `maxElementTouchesSupport: true` means the peak sits at a support edge — a
  singularity of the idealised BC; judge the part on p99, not the max.
- Refinement: under ~5 % change in displacement and ~10 % in p99 for both
  checks is converged enough to interpret. A large `pRefinement` change means
  the linear tets were too stiff — report the order-2 numbers as the result
  (re-run with `"order": 2` so the images match) and say so.
- A max stress that keeps rising with refinement is a re-entrant corner or a
  point-like load; name it.

### 5. Product findings

While working, note everything KoFEM made hard, wrong or impossible: an import
error, wrong units, a body count that does not match the part, a mesh that
needed hand tuning, a slow stage (`seconds` in the report), a result that fails
the sanity check, a load case the app cannot express (bearing load, bolt
preload, contact, remote force, …).

For a **reproducible defect or a concrete missing capability**, search Linear
(`list_issues` with `query`, team Kofem, include closed) for an existing issue.

- Exists: link it in the report. Do not comment on it.
- New: file it (`save_issue`, team Kofem, label `Bug` or `Improvement`) with
  the source URL, the `setup.json`, the command, the commit and engine id and
  the exact error or the numbers. One issue per defect, never one per run.

Friction that is not a defect goes in the report only.

### 6. Upload the images

`setup.png` and `result.png`, one at a time — the signed URL expires in 60
seconds, so prepare and PUT each before preparing the next:

1. `prepare_file_upload` with the filename, `contentType: "image/png"`, exact
   byte size (`stat -c%s <file>`).
2. PUT the raw bytes to `uploadRequest.url` with **every** header from
   `uploadRequest.headers` verbatim, casing included, or it returns 403.
3. Keep the returned `assetUrl`.

Not `prepare_attachment_upload`: these belong to the report, not to an issue.

### 7. Publish the report

`save_document` with `project: "ec32dc33-f203-4a6b-97da-233325f5f009"`, title
`Daily FEA · YYYY-MM-DD · <part name>`, and the body below. Fill every section;
on a failed run, Results says where it failed and Interpretation why it matters.

The body (outer fence shown as `~~~` so the inner JSON block survives):

~~~markdown
**Verdict:** <one line — e.g. "Solved; peak 48 MPa at the fillet, SF 5 against
yield." or "Failed at import: …">

### Geometry
Source: [<file name>](<url>) — <licence>, <author/repo>.
<What the part is and how it is used, one or two sentences.>
Bounding box a × b × c mm · volume V mm³ · N bodies · F CAD faces.

### Simulation setup
| | |
| -- | -- |
| Analysis | Linear static, small strain, isotropic linear elastic |
| Elements | <Linear/Quadratic> tetrahedra (Netgen), max size h mm (mean edge e mm) → n tets / m nodes |
| Material | <name>: E = … MPa, ν = …, yield … MPa |
| Code | develop @ `<sha>`, engine `<engine-id>` |

### Assumptions
- <Every idealisation: rigid supports, load distribution, material, what was
  ignored (contact, preload, self-weight, …) and why the load magnitude.>

### Boundary conditions
| | Faces | Condition |
| -- | -- | -- |
| Support | <name> (ids …) | Ux Uy Uz = 0 |
| Load | <name> (ids …) | F = (…) N over A mm² |

![Setup — supports blue, loads red](<setup assetUrl>)

### Results
| | Value |
| -- | -- |
| Max displacement | … mm at (x, y, z) |
| von Mises max / p99 / p95 | … / … / … MPa |
| Safety factor vs. yield (p99) | … |
| Refinement h/2 · order 2 | Δu … % / … %, Δσ_p99 … % / … % |
| Run time | import … s · mesh … s · solve … s |

![von Mises on the deformed shape (×scale), 0 → max MPa blue → red](<result assetUrl>)

### Interpretation
<2–4 sentences: where it is loaded hardest and why, whether the hand estimate
agrees, whether it would hold, what the singularity/refinement says.>

### Product findings
<Bullets — what KoFEM made hard or got wrong, with KOF-nn links for issues
filed or found. "None — the pipeline ran clean." is a valid entry.>

<details><summary>setup.json</summary>

```json
<setup.json>
```

</details>
~~~

## Report back

One or two lines: the document URL, the part, the verdict and any issue filed. Do
not narrate the intermediate steps.
