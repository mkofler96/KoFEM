# KoFEM Agent Guidelines

## Test-Driven Development (red → green)

Follow strict red-green TDD for all implementation work:

1. **Red** — write a failing test that specifies the desired behaviour *before* writing any production code. The test must compile and fail for the right reason (not a compile error).
2. **Green** — write the minimal production code needed to make the test pass. Do not add logic beyond what the failing test requires.
3. **Refactor** — clean up duplication and style while keeping the test suite green.

### Practical rules

- Never implement a feature without a corresponding test written first.
- Run `cargo test` (or the relevant test command) after every change to confirm the transition red → green.
- For acceptance criteria given in a GitHub issue, copy the test verbatim into the test module before touching implementation code.
- Prefer small, focused tests over large integration tests so failures pinpoint the broken unit.

## Pull Requests

Always include `closes #<issue-number>` in the PR description body so that merging automatically closes the linked issue on GitHub.
