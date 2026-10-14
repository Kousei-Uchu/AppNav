# routegraph

Typed navigation graphs for apps. Describe your screens and the transitions between them in a small text format, ask for a route, and get back a plain JSON instruction tree you can use for tutorials, UI automation, narration, analytics, or anything else.

- Compact `.navgraph` format that is easy to read, diff, and generate with an LLM.
- Deterministic parsing, validation, and pathfinding (A*, Dijkstra, BFS, or your own). No LLM is ever involved in finding a route.
- Typed variables with `$NAME$` substitution.
- Extension hooks that add data to actions, steps, or whole routes while the instructions are generated.
- Works the same in React Native, browsers, and Node. Every entry point that can be synchronous has a synchronous form.
- Zero runtime dependencies, dual ESM and CommonJS build, full TypeScript declarations.

routegraph does not drive a UI by itself. An optional runtime is included if you want to execute instructions through handlers you register.

## Working with AI assistants

The package ships `llms.txt` (a complete cheat sheet), `AGENTS.md`, and `CLAUDE.md`. Assistants that read `node_modules/routegraph` pick up the format, API, and common mistakes without further prompting. Point other tools at `node_modules/routegraph/llms.txt`.

## Install

```sh
npm install routegraph
```

Requires Node 18 or newer for tooling. The library itself uses only ES2020 features and no Node APIs, so it runs on Hermes and in browsers.

## Quick start

`example.navgraph`:

```
NAVGRAPH/2
APP "Example Store"

VAR PRODUCT_ID : string
VAR QUANTITY : number = 1

SCREEN home "Home"
SCREEN shop "Shop"
SCREEN product "Product Details"
SCREEN cart "Cart"

home -> shop { DO TAP { "target": "Shop" } }
shop -> home { DO BACK {} }
shop -> product {
  DO TAP { "target": "Product Card", "match": { "productId": "$PRODUCT_ID$" } }
  DO WAIT { "until": "screen:product", "timeoutMs": 5000 }
}
product -> cart {
  DO TAP { "target": "Add to Cart" }
  DO SET_STATE { "key": "cart.quantity", "value": "$QUANTITY$" }
}
END
```

```ts
import * as AppNav from "routegraph";

const tree = await AppNav.indexTree("./example.navgraph");

const path = AppNav.calculatePath(tree, "home", "cart", AppNav.ASTAR, {
  variables: { PRODUCT_ID: "PRODUCT_123" },
});

const instructions = await AppNav.buildInstructions(path);
console.log(JSON.stringify(instructions, null, 2));
```

Named imports and the namespace object both work:

```ts
import { indexTree, calculatePath, buildInstructions, AppNav } from "routegraph";
```

## React Native

React Native has no filesystem API in the JavaScript runtime, so there are two ways to load a graph.

**1. Bundle the text and use the synchronous API.** This is the simplest option and needs no async code at all.

```ts
import { indexTreeFromText, calculatePath, buildInstructionsSync } from "routegraph";
import graphText from "./app.navgraph.txt"; // or a plain .ts file that exports a string

const tree = indexTreeFromText(graphText);
const path = calculatePath(tree, "home", "cart", "astar", { variables: { PRODUCT_ID: "42" } });
const instructions = buildInstructionsSync(path);
```

Metro does not load `.navgraph` files out of the box. Either export the text from a `.ts` file, or add the extension to `metro.config.js` with a small transformer for raw text.

**2. Supply a `readFile` function and use the async API.** Any function that returns a promise of a string works.

```ts
import * as FileSystem from "expo-file-system";
import { indexTree } from "routegraph";

const tree = await indexTree(`${FileSystem.documentDirectory}app.navgraph`, {
  readFile: (p) => FileSystem.readAsStringAsync(p),
  schema: `${FileSystem.documentDirectory}app.navschema`,
});
```

`readFile` is also used for schema files and schema `extends` chains.

### Sync and async at a glance

| Task | Synchronous | Asynchronous |
| --- | --- | --- |
| Load a graph | `indexTreeFromText(text, options)` | `indexTree(path, options)` |
| Load a schema | `resolveSchema(definition)` | `loadSchema(pathOrDefinition)` |
| Find a route | `calculatePath`, `tryCalculatePath` | not needed, always synchronous |
| Build instructions | `buildInstructionsSync(path, options)` | `buildInstructions(path, options)` |
| Execute instructions | `runtime.executeSync(instructions)` | `runtime.execute(instructions)` |

`buildInstructions` always returns a promise, so you never have to guess. `buildInstructionsSync` throws an `AsyncExtensionError` if an extension hook returns a promise. Both are driven by the same generator, so their behavior cannot drift apart.

## The .navgraph format

```
NAVGRAPH/2                      header, required, first non-comment line
APP "Name"                      optional
VAR NAME : type [= json]        zero or more
SCREEN id "Display Name" [{json metadata}]
src -> dst [attrs] [{ DO TYPE {json} ... }]
END                             optional, nothing may follow it
```

General rules:

- Comments start with `#` and run to the end of the line. A `#` inside a string is not a comment.
- Whitespace and line breaks are free between tokens. `APP`, `VAR`, and `SCREEN` declarations must end at a line break.
- Strings are JSON strings, so JSON escapes apply. JSON payloads may span many lines.
- Screen ids match `[A-Za-z_][A-Za-z0-9_.:]*`. Variable names match `[A-Za-z_][A-Za-z0-9_]*`.
- Edges are directed. Reverse travel needs its own edge. Nothing is ever inferred.
- An edge with no block has no actions, which is valid. `DO BACK` without braces is the same as `DO BACK {}`.
- Several edges may connect the same pair of screens. Each edge has a unique id: the one you give it with `id=`, or `src->dst`, with `#2`, `#3` and so on added for repeats.

### Edge attributes

```
a -> b [cost=2, if=SIGNED_IN, id=hop, label="Go", weight=7]
```

| Attribute | Meaning |
| --- | --- |
| `cost` | Finite number, zero or more. Default is 1, changeable with the `defaultCost` option. |
| `if` | Condition expression. The edge is only available when it is true. |
| `id` | Explicit unique edge id. |
| anything else | Free metadata, stored on `edge.meta`. Can be validated by a schema. |

The cost belongs to the edge, not to the actions. An edge with three actions and `cost=3` is still one transition.

### Conditions

Conditions use a small, safe expression language. There is no `eval` and no JavaScript.

```
expr    := or
or      := and (("||" | "or") and)*
and     := not (("&&" | "and") not)*
not     := ("!" | "not") not | compare
compare := primary [op primary]            op: == != < <= > >=  or a word operator
primary := "text" | 'text' | number | true | false | null | path | "(" expr ")"
path    := name ("." name)*
```

Names are looked up in the route variables first, then in the `state` object you pass to `calculatePath`. Dotted paths walk into objects. A flat state key such as `"cart.notEmpty"` also works.

Unknown values are `undefined`. Undefined is falsy, every comparison with undefined is false except `!=`, which is true. Pass `strictConditions: true` to throw instead.

Built in word operators are `in` and `contains`. Add your own:

```ts
calculatePath(tree, "home", "admin", "astar", {
  state: { role: "staff" },
  conditionOperators: { startsWith: (l, r) => String(l).startsWith(String(r)) },
});
```

Conditions inside `[...]` that contain a comma or square bracket should be quoted: `if="role in roles"`.

## Variables

```
VAR USER_NAME : string = "Aspen"
VAR PRODUCT_ID : string
VAR QUANTITY : number = 3
```

Types are `string`, `number`, `boolean`, `null`, `object`, `array`, and `any`. A variable without a default is required whenever something needs its value.

Substitution happens inside action payload strings:

| Payload value | Result with `PRODUCT_ID="SKU-123"`, `QUANTITY=3` |
| --- | --- |
| `"$QUANTITY$"` | `3` (the native number) |
| `"Product $PRODUCT_ID$"` | `"Product SKU-123"` (interpolated text) |
| `"$$PRODUCT_ID$$"` | `"$PRODUCT_ID$"` (escaped literal) |
| `"costs $5"` | `"costs $5"` (a lone `$` is left alone) |

A string that is exactly one reference gets the variable's native type. Embedded references use the string form, with objects and arrays written as JSON. Only values are substituted, never object keys. Undefined variables and missing required values throw a `VariableError` instead of producing an empty string.

Precedence, lowest to highest:

1. Defaults declared in the graph.
2. Route inputs (`variables` option).
3. Runtime values (`runtime` option).

Supplied values for declared variables are type checked. Values for undeclared variables are accepted unless you pass `strictVariables: true`. The graph validator rejects payload references to undeclared variables by default.

Extension configuration is a separate scope. It never changes route variables.

## Schemas

A schema declares which action types are valid and what their payloads look like. A bundled default covers `TAP`, `LONG_PRESS`, `TYPE`, `SWIPE`, `SCROLL`, `BACK`, `WAIT`, `SET_STATE`, and `ASSERT`. Add your own:

```json
{
  "schemaVersion": 1,
  "name": "my-app",
  "extends": "default",
  "actions": {
    "SCAN_QR": {
      "description": "Project specific QR scan action",
      "required": ["camera"],
      "properties": {
        "camera": { "type": "string" },
        "timeoutMs": { "type": "number" }
      }
    }
  },
  "edgeMetadata": { "label": { "type": "string" } },
  "screenMetadata": { "icon": { "type": "string" } }
}
```

```ts
const tree = await indexTree("./app.navgraph", { schema: "./app.navschema" });
// or, with no filesystem:
const tree = indexTreeFromText(text, { schema: mySchemaObject });
```

Inheritance rules:

- Adding an action is always allowed.
- Redefining an inherited action with an identical definition is allowed.
- Redefining it differently is an error unless the action is listed in `overrides`.
- Removing an inherited action requires listing it in `remove`.
- `extends` can be `"default"`, the name of a schema registered with `registerSchema`, or (with `loadSchema`) a file path.

Property definitions support `type` (including `integer`, and arrays of types), `enum`, `minimum`, `maximum`, `required`, `properties`, `additionalProperties`, and `items`. Unknown properties are allowed by default so payloads can carry extra data. Set `"additionalProperties": false` to forbid them. A JSON Schema for editor support is shipped at `routegraph/schemas/navschema-v1.schema.json`.

A schema describes what is valid. It does not implement anything. Declaring `SCAN_QR` does not give you a camera.

## Validation and diagnostics

`indexTree` and `indexTreeFromText` validate by default and throw a `ValidationError` that carries every diagnostic. For tooling, use collect mode or validate directly:

```ts
const tree = indexTreeFromText(text, { diagnostics: "collect" });
tree.diagnostics; // errors and warnings with file, line, column, and ids

const result = validateGraph(parseGraph(text), schema);
if (!result.ok) console.log(result.errors);
```

Checks include: unsupported version, duplicate screens, edges, and variables, unknown screens in edges, invalid or negative costs, invalid conditions and operators, unknown action types, missing or mistyped payload properties, undeclared variables, and variables whose declared type does not fit the payload property.

Every thrown error extends `AppNavError` and has `code`, and where possible `file`, `line`, `column`, and `ids`.

## Pathfinding

```ts
const path = calculatePath(tree, "home", "checkout", AppNav.ASTAR, options);
```

Algorithms: `ASTAR` (default), `DIJKSTRA`, `BFS` (fewest edges, ignores cost for the search), or any function matching `PathfindingAlgorithm`. Register one by name with `registerAlgorithm`.

Options:

| Option | Purpose |
| --- | --- |
| `variables`, `runtime`, `state` | Context for conditions. |
| `heuristic(from, goal, tree)` | A* heuristic. Must be admissible for optimal routes. Defaults to 0, which makes A* behave like Dijkstra. |
| `costFn(edge)` | Replace edge costs, for example to penalise risky transitions. Must be finite and non-negative. |
| `edgeFilter(edge)` | Veto edges. |
| `conditionOperators`, `strictConditions` | Condition behavior. |

Notes:

- `calculatePath` throws `NoPathError` when there is no route. `tryCalculatePath` returns `{ ok: true, path }` or `{ ok: false, error }` instead.
- Ties are broken deterministically: lower total estimate, then lower heuristic, then the order edges were discovered, which follows declaration order. Equal inputs always give the same route.
- One call finds one route for one pair of screens. There is no all pairs mode and no hidden caching.
- `path.variables` stores the route inputs, so `buildInstructions(path)` works without repeating them. Anything passed to `buildInstructions` overrides it.
- `findReachable(tree, start, options)` lists the screens you can get to.

## Instruction output

```json
{
  "from": "home",
  "to": "checkout",
  "path": ["home", "shop", "cart", "checkout"],
  "steps": [
    {
      "n": 1,
      "from": "home",
      "to": "shop",
      "edge": "home->shop",
      "cost": 1,
      "actions": [
        { "type": "TAP", "data": { "target": "Shop" }, "extensions": {} }
      ],
      "extensions": {}
    }
  ],
  "cost": 3,
  "extensions": {},
  "meta": { "app": "Example Store", "algorithm": "astar", "generator": "routegraph" }
}
```

It is ordinary JSON. Options for `buildInstructions`: `variables`, `runtime`, `extensions`, `extensionVariables`, `onError`, `includeUnresolved` (keeps the original payload on each action as `unresolved`, handy for debugging), and `strictVariables`.

Narrow actions with `isAction`:

```ts
for (const step of instructions.steps) {
  for (const action of step.actions) {
    if (isAction(action, "TAP")) action.data.target; // string
  }
}
// For custom actions pass your own map:
interface MyActions { SCAN_QR: { camera: string } }
if (isAction<MyActions, "SCAN_QR">(action, "SCAN_QR")) action.data.camera;
```

## Extensions

Extensions add data while instructions are generated. Their output lands under `extensions[<name>]` so extensions cannot overwrite each other or the core data.

```ts
import { defineExtension, buildInstructions, getExtensionOutput } from "routegraph";

const narration = defineExtension({
  name: "narration",
  variables: { style: "concise" },
  run({ action, from, to, variables }) {
    return { text: `${variables.style}: tap ${String(action.data.target)} to reach ${to.name}.` };
  },
});

const out = await buildInstructions(path, { extensions: [narration] });
getExtensionOutput(out.steps[0]!.actions[0]!, narration)?.text; // typed as string
```

The inline form is equivalent and convenient for one off use: `extensions: { narration: { variables: {...}, run(ctx) {...} } }`.

Hooks, in the order they run:

| Hook | Runs | Context highlights |
| --- | --- | --- |
| `run` or `action` | once per action | `action`, `actionIndex`, `step`, `edge`, `from`, `to` |
| `step` | once per transition, after its actions | `step` including action output |
| `route` | once, after everything else | `instructions` including all earlier output |

For each step the order is: every extension's action hooks for each action, then every extension's step hooks, then after all steps the route hooks. Within a level, extensions run in the order you gave, adjusted only by `dependsOn`.

Semantics:

- Hooks see variables after substitution, so they get usable values.
- Context objects are deep frozen copies. Mutating them throws, and a hook cannot change the path, the cost, or other extensions' output. Return data instead.
- Hooks can be sync or async. Use `buildInstructions` for async hooks and `buildInstructionsSync` when all hooks are sync.
- `ctx.variables` is the extension's own configuration, optionally overridden per build with `extensionVariables: { narration: { style: "verbose" } }`.
- Extensions do not see each other by default. Declare `dependsOn: ["other"]` to read that extension's output for the same node from `ctx.outputs`. Missing and circular dependencies are errors.
- Return `undefined` to attach nothing. Anything else must be JSON compatible (finite numbers, plain objects and arrays, no cycles), otherwise an `ExtensionError` is raised.
- `validate(output)` can return `true` or a string describing the problem.
- Errors throw an `ExtensionError` by default. With `onError: "collect"` the failing output is skipped and a warning is added to `instructions.warnings`.
- Extensions are trusted local code. They are passed in from your program and can never be loaded from a `.navgraph` file.

Typing note: `defineExtension` infers the output type from what your hooks return. If different hooks return different shapes, give the output type explicitly, for example `defineExtension<"summary", JsonObject>({...})`.

## Runtime (optional)

Core routegraph never executes anything. If you want to run instructions, register handlers explicitly:

```ts
import { createRuntime } from "routegraph";

const runtime = createRuntime<{ driver: MyDriver }>({
  TAP: ({ action, context }) => context.driver.tap(String(action.data.target)),
  WAIT: { handler: ({ action }) => waitFor(action.data), options: { timeoutMs: 8000, retries: 1 } },
});

const result = await runtime.execute(instructions, { context: { driver }, continueOnError: false });
// or, with only synchronous handlers:
runtime.executeSync(instructions, { context: { driver } });
```

Handlers get the validated, resolved payload plus your context. Options include `timeoutMs`, `retries`, `retryDelayMs`, `skipUnhandled`, `continueOnError`, `signal` (an `AbortSignal`), and an `onAction` callback. A global registry is available through `registerActionHandler` for apps that prefer one.

## Typing and extensibility

- `indexTree<"home" | "cart">(...)` gives typed `tree.home` and `tree.cart` shortcuts. Without the type argument use `tree.screen("home")`, or `tree.screens.get("home")`, which is the authoritative lookup. Shortcuts exist only for ids that are valid JavaScript identifiers and do not collide with tree members, and they are not enumerable.
- Everything public is exported as a type: `Graph`, `Edge`, `Screen`, `Path`, `Instructions`, `PathfindingAlgorithm`, `ConditionOperator`, `Extension`, `ActionHandler`, and more.
- Extension points: custom schemas, schema registry, custom algorithms, heuristics, cost functions, edge filters, condition operators, instruction extensions, action handlers, a pluggable `readFile`.

## Decisions made for the open questions

The design document left a number of questions open. These are the choices this release makes.

1. Grammar: documented above. JSON blocks may span lines. Strings use JSON escapes.
2. `END` is optional. Nothing may follow it.
3. `APP` is optional.
4. Variable types: `string`, `number`, `boolean`, `null`, `object`, `array`, `any`.
5. Conditions: the grammar above. Unknown values are falsy unless strict mode is on.
6. Edge cost defaults to 1, configurable with `defaultCost`.
7. No route: `calculatePath` throws `NoPathError`, `tryCalculatePath` returns a result object.
8. `buildInstructions` is always async. `buildInstructionsSync` is the synchronous twin.
9. Schemas use a small JSON format modelled on a subset of JSON Schema, plus a real JSON Schema for validating the schema files themselves.
10. Extension dependencies are explicit through `dependsOn`.
11. The action runtime ships in the same package but is opt-in and tree shakeable.
12. Imports between graph files are not part of v1. Merge text before indexing if you need it.
13. `tree.<id>` shortcuts are defined only for safe identifiers.
14. Unresolved payloads are available through `includeUnresolved`.

## Dynamic registration

Screens, edges, and actions can be added while the app runs. This is useful when a list of products or cart lines only exists at runtime. Registration changes a live tree in place, so every part of your app that holds the tree sees the change immediately. There are no tree versions to keep in sync.

Set one shared tree at startup and register from anywhere:

```ts
import { indexTreeFromText, setDefaultTree, registerScreens, registerEdges } from "routegraph";

const tree = indexTreeFromText(text, { setAsDefault: true }); // same as setDefaultTree(tree)

// Clone the `item_settings` screen once per product id. Creates `item_settings:product_1` and so on.
registerScreens(["product_1", "product_2"], "item_settings");

// Add an explicit transition.
registerEdges([{ from: "cart", to: "cart", actions: [{ type: "TAP", data: { target: "Clear" } }] }]);
```

Every registration function also accepts a tree as its first argument (`registerScreens(tree, ids, "item_settings")`), and the same calls exist as methods (`tree.registerScreens(ids, "item_settings")`) and in snake case (`register_screens`). Without a tree argument and without a default tree, the call throws an error that says how to set one. All of them return the tree they changed, so calls can be chained.

How it behaves:

- A registered screen or edge is flagged `dynamic: true`. A screen made from a template also records `template`.
- Registration is all or nothing. If any part of a call fails, the tree is left exactly as it was.
- Everything you register is validated with the same checks as a parsed graph: unknown screens, action types that are not in the tree's schema, payloads that break the schema, `$NAME$` references to undeclared variables, bad costs and conditions, and invalid screen or edge metadata. A failure throws a `ValidationError` whose `diagnostics` list every problem.
- Pass `{ diagnostics: "collect" }` as the last argument to register the valid items anyway. The invalid ones are skipped and their problems are appended to `tree.diagnostics`.
- The schema belongs to the tree. To register a custom action type at runtime, create the tree with a schema that declares it (`indexTreeFromText(text, { schema })` or `createTree({ schema })`).
- Edge ids are deterministic: `from->to`, then `from->to#2`, `#3`.
- A `Path` holds screen ids, not copies. If you unregister a screen that a path uses, `buildInstructions` for that path throws. Recalculate after changing the tree.

Removing what you added:

```ts
import { unregisterScreens, unregisterEdges, clearDynamic } from "routegraph";

unregisterScreens("item_settings:product_1");        // one screen and every edge touching it
unregisterScreens({ template: "item_settings" });   // every instance of a template
clearDynamic();                                     // everything added at runtime
```

Screens and edges that came from the graph file cannot be removed this way, and the call throws if you try. Unknown ids are ignored, so a refresh can call `clearDynamic()` and register again safely.

`createTree({ app, schema, setAsDefault })` makes an empty tree to register into. `cloneTree(tree)` makes an independent deep copy, which is the way to experiment on a local copy without touching the shared tree.

Static action nodes are supported too, both in files and at runtime:

```text
ACTION remove_item "Remove item"
cart -> remove_item { DO TAP { "target": "Item row" } }
remove_item -> cart { DO SWIPE { "direction": "left" } }
```

`registerActions(screen, actions)` creates an action node and the surrounding transitions automatically.

## Automatic mapping (optional)

A scanner and a watcher are provided as optional tooling:

- `tools/scan-app.js`: scans source files for `navigation.navigate`, `router.push`, screen components, and action calls, emits a candidate `.navgraph` patch and a unified diff against an existing graph.
- `NavGraphWatcher` React component (see `examples/watcher.tsx`): wraps the root of an app, records screen/action transitions as you use it, and writes a local `.extend.navgraph` that can be merged through the CLI.

Both are opt-in and do not affect the core package size when unused.

## Development

```sh
npm install
npm run typecheck
npm test
npm run build
```

`npm publish` runs the typecheck, tests, and build first through `prepublishOnly`. The included GitHub workflows run CI on Node 18, 20, and 22 and publish to npm with provenance when a release is created (add an `NPM_TOKEN` secret).

## License

MIT
