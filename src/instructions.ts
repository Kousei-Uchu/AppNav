import { driveAsync, driveSync, type Job } from "./drive";
import { AppNavError, ExtensionError, VariableError, toDiagnostic } from "./errors";
import {
  normalizeExtensions,
  type AnyExtension,
  type ExtensionsInput,
} from "./extensions";
import { cloneJson, deepFreeze, isThenable, jsonProblem, setOwn } from "./json";
import type { Path } from "./pathfinding";
import type { DefaultActionMap, Diagnostic, Edge, JsonObject, JsonValue, VariableDeclaration } from "./types";
import { buildScope, resolveValue, type VariableScope } from "./variables";

export interface InstructionAction<T extends string = string, D extends JsonObject = JsonObject> {
  type: T;
  /** Resolved payload, with all `$VAR$` references substituted. */
  data: D;
  /**
   * How many times to perform the action in a row, as a whole number of at
   * least 1. Only present when the graph declares a repeat. It is data on the
   * step, not duplicated steps, so an app can show "x4".
   */
  repeat?: number;
  /** Extension output, keyed by extension name. */
  extensions: Record<string, JsonValue>;
  /** Original payload before substitution. Only present with `includeUnresolved`. */
  unresolved?: JsonObject;
}

/** "action" when the step arrives at an action node (the app does something), "navigate" otherwise (the app goes somewhere). */
export type StepKind = "navigate" | "action";

export interface InstructionStep {
  n: number;
  from: string;
  to: string;
  /**
   * Display name of the screen the step arrives at, so instructions can be
   * written without a second lookup. Always set by the builder.
   */
  toName?: string;
  /** Whether the step navigates to a screen or performs an action. Always set by the builder. */
  kind?: StepKind;
  /** For action steps, the id of the action node the step arrives at, such as `remove_item:product_2`. */
  actionNode?: string;
  /** Id of the graph edge this step traverses. */
  edge: string;
  cost: number;
  actions: InstructionAction[];
  extensions: Record<string, JsonValue>;
}

export interface Instructions {
  from: string;
  to: string;
  path: string[];
  steps: InstructionStep[];
  cost: number;
  /** Route level extension output. */
  extensions: Record<string, JsonValue>;
  meta: { app?: string; algorithm: string; generator: string };
  /** Present only when `onError: "collect"` swallowed extension failures. */
  warnings?: Diagnostic[];
}

export interface BuildOptions {
  /** Route inputs. Override graph defaults and anything stored on the path. */
  variables?: Readonly<Record<string, JsonValue>>;
  /** Runtime values. Override route inputs. */
  runtime?: Readonly<Record<string, JsonValue>>;
  /** Extensions as an array of defineExtension() results, or an inline map keyed by name. */
  extensions?: ExtensionsInput;
  /** Per extension configuration overrides, keyed by extension name. */
  extensionVariables?: Readonly<Record<string, JsonObject>>;
  /** "throw" (default) fails on the first extension error. "collect" records warnings and continues. */
  onError?: "throw" | "collect";
  /** Keep the original unresolved payload on each action as `unresolved`. */
  includeUnresolved?: boolean;
  /** Reject route variables that are not declared in the graph. */
  strictVariables?: boolean;
}

export const GENERATOR_ID = "routegraph";

type Level = "action" | "step" | "route";

const view = <T extends JsonValue>(v: T): T => deepFreeze(cloneJson(v));

/** Resolve a declared repeat (a number or one `$NAME$` reference) to a whole number of at least 1. */
function resolveRepeat(
  raw: number | string | undefined,
  scope: VariableScope,
  declarations: Readonly<Record<string, VariableDeclaration>>,
  ids: string[],
): number | undefined {
  if (raw === undefined) return undefined;
  const value = typeof raw === "string" ? resolveValue(raw, scope, declarations, { ids }) : raw;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw new VariableError(
      `Repeat on ${ids.join(" ")} must be a whole number of at least 1, got ${JSON.stringify(value)}`,
      { ids },
      "INVALID_REPEAT",
    );
  }
  return value;
}

function* callHook(
  ext: AnyExtension,
  level: Level,
  ids: string[],
  invoke: () => unknown,
): Job<JsonValue | undefined> {
  let out: unknown;
  try {
    out = invoke();
    if (isThenable(out)) out = yield { promise: out, what: `Extension "${ext.name}" (${level} hook)` };
  } catch (e) {
    throw e instanceof ExtensionError ? e : new ExtensionError(ext.name, `${level} hook failed: ${e instanceof Error ? e.message : String(e)}`, e, ids);
  }
  if (out === undefined) return undefined;
  const problem = jsonProblem(out);
  if (problem) throw new ExtensionError(ext.name, `${level} hook returned a value that is not JSON compatible (${problem})`, undefined, ids);
  if (ext.validate) {
    let verdict: boolean | string;
    try {
      verdict = ext.validate(out as never);
    } catch (e) {
      throw new ExtensionError(ext.name, `output validation threw: ${e instanceof Error ? e.message : String(e)}`, e, ids);
    }
    if (verdict !== true) {
      throw new ExtensionError(ext.name, `${level} output rejected${typeof verdict === "string" ? `: ${verdict}` : ""}`, undefined, ids);
    }
  }
  return cloneJson(out as JsonValue);
}

function* generate(path: Path, options: BuildOptions): Job<Instructions> {
  const tree = path.tree;
  const extensions = normalizeExtensions(options.extensions);
  const collect = options.onError === "collect";
  const warnings: Diagnostic[] = [];

  const scope = buildScope(tree.variables, {
    variables: { ...path.variables, ...(options.variables ?? {}) },
    runtime: options.runtime,
    strict: options.strictVariables,
  });

  // 1. Resolve every payload up front so variable errors surface before any extension runs.
  const steps: InstructionStep[] = path.edges.map((edge: Edge, i: number): InstructionStep => {
    const arrival = tree.screen(edge.to);
    const isAction = arrival.meta.kind === "action";
    return {
      n: i + 1,
      from: edge.from,
      to: edge.to,
      toName: arrival.name,
      kind: isAction ? "action" : "navigate",
      ...(isAction ? { actionNode: edge.to } : {}),
      edge: edge.id,
      cost: edge.cost,
      actions: edge.actions.map((a, ai): InstructionAction => {
        const repeat = resolveRepeat(a.repeat, scope, tree.variables, [edge.id, a.type]);
        const action: InstructionAction = {
          type: a.type,
          data: resolveValue(a.data, scope, tree.variables, { ids: [edge.id, a.type] }) as JsonObject,
          ...(repeat !== undefined ? { repeat } : {}),
          extensions: {},
        };
        if (options.includeUnresolved) action.unresolved = cloneJson(a.data);
        void ai;
        return action;
      }),
      extensions: {},
    };
  });

  const instructions: Instructions = {
    from: path.from,
    to: path.to,
    path: [...path.screens],
    steps,
    cost: path.cost,
    extensions: {},
    meta: { ...(tree.app !== undefined ? { app: tree.app } : {}), algorithm: path.algorithm, generator: GENERATOR_ID },
  };

  const varsFor = (ext: AnyExtension) => ({ ...ext.variables, ...(options.extensionVariables?.[ext.name] ?? {}) });
  const base = (ext: AnyExtension, produced: Record<string, JsonValue>) => {
    const outputs: Record<string, JsonValue> = {};
    for (const dep of ext.dependsOn) if (dep in produced) setOwn(outputs, dep, produced[dep] as JsonValue);
    return {
      name: ext.name,
      variables: deepFreeze(varsFor(ext)),
      routeVariables: view(scope as JsonObject),
      tree,
      path,
      outputs: deepFreeze(outputs),
    };
  };

  /** Run one hook, applying the error policy. Stores output under `target[ext.name]`. */
  function* run(
    ext: AnyExtension,
    level: Level,
    ids: string[],
    target: Record<string, JsonValue>,
    invoke: () => unknown,
  ): Job<void> {
    try {
      const out = yield* callHook(ext, level, ids, invoke);
      if (out !== undefined) setOwn(target, ext.name, out);
    } catch (e) {
      if (collect && e instanceof ExtensionError) warnings.push(toDiagnostic(e, "warning"));
      else throw e;
    }
  }

  // 2. Action and step hooks, in step order.
  for (let si = 0; si < steps.length; si++) {
    const step = steps[si] as InstructionStep;
    const edge = path.edges[si] as Edge;
    const from = tree.screen(step.from);
    const to = tree.screen(step.to);
    for (let ai = 0; ai < step.actions.length; ai++) {
      const action = step.actions[ai] as InstructionAction;
      for (const ext of extensions) {
        const hook = ext.hooks.action;
        if (!hook) continue;
        yield* run(ext, "action", [edge.id, action.type], action.extensions, () =>
          hook({
            ...base(ext, action.extensions),
            action: view(action as unknown as JsonObject) as unknown as InstructionAction,
            actionIndex: ai,
            step: view(step as unknown as JsonObject) as unknown as InstructionStep,
            edge,
            from,
            to,
          }),
        );
      }
    }
    for (const ext of extensions) {
      const hook = ext.hooks.step;
      if (!hook) continue;
      yield* run(ext, "step", [edge.id], step.extensions, () =>
        hook({
          ...base(ext, step.extensions),
          step: view(step as unknown as JsonObject) as unknown as InstructionStep,
          edge,
          from,
          to,
        }),
      );
    }
  }

  // 3. Route hooks.
  const from = tree.screen(path.from);
  const to = tree.screen(path.to);
  for (const ext of extensions) {
    const hook = ext.hooks.route;
    if (!hook) continue;
    yield* run(ext, "route", [path.from, path.to], instructions.extensions, () =>
      hook({
        ...base(ext, instructions.extensions),
        instructions: view(instructions as unknown as JsonObject) as unknown as Instructions,
        from,
        to,
      }),
    );
  }

  if (warnings.length > 0) instructions.warnings = warnings;
  return instructions;
}

function checkPath(path: Path): void {
  if (!path || typeof path !== "object" || !("tree" in path) || !Array.isArray(path.edges)) {
    throw new AppNavError("INVALID_PATH", "buildInstructions expects a Path returned by calculatePath()");
  }
}

/**
 * Build the instruction tree. Always returns a promise and awaits async
 * extension hooks. Use `buildInstructionsSync` when every hook is synchronous.
 */
export async function buildInstructions(path: Path, options: BuildOptions = {}): Promise<Instructions> {
  checkPath(path);
  return driveAsync(generate(path, options));
}

/**
 * Synchronous variant. Throws AsyncExtensionError if any hook returns a promise.
 */
export function buildInstructionsSync(path: Path, options: BuildOptions = {}): Instructions {
  checkPath(path);
  return driveSync(generate(path, options));
}

/**
 * Narrow an action to a known type with a typed payload. Works with the
 * built in actions out of the box; pass your own map as the first type
 * argument for custom actions: `isAction<MyActions, "SCAN_QR">(a, "SCAN_QR")`.
 */
export function isAction<M extends object = DefaultActionMap, K extends keyof M & string = keyof M & string>(
  action: InstructionAction,
  type: K,
): action is InstructionAction<K, M[K] & JsonObject> {
  return action.type === type;
}
