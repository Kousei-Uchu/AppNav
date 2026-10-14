# Changelog

All notable changes to this project are documented here. The format follows
Keep a Changelog and the project follows semantic versioning.

## Unreleased

- Dynamic registration now changes the tree in place instead of returning a new tree. Registered screens and edges are flagged `dynamic`.
- Added a shared default tree (`setDefaultTree`, `getDefaultTree`, `setAsDefault`) so registration works without passing a tree around.
- Added `createTree`, `unregisterScreens`, `unregisterEdges` and `clearDynamic`. File screens and edges cannot be removed.
- Registration is all or nothing. A failed call leaves the tree unchanged.
- Registered screens, edges and actions are now validated with the same checks as a parsed graph, so unknown action types, bad payloads, undeclared variables and unknown endpoints are rejected with a `ValidationError`. `{ diagnostics: "collect" }` keeps the valid items instead.
- Exposed `validateScreenRecord` and `validateEdgeRecord`, the per-item checks behind `validateGraph`.
- `registerActions` now requires a name per action (`registerActions(screen, { remove_item: { actions } })`). The name is the node id, so actions on one screen no longer share a default id or pile up duplicate edges. The old bare-array form is rejected.
- Registering an id that already exists is now an error instead of being ignored silently. Added `onDuplicate: "error" | "skip" | "replace"`.
- Action nodes now perform the action on the way in. `registerActions` puts the actions on the edge into the node and makes the edge back to the parent (or `to`) empty with cost 0, so a route that ends at an action node ends with the action. Before, the actions sat on the edge leaving the node and a route to the node told the user to do nothing. Graph files should write `ACTION` nodes the same way.
- Added a repeat count for actions. `DO TAP { ... } repeat=4`, or `repeat=$NAME$` for a number variable the app supplies, and `{ type, data, repeat }` for registered actions. The instruction action carries `repeat` (only when declared), so an app can show "x4" without duplicated steps. Validation rejects counts that are not whole numbers of at least 1 (`INVALID_REPEAT`), and a variable that resolves to a bad count throws a `VariableError`. The runtime runs a repeated action's handler once per repetition and passes `iteration` and `iterations`.
- Edge ids for registered edges are deterministic, with no random suffix.
- Removed the `MutableGraphData` type. The no-tree form of `register_screens` no longer builds an empty tree, and now uses the default tree.

## 0.1.0

Initial release.

- `.navgraph` (NAVGRAPH/2) parser with line and column errors.
- JSON based `.navschema` with `extends`, explicit `overrides` and `remove`.
- Typed variables with defaults, route inputs and runtime values.
- Safe condition language (no eval) with custom word operators.
- A*, Dijkstra and BFS pathfinding with deterministic tie breaking, custom algorithms, cost functions and edge filters.
- Instruction generation with action, step and route extension hooks, dependencies, validation and an error policy.
- Synchronous and asynchronous builders that share one implementation.
- Optional, opt-in action runtime with timeouts, retries and abort support.
- Dual CJS and ESM build with bundled type declarations. No Node only APIs in the core, so it runs in React Native.
