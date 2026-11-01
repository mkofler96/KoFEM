# Self-hosted web fonts

Self-hosted copies of the fonts previously loaded from the Google Fonts CDN
(the external requests made page load depend on a third-party host and broke
Playwright runs in offline/sandboxed environments).

| Family                    | Weights            | Used by                                                    |
| ------------------------- | ------------------ | ---------------------------------------------------------- |
| Geist / Geist Mono        | 400–700 / 400, 500 | landing page (`/`), example pages (`/examples/`)           |
| IBM Plex Sans / Plex Mono | 400–600 / 400, 600 | solver app (`/app/`)                                       |
| KoFEM Math                | 400                | example pages (`/examples/`): equations and figure symbols |

Only the `latin` and `latin-ext` subsets are included. The `.css` files are
the Google Fonts `css2` responses with the `fonts.gstatic.com` URLs rewritten
to `/fonts/*.woff2`.

Geist and IBM Plex are licensed under the SIL Open Font License 1.1:

- Geist / Geist Mono — © Vercel, <https://github.com/vercel/geist-font>
- IBM Plex — © IBM, <https://github.com/IBM/plex>

`kofem-math.woff2` (family "KoFEM Math") is a subset of New Computer Modern
Math 3.00, © 2019–2021 Antonis Tsolomitis, released under the GUST Font
License (<http://tug.org/fonts/licenses/GUST-FONT-LICENSE.txt>). It gives the
MathML equations on the example pages the LaTeX (Computer Modern) look and
keeps the font's OpenType MATH table. Source: `files/fonts/NewCMMath-Regular.otf`
at tag `v0.13.1` of <https://github.com/typst/typst-assets> (SHA-256
`bfd2f9b22caacd41b8b29cfe3f6d72f976f221a65362e07eda35cbae863721b7`). As the
license requests for modified versions, the subset is renamed. It was made with
fontTools:

```sh
pyftsubset NewCMMath-Regular.otf --flavor=woff2 --layout-features='*' \
  --name-IDs='*' --name-languages='*' --notdef-outline \
  --unicodes="U+0020-007E,U+00A0-00FF,U+0391-03A9,U+03B1-03C9,U+03D1,U+03D5,U+03F0,U+03F1,U+03F5,U+2000-206F,U+2070-209F,U+210E,U+2190-21FF,U+2200-22FF,U+2308-230B,U+239B-23B3,U+27E8-27E9,U+1D434-1D467,U+1D6E2-1D71B"
```

then the name table (IDs 1–6) set to "KoFEM Math" / `KoFEMMath-Regular`, with
a description (ID 10) naming the original. Characters outside these ranges fall
back to the browser's own math font.
