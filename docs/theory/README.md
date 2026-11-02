# KoFEM Theory Guide

The Theory Guide explains the mathematics and numerical choices behind the
production C++/WASM solver. It is planned as short, linked articles rather than
one long manual.

- [`content-map.md`](content-map.md) owns the reading order, stable URL plan,
  implementation inventory, notation and unit audit, and running benchmark.
- [`article-template.md`](article-template.md) is the required starting point
  for an article.

Public articles live under `/theory/`, with source modules in `web/theory/`.
The initial representative article is `foundations/model-and-units`; remaining
topics stay marked as planned until their articles are reviewed and published.
Run `cd web && bun run theory:generate` after editing, and commit generated
HTML and sitemap. `bun run test:theory` checks output and content-map alignment.

Articles use the existing examples' native MathML renderer (`tex` / `texBlock`)
and self-hosted math font. Its supported TeX subset is documented in
`examples/validation/lib/tex.mjs`; unsupported commands throw at generation.
Accompany equations with prose and local symbol anchors; link shared symbol
definitions when the notation article is published. Wrap display math in a
labelled, focusable `.equation` region so long expressions scroll by keyboard.
Sections use explicit permanent IDs, code uses `pre`/`code`, and figures have
alt text and captions. Never copy measured results from the generated examples.

These files version with the code; Linear remains the source of truth for
issue planning and architecture decision records (ADRs).
