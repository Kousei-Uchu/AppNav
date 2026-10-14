# routegraph-devtools

Optional helpers that live outside the core `routegraph` package. Nothing here is published with it.

- `scan-app.js` scans source files for `navigation.navigate(...)`, `router.push(...)` and `<Stack.Screen name="..." />`, and writes a proposed `.navgraph` fragment (default `proposed.extend.navgraph`) listing the screens it found. It does not read or diff an existing graph. Review the output and merge it by hand.

  ```sh
  node packages/devtools/scan-app.js src --out proposed.extend.navgraph
  ```

- `watcher.tsx` is a small React component, `NavGraphWatcher`. Wrap your app root in development and it logs an edge line to the console for each click on an element with a `data-screen` attribute. It writes no file. Copy the lines you want into your graph.
