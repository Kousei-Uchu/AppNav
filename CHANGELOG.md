# Changelog

All notable changes to this project are documented here. The format follows
Keep a Changelog and the project follows semantic versioning.

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
