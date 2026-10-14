# Changelog

All notable changes to this project are documented here. The format follows
Keep a Changelog and the project follows semantic versioning.

## 0.2.0 - 2026-10-14

- Added a VS Code extension for `.navgraph` and `.navschema` files in `packages/vscode`: live validation, hover and go to definition, completions and an outline, an interactive graph preview, and route finding between two screens. The extension bundles the library, is private, and is not published to npm.
- Added dynamic registration (`registerScreens`, `registerEdges`, `registerActions`, `cloneTree`, instance methods and snake case aliases) so a tree can be extended from code at runtime, with templates for repeated copies such as one screen per product.
- Added `NavGraphWatcher` in `src/react.tsx`, a component that reloads a graph file when it changes on disk, with an example in `examples/watcher.tsx`.
- Added `tools/scan-app.js`, a source scanner that drafts a `.navgraph` from navigation calls, screen components and action calls in an existing app.

## 0.1.0 - 2026-10-13

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
