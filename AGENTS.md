# AGENTS.md

Guidance for AI coding agents. Part 1 is for projects that use routegraph. Part 2 is for working on the routegraph repository itself.

## Part 1: Using routegraph in a project

routegraph models an app as a directed graph of screens (`.navgraph` text), finds routes, and emits JSON instructions. Read `llms.txt` in this package for the full cheat sheet, and `README.md` for the reference.

Checklist when generating or editing a `.navgraph`:
1. Start with `NAVGRAPH/2`. Declare every `VAR` that a `$NAME$` reference uses.
2. Declare each `SCREEN` once. Edge endpoints must be declared screens.
3. Write both directions explicitly. Reverse edges are never inferred.
4. Every `DO TYPE` must exist in the active schema, and payloads must satisfy its `required` and `properties`.
5. Costs are non-negative numbers. Use cost for "how bad is this transition", not for action counts.
6. Quote `if=` expressions that contain commas or brackets.
7. Use `repeat=N` or `repeat=$VAR$` after a `DO` payload for "do this N times". Do not write the same `DO` line several times, and remember cost is per edge, not per repetition.
8. Validate with `validateGraph(parseGraph(text))` or `indexTreeFromText(text, { diagnostics: "collect" })` and read `diagnostics` (each has code, line, column).

Checklist when writing code against the API (dynamic graphs):
- Dynamic registration (`registerScreens`, `registerEdges`, `registerActions`) changes the tree in place and returns the same tree. Use `cloneTree` for an independent copy.
- Without a tree argument, registration uses the shared tree set by `setDefaultTree` or `setAsDefault: true`.
- Added items are flagged `dynamic`. Remove them with `unregisterScreens`, `unregisterEdges` or `clearDynamic`. File items cannot be removed.
- Registered screens, edges and actions are validated like a parsed graph. Action types must exist in the tree's schema. Failures throw `ValidationError`; `{ diagnostics: "collect" }` keeps the valid items instead.
- `registerActions(screen, { name: { actions: [...] } })` needs a name per action. Duplicate ids error unless `onDuplicate` is `"skip"` or `"replace"`.
- Registered actions accept `repeat` (a whole number >= 1, or a `$VAR$` the route supplies). It appears on the instruction action as `repeat`.
- Action nodes perform their actions on the edge into the node (`cart -> remove_item`). The edge back is empty and free. Write `ACTION` nodes in files the same way.
- Template copies clone incident edges when `cloneEdges` is true. A registration call is all or nothing.

Checklist when writing code against the API:
- Routes are synchronous. Instruction building is async by default (`buildInstructions`) with a sync twin (`buildInstructionsSync`).
- React Native: use `indexTreeFromText` with bundled text, or pass `readFile` to `indexTree`.
- Extensions are local trusted code passed in `buildInstructions(path, { extensions })`. Never place code in a `.navgraph`.
- Use `tryCalculatePath` when "no route" is an expected outcome.
- Instruction steps carry `kind` (`"navigate"` or `"action"`), `toName`, and for action steps `actionNode`. Use them to word instructions instead of looking screens up again.

## Part 2: Working on this repository

Commands:
- `npm install`
- `npm run typecheck` (strict TS, includes tests)
- `npm test` (vitest, 88 tests)
- `npm run build` (tsup, CJS plus ESM plus d.ts into `dist/`)
- `npm run prepublishOnly` runs all of the above

Layout (`src/`): `parser.ts` (navgraph text to Graph IR), `schema.ts` (default schema, inheritance, payload validation), `graph.ts` (validation, indexing, `NavigationTree`), `conditions.ts` (safe expression language), `variables.ts` (scopes and `$VAR$` resolution), `pathfinding.ts` (A*, Dijkstra, BFS, heap), `extensions.ts` and `instructions.ts` (hooks and builder), `drive.ts` (generator drivers), `runtime.ts` (optional executor), `index.ts` (public exports).

Rules to preserve:
- No Node-only APIs in the core. File access goes through `files.ts` and the `readFile` option. No `require`, no dynamic `import()` with variables (Metro rejects them).
- Sync and async builders share one generator implementation in `drive.ts`. Do not fork logic between them.
- Parser and pathfinder stay deterministic. Tie breaking is by estimate, heuristic, then discovery order.
- Output stays plain JSON. Extension output is namespaced and validated.
- Graph files never execute code.
- Copy and docs style: plain prose, no em dashes, no emoji, no ASCII art.
- New behavior needs a test in `tests/`. Keep `npm run typecheck` clean.
