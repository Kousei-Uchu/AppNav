# CLAUDE.md

@AGENTS.md

## Notes for Claude

- If asked about the `routegraph` package, read `llms.txt` first. It is a complete cheat sheet and is accurate for this version.
- When writing a `.navgraph`, validate it before presenting it: run `validateGraph(parseGraph(text))` or build the tree with `diagnostics: "collect"` and fix every error.
- Prefer `indexTreeFromText` and `buildInstructionsSync` in React Native examples unless extensions are async.
- Do not invent actions. Check the active schema; the default set is TAP, LONG_PRESS, TYPE, SWIPE, SCROLL, BACK, WAIT, SET_STATE, ASSERT.
- When changing the repo, run `npm run typecheck && npm test` before finishing.
