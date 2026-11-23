# Source

From `skills/architect` in [backnotprop/pstack](https://github.com/backnotprop/pstack/tree/c3464c11c60b1352d5e8f5f0428a3a6943837568/skills/architect) (a mirror of `cursor/plugins/pstack`)
at commit `c3464c11c60b1352d5e8f5f0428a3a6943837568` (MIT, see `LICENSE`).

This copy is **modified** for KoFEM:

- The pointer to the `arena` skill (not vendored) is removed.

`disable-model-invocation: true` is dropped so the skill loads when its description matches; upstream relies on `poteto-mode`, which is not vendored, to load it.

The entry at `.agents/skills/architect` links to this directory for Codex discovery.
