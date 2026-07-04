# Self-hosted web fonts

Self-hosted copies of the fonts previously loaded from the Google Fonts CDN
(the external requests made page load depend on a third-party host and broke
Playwright runs in offline/sandboxed environments).

| Family                   | Weights            | Used by                    |
| ------------------------ | ------------------ | -------------------------- |
| Geist / Geist Mono       | 400–700 / 400, 500 | landing page (`/`)         |
| IBM Plex Sans / Plex Mono | 400–600 / 400, 600 | solver app (`/app/`)       |

Only the `latin` and `latin-ext` subsets are included. The `.css` files are
the Google Fonts `css2` responses with the `fonts.gstatic.com` URLs rewritten
to `/fonts/*.woff2`.

All four families are licensed under the SIL Open Font License 1.1:

- Geist / Geist Mono — © Vercel, <https://github.com/vercel/geist-font>
- IBM Plex — © IBM, <https://github.com/IBM/plex>
