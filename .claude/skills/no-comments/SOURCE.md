# Source

From `skills/no-comments` and `agents/comment-sicko.md` in [backnotprop/pstack](https://github.com/backnotprop/pstack/tree/c3464c11c60b1352d5e8f5f0428a3a6943837568/skills/no-comments) (a mirror of `cursor/plugins/pstack`)
at commit `c3464c11c60b1352d5e8f5f0428a3a6943837568` (MIT, see `LICENSE`).

This copy is **modified** for KoFEM:

- `references/comment-sicko.md` is the upstream `agents/comment-sicko.md` prompt, spawned as a general subagent; there is no separate agent definition.
- The base branch is `develop`, not `main`.
- References to `poteto-mode`, `why`, `arena` and `principle-redesign-from-first-principles` (not vendored) are replaced with `git log -S`, `git blame`, the Linear issue, and the vendored `architect` and `principle-fix-root-causes` skills.
- Keep-list made concrete for KoFEM: SPDX headers, OCCT/Netgen/wasm-bindgen behaviour, `///` docs on public crate items.
- `KOF-nn` tags are kept: a deleted comment leaves its tag as one line.
- Comments naming removed code (the C++ solver files, MFEM) are deleted or corrected.
- `kofem/no-silent-fallback` exemptions on solver input are `MUST KILL`; the running-sum identity case flags the rule instead.
- A behaviour fix starts with a failing test, per `AGENTS.md`.

`disable-model-invocation: true` is dropped only from the principle skills; `no-comments` keeps it and runs only when asked.

The entry at `.agents/skills/no-comments` links to this directory for Codex discovery.
