# RouteGraph for VS Code

Editor support for `.navgraph` files from [routegraph](https://github.com/Kousei-Uchu/routegraph). The extension bundles the library, so it parses and validates exactly like your build does. Nothing to install in your project.

## What you get

**Live validation.** Syntax errors, unknown screens, bad conditions, wrong action payloads and undeclared variables show up as you type, with line and column. A `.navschema` next to the graph with the same name (`app.navgraph` and `app.navschema`) is picked up automatically.

**Hover and go to definition.** Hover a screen id to see its name and where it leads. Hover `$PRODUCT_ID$` to see the variable's type and default. Go to definition works on both.

**Outline and completions.** Screens, variables and edges appear in the outline. Completions cover action types (inserted with their required properties), screen ids after `->`, variable types, and `$` inside strings.

**Graph preview.** Run `RouteGraph: Open Graph Preview` or use the button in the editor title bar. Click a screen or edge to jump to its line. Drag to pan, scroll to zoom. Screens the first screen cannot reach have dashed borders. Pick two screens and select Find route to see the route numbered on the graph, with the steps listed beside it.

**Routes.** `RouteGraph: Find Route Between Screens` lists the steps in the RouteGraph output channel and highlights them in the preview. `RouteGraph: Copy Route Instructions as JSON` puts the same instruction tree your app would generate on the clipboard. It asks for values only for variables that have no default and that the route actually uses.

**`.navschema` files** get JSON validation and completion from the schema that ships with routegraph.

## Settings

| Setting | Default | Purpose |
| --- | --- | --- |
| `routegraph.schema` | empty | Schema file for every graph. When empty, a sibling `.navschema` is used if there is one. |
| `routegraph.algorithm` | `astar` | `astar`, `dijkstra` or `bfs`. |
| `routegraph.routeVariables` | `{}` | Values for conditions when finding routes, for example `{ "SIGNED_IN": true }`. |
| `routegraph.strictConditions` | `false` | Report condition names that are not declared with `VAR`. |
| `routegraph.validateOnType` | `true` | Validate while typing instead of on save. |

Edges with an `if=` condition only count as available when the condition is true under `routegraph.routeVariables` and the defaults declared in the graph.

## Install

Build the package and install it:

```
npm install
npm run package
code --install-extension routegraph-vscode-0.1.0.vsix
```

`npm run package` type checks, runs the tests, bundles the extension and writes the `.vsix`.

## Develop

```
npm install
npm run watch
```

Then press F5 in VS Code with this folder open to start an Extension Development Host. The parsing, validation and route logic lives in `src/analysis.ts` and has no VS Code dependency, so it is covered by plain unit tests. The preview runs in a webview from `media/preview.js` and is tested with jsdom.

## Notes

- `.navschema` files are treated as JSON through a `files.associations` default contributed by this extension. If your workspace overrides `files.associations`, add `"*.navschema": "json"` yourself.
- The preview lays out screens by distance from the first declared screen. Large graphs with many cross links will have crossing lines. Use the hover highlight to follow a single screen.

MIT licensed.
