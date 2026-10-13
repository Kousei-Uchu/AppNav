import { ExtensionError } from "./errors";
import { isJsonValue, isPlainObject } from "./json";
import type { NavigationTree } from "./graph";
import type { Instructions, InstructionAction, InstructionStep } from "./instructions";
import type { Path } from "./pathfinding";
import type { Edge, JsonObject, JsonValue, Screen } from "./types";

export type MaybePromise<T> = T | PromiseLike<T>;
export type HookResult<Out> = Out | void | undefined;
export type Hook<Ctx, Out> = (ctx: Ctx) => MaybePromise<HookResult<Out>>;

interface BaseContext<V extends JsonObject> {
  /** Extension name. */
  readonly name: string;
  /** Extension local configuration merged with per build overrides. */
  readonly variables: Readonly<V>;
  /** Resolved route variables (graph defaults, route inputs, runtime). */
  readonly routeVariables: Readonly<Record<string, JsonValue>>;
  readonly tree: NavigationTree;
  readonly path: Path;
  /** Outputs of extensions listed in `dependsOn`, for this same node. */
  readonly outputs: Readonly<Record<string, JsonValue>>;
}

export interface ActionContext<V extends JsonObject = JsonObject> extends BaseContext<V> {
  readonly action: Readonly<InstructionAction>;
  readonly actionIndex: number;
  readonly step: Readonly<InstructionStep>;
  readonly edge: Edge;
  readonly from: Screen;
  readonly to: Screen;
}

export interface StepContext<V extends JsonObject = JsonObject> extends BaseContext<V> {
  /** The step with action level extension output already attached. */
  readonly step: Readonly<InstructionStep>;
  readonly edge: Edge;
  readonly from: Screen;
  readonly to: Screen;
}

export interface RouteContext<V extends JsonObject = JsonObject> extends BaseContext<V> {
  /** The full instruction tree with action and step output already attached. */
  readonly instructions: Readonly<Instructions>;
  readonly from: Screen;
  readonly to: Screen;
}

export interface ExtensionDefinition<
  N extends string = string,
  Out extends JsonValue = JsonValue,
  V extends JsonObject = JsonObject,
> {
  name: N;
  /** Local configuration. Never mutates graph or route variables. */
  variables?: V;
  /** Names of extensions whose output for the same node this one reads via `ctx.outputs`. */
  dependsOn?: readonly string[];
  /** Shorthand for `action`. Called once per action. */
  run?: Hook<ActionContext<V>, Out>;
  action?: Hook<ActionContext<V>, Out>;
  /** Called once per screen to screen transition, after its actions. */
  step?: Hook<StepContext<V>, Out>;
  /** Called once after every step has been built. */
  route?: Hook<RouteContext<V>, Out>;
  /** Optional output check. Return true, or a string describing the problem. */
  validate?: (output: Out) => boolean | string;
}

/** Definition without a name, for the inline object form. */
export type InlineExtension<Out extends JsonValue = JsonValue, V extends JsonObject = JsonObject> = Omit<
  ExtensionDefinition<string, Out, V>,
  "name"
>;

declare const OUTPUT: unique symbol;

export interface Extension<
  N extends string = string,
  Out extends JsonValue = JsonValue,
  V extends JsonObject = JsonObject,
> {
  readonly name: N;
  readonly variables: Readonly<V>;
  readonly dependsOn: readonly string[];
  readonly hooks: {
    readonly action?: Hook<ActionContext<V>, Out>;
    readonly step?: Hook<StepContext<V>, Out>;
    readonly route?: Hook<RouteContext<V>, Out>;
  };
  readonly validate?: (output: Out) => boolean | string;
  /** Type only marker used by `getExtensionOutput`. */
  readonly [OUTPUT]?: Out;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyExtension = Extension<any, any, any>;
export type OutputOf<E> = E extends Extension<any, infer O, any> ? O : never;
export type NameOf<E> = E extends Extension<infer N, any, any> ? N : never;
/** Hooks that return nothing infer `never`; treat that as "any JSON value". */
type OutputOrJson<Out> = [Out] extends [never] ? JsonValue : Out;

export type ExtensionsInput = readonly AnyExtension[] | Readonly<Record<string, InlineExtension<JsonValue, JsonObject>>>;

const NAME = /^[A-Za-z_][A-Za-z0-9_.-]*$/;
const BRAND = new WeakSet<object>();

/** Validate and create a reusable extension definition. */
export function defineExtension<
  N extends string,
  Out extends JsonValue = JsonValue,
  V extends JsonObject = JsonObject,
>(definition: ExtensionDefinition<N, Out, V>): Extension<N, OutputOrJson<Out>, V> {
  const name = definition?.name;
  if (typeof name !== "string" || !NAME.test(name) || name === "__proto__") {
    throw new ExtensionError(String(name), "extension names must match /^[A-Za-z_][A-Za-z0-9_.-]*$/");
  }
  const action = definition.action ?? definition.run;
  if (definition.action && definition.run) {
    throw new ExtensionError(name, 'use either "run" or "action", not both');
  }
  if (!action && !definition.step && !definition.route) {
    throw new ExtensionError(name, 'define at least one hook: "run", "action", "step" or "route"');
  }
  for (const [k, h] of [["run", definition.run], ["action", definition.action], ["step", definition.step], ["route", definition.route]] as const) {
    if (h !== undefined && typeof h !== "function") throw new ExtensionError(name, `"${k}" must be a function`);
  }
  const variables = (definition.variables ?? {}) as V;
  if (!isPlainObject(variables) || !isJsonValue(variables)) {
    throw new ExtensionError(name, '"variables" must be a plain JSON object');
  }
  const ext = Object.freeze({
    name,
    variables: Object.freeze({ ...variables }) as Readonly<V>,
    dependsOn: Object.freeze([...(definition.dependsOn ?? [])]),
    hooks: Object.freeze({ action, step: definition.step, route: definition.route }),
    validate: definition.validate,
  });
  BRAND.add(ext);
  return ext as unknown as Extension<N, OutputOrJson<Out>, V>;
}

/** Normalise the array or inline-object forms into an ordered, dependency sorted list. */
export function normalizeExtensions(input: ExtensionsInput | undefined): AnyExtension[] {
  if (!input) return [];
  const list: AnyExtension[] = Array.isArray(input)
    ? [...(input as readonly AnyExtension[])].map((e) => {
        if (!BRAND.has(e)) throw new ExtensionError(String((e as { name?: unknown })?.name), "pass extensions created with defineExtension()");
        return e;
      })
    : Object.entries(input as Record<string, InlineExtension>).map(([name, def]) => defineExtension({ ...def, name }));

  const byName = new Map<string, AnyExtension>();
  for (const e of list) {
    if (byName.has(e.name)) throw new ExtensionError(e.name, "duplicate extension name");
    byName.set(e.name, e);
  }
  // Stable topological sort: keep the caller's order unless a dependency requires otherwise.
  const out: AnyExtension[] = [];
  const state = new Map<string, 1 | 2>();
  const visit = (e: AnyExtension, trail: string[]) => {
    const s = state.get(e.name);
    if (s === 2) return;
    if (s === 1) throw new ExtensionError(e.name, `circular dependency: ${[...trail, e.name].join(" -> ")}`);
    state.set(e.name, 1);
    for (const dep of e.dependsOn) {
      const d = byName.get(dep);
      if (!d) throw new ExtensionError(e.name, `depends on unknown extension "${dep}"`);
      visit(d, [...trail, e.name]);
    }
    state.set(e.name, 2);
    out.push(e);
  };
  for (const e of list) visit(e, []);
  return out;
}

/** Typed read of an extension's output from any node (action, step or the route). */
export function getExtensionOutput<E extends AnyExtension>(
  node: { readonly extensions: Readonly<Record<string, JsonValue>> },
  extension: E,
): OutputOf<E> | undefined {
  const v = Object.prototype.hasOwnProperty.call(node.extensions, extension.name)
    ? node.extensions[extension.name]
    : undefined;
  return v as OutputOf<E> | undefined;
}
