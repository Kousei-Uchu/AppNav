import { parseCondition } from "./conditions";
import { requireDefaultTree } from "./default-tree";
import { AppNavError, ValidationError } from "./errors";
import {
  NavigationTree,
  indexGraph,
  validateEdgeRecord,
  validateScreenRecord,
  type RecordValidationEnv,
  type ValidateOptions,
} from "./graph";
import { cloneJson, deepFreeze, isPlainObject } from "./json";
import type { ResolvedSchema, SchemaDefinition } from "./schema";
import type { ActionDeclaration, Diagnostic, Edge, JsonObject, Screen, VariableDeclaration } from "./types";

/**
 * Runtime registration. Screens, edges and actions are added to a live tree in
 * place and flagged `dynamic`. Every function takes the tree as its first
 * argument, or omits it to use the shared default tree (`setDefaultTree`).
 * Registration is staged, validated with the same checks a parsed graph gets
 * (action types, payloads, variables, conditions, endpoints), and committed
 * only when the whole call succeeds, so a failed call leaves the tree untouched.
 */

/** One action on a registered edge. `repeat` is a whole number of at least 1 or a single `$NAME$` reference. */
export interface ActionInput {
  type: string;
  data?: JsonObject;
  repeat?: number | string;
}

export interface ScreenSpec {
  id: string;
  name?: string;
  meta?: JsonObject;
  /** Clone an existing screen instead of starting from scratch. */
  template?: string;
  /** Copy edges incident to the template screen. Default true. */
  cloneEdges?: boolean;
}

/** A screen to register: a bare id, or an object when it needs a name, metadata or its own template. */
export type ScreenInput = string | ScreenSpec;

/** `{ template?, screens?, edges? }` applied in one call by `augmentTree`. */
export interface TreePatch {
  /** Default template for every entry in `screens` that does not name its own. */
  template?: string;
  screens?: ReadonlyArray<ScreenInput>;
  edges?: ReadonlyArray<EdgeSpec>;
}

export interface EdgeSpec {
  from: string;
  to: string;
  id?: string;
  cost?: number;
  condition?: string;
  meta?: JsonObject;
  actions?: ReadonlyArray<ActionInput>;
}

export interface RegisterOptions extends ValidateOptions {
  /** Copy edges incident to the template screen. Default true. */
  cloneEdges?: boolean;
  /**
   * What to do when something fails validation. "throw" (default) raises a
   * ValidationError and registers nothing. "collect" registers the valid items,
   * skips the rest, and records the problems in `tree.diagnostics`.
   */
  diagnostics?: "throw" | "collect";
  /**
   * What to do when a screen id (or explicit edge id) already exists. "error"
   * (default) reports DUPLICATE_SCREEN or DUPLICATE_EDGE. "skip" keeps the
   * existing item. "replace" swaps in the new one; only dynamic items can be
   * replaced, and replacing a screen also removes the edges touching it.
   */
  onDuplicate?: "error" | "skip" | "replace";
}

/** One action registered under a screen. A bare array of actions is shorthand for `{ actions }`. */
export interface ActionSpec {
  /** Display name. Defaults to the action's own name. */
  name?: string;
  /** Actions performed on the way into the node. */
  actions: ReadonlyArray<ActionInput>;
  /** Screen the app is on after the action. Default: the parent screen. */
  to?: string;
  /** Cost of the transition into the node, which is where the actions run. Default 1. */
  cost?: number;
  meta?: JsonObject;
}

/** Actions to register under a screen, keyed by action name (the id of the action node). */
export type ActionSpecMap = Record<string, ActionSpec | ActionSpec["actions"]>;

// ---------------------------------------------------------------------------
// Target and staging helpers

function splitTarget(args: readonly unknown[]): { tree: NavigationTree; rest: unknown[] } {
  if (args[0] instanceof NavigationTree) return { tree: args[0], rest: args.slice(1) };
  return { tree: requireDefaultTree(), rest: [...args] };
}

interface Stage {
  readonly tree: NavigationTree;
  readonly screens: Map<string, Screen>;
  readonly edges: Edge[];
  readonly usedEdgeIds: Set<string>;
  /** Existing dynamic screens and edges that new ones replace when committed. */
  readonly replaceScreens: Set<string>;
  readonly replaceEdges: Set<string>;
  /** Problems found while staging, before validation runs. */
  readonly diagnostics: Diagnostic[];
  nextScreen: number;
  nextEdge: number;
}

function newStage(tree: NavigationTree): Stage {
  return {
    tree,
    screens: new Map(),
    edges: [],
    usedEdgeIds: new Set(tree.edges.map((e) => e.id)),
    replaceScreens: new Set(),
    replaceEdges: new Set(),
    diagnostics: [],
    nextScreen: tree._nextScreenIndex(),
    nextEdge: tree._nextEdgeIndex(),
  };
}

const hasScreen = (st: Stage, id: string) => st.screens.has(id) || st.tree.hasScreen(id);
const getScreen = (st: Stage, id: string) => st.screens.get(id) ?? st.tree.screens.get(id);

const problem = (st: Stage, code: string, message: string, ids: string[]) =>
  st.diagnostics.push({ severity: "error", code, message, file: st.tree.file, ids });

/**
 * Deterministic edge id: `from->to`, then `from->to#2`, `#3`, and so on.
 * Returns undefined when an explicit id is a duplicate that is reported or skipped.
 */
function uniqueEdgeId(st: Stage, from: string, to: string, explicit?: string, mode: RegisterOptions["onDuplicate"] = "error"): string | undefined {
  if (explicit !== undefined) {
    if (!st.usedEdgeIds.has(explicit)) {
      st.usedEdgeIds.add(explicit);
      return explicit;
    }
    if (mode === "skip") return undefined;
    const existing = st.tree.edge(explicit);
    if (mode === "replace" && existing?.dynamic && !st.replaceEdges.has(explicit)) {
      st.replaceEdges.add(explicit);
      return explicit;
    }
    if (mode === "replace" && existing && !existing.dynamic) {
      problem(st, "NOT_DYNAMIC", `Edge "${explicit}" came from the graph file and cannot be replaced`, [explicit]);
    } else {
      problem(st, "DUPLICATE_EDGE", `Duplicate edge id "${explicit}"`, [explicit]);
    }
    return undefined;
  }
  const base = `${from}->${to}`;
  let id = base;
  for (let n = 2; st.usedEdgeIds.has(id); n++) id = `${base}#${n}`;
  st.usedEdgeIds.add(id);
  return id;
}

/**
 * Decide whether a new screen with this id may be staged, applying the
 * onDuplicate policy. Returns false when the id should be skipped.
 */
function claimScreen(st: Stage, id: string, options: RegisterOptions): boolean {
  if (!hasScreen(st, id)) return true;
  const mode = options.onDuplicate ?? "error";
  if (mode === "skip") return false;
  const existing = st.screens.has(id) ? undefined : st.tree.screens.get(id);
  if (mode === "replace" && existing?.dynamic) {
    st.replaceScreens.add(id);
    // The edges that go with the old screen are removed on commit, so their ids become free again.
    for (const e of st.tree.edges) if (e.from === id || e.to === id) st.usedEdgeIds.delete(e.id);
    return true;
  }
  if (mode === "replace" && existing) {
    problem(st, "NOT_DYNAMIC", `Screen "${id}" came from the graph file and cannot be replaced`, [id]);
  } else {
    problem(st, "DUPLICATE_SCREEN", `Screen "${id}" already exists. Pass onDuplicate: "skip" or "replace" to change this`, [id]);
  }
  return false;
}

/**
 * Validate everything staged with the same checks a parsed graph gets, then
 * commit. In "throw" mode any problem aborts the whole call. In "collect" mode
 * valid items are committed and the problems are recorded on the tree.
 */
function finish(st: Stage, options: RegisterOptions): void {
  const tree = st.tree;
  const bad = new Set<string>();
  const env: RecordValidationEnv = {
    schema: tree.schema,
    declarations: tree.variables,
    hasScreen: (id) => !bad.has(id) && hasScreen(st, id),
    options,
    file: tree.file,
  };
  const found: Diagnostic[] = [...st.diagnostics];
  for (const screen of st.screens.values()) {
    const d = validateScreenRecord(screen, env);
    if (d.length > 0) bad.add(screen.id);
    found.push(...d);
  }
  const edges: Edge[] = [];
  for (const edge of st.edges) {
    const d = validateEdgeRecord(edge, env);
    found.push(...d);
    if (d.length === 0) edges.push(edge);
  }
  const hasErrors = found.some((d) => d.severity === "error");
  if (hasErrors && options.diagnostics !== "collect") throw new ValidationError(found, tree.file);
  if (found.length > 0) tree._addDiagnostics(found);
  // Replacements: drop the old items only when their replacement is valid.
  for (const id of st.replaceScreens) if (st.screens.has(id) && !bad.has(id)) tree._removeScreen(id);
  const newEdgeIds = new Set(edges.map((e) => e.id));
  tree._removeEdges((e) => st.replaceEdges.has(e.id) && newEdgeIds.has(e.id));
  for (const screen of st.screens.values()) if (!bad.has(screen.id)) tree._addScreen(deepFreeze(screen));
  for (const edge of edges) tree._addEdge(deepFreeze(edge));
}

function cloneActions(actions: readonly ActionDeclaration[]): ActionDeclaration[] {
  return actions.map((a) => ({
    type: a.type,
    data: cloneJson(a.data),
    ...(a.repeat !== undefined ? { repeat: a.repeat } : {}),
    line: a.line,
    column: a.column,
  }));
}

// ---------------------------------------------------------------------------
// Input checking. Each registration function accepts one documented shape.
// JavaScript callers who pass anything else get an INVALID_REGISTRATION
// diagnostic that shows the right call, instead of items quietly dropped.

const SCREEN_KEYS = new Set(["id", "name", "meta", "template", "cloneEdges"]);
const EDGE_KEYS = new Set(["from", "to", "id", "cost", "condition", "meta", "actions"]);
const PATCH_KEYS = new Set(["template", "screens", "edges"]);

const USAGE = {
  screens: `registerScreens(["product_1", { id: "product_2", name: "Two" }], "item_settings")`,
  edges: `registerEdges([{ from: "cart", to: "home", actions: [] }])`,
  patch: `augmentTree({ template: "item_settings", screens: ["product_1"], edges: [] })`,
};

function unknownKeys(st: Stage, what: string, item: Record<string, unknown>, allowed: ReadonlySet<string>, label: string): boolean {
  const extra = Object.keys(item).filter((k) => !allowed.has(k));
  if (extra.length === 0) return false;
  problem(st, "INVALID_REGISTRATION", `${label} has unknown ${what} ${extra.map((k) => `"${k}"`).join(", ")}. Allowed: ${[...allowed].join(", ")}`, []);
  return true;
}

function screenSpecs(st: Stage, input: unknown): ScreenSpec[] {
  if (!Array.isArray(input)) {
    problem(st, "INVALID_REGISTRATION", `Screens must be an array of ids or { id } objects. Use ${USAGE.screens}`, []);
    return [];
  }
  const out: ScreenSpec[] = [];
  input.forEach((item: unknown, i) => {
    if (typeof item === "string") out.push({ id: item });
    else if (isPlainObject(item) && typeof item.id === "string") {
      if (!unknownKeys(st, "option", item, SCREEN_KEYS, `Screen "${item.id}"`)) out.push(item as unknown as ScreenSpec);
    } else {
      problem(st, "INVALID_REGISTRATION", `Screen ${i} must be an id string or an object with a string "id". Use ${USAGE.screens}`, []);
    }
  });
  return out;
}

function edgeSpecs(st: Stage, input: unknown): EdgeSpec[] {
  if (!Array.isArray(input)) {
    problem(st, "INVALID_REGISTRATION", `Edges must be an array of { from, to } objects. Use ${USAGE.edges}`, []);
    return [];
  }
  const out: EdgeSpec[] = [];
  input.forEach((item: unknown, i) => {
    if (!isPlainObject(item) || typeof item.from !== "string" || typeof item.to !== "string") {
      problem(st, "INVALID_REGISTRATION", `Edge ${i} must be an object with string "from" and "to". Use ${USAGE.edges}`, []);
    } else if (!unknownKeys(st, "field", item, EDGE_KEYS, `Edge "${item.from}->${item.to}"`)) {
      out.push(item as unknown as EdgeSpec);
    }
  });
  return out;
}

// ---------------------------------------------------------------------------
// Staging

function stageScreens(st: Stage, input: unknown, defaultTemplate: string | undefined, options: RegisterOptions): void {
  for (const spec of screenSpecs(st, input)) {
    const tpl = spec.template ?? defaultTemplate;
    const newId = tpl && !spec.id.startsWith(`${tpl}:`) ? `${tpl}:${spec.id}` : spec.id;
    if (!claimScreen(st, newId, options)) continue;

    const base = tpl ? getScreen(st, tpl) : undefined;
    if (tpl && !base) {
      problem(st, "UNKNOWN_SCREEN", `Unknown template screen "${tpl}"`, [tpl]);
      continue;
    }

    const screen: Screen = {
      id: newId,
      name: spec.name ?? base?.name ?? newId,
      meta: { ...cloneJson(base?.meta ?? {}), ...cloneJson(spec.meta ?? {}) },
      index: st.nextScreen++,
      dynamic: true,
      ...(tpl ? { template: tpl } : {}),
    };
    st.screens.set(newId, screen);

    const cloneEdges = (spec.cloneEdges ?? options.cloneEdges ?? true) && !!base;
    if (cloneEdges && tpl) {
      for (const e of st.tree.edges.filter((x) => x.from === tpl || x.to === tpl)) {
        const from = e.from === tpl ? newId : e.from;
        const to = e.to === tpl ? newId : e.to;
        st.edges.push({
          id: uniqueEdgeId(st, from, to) as string,
          from,
          to,
          cost: e.cost,
          condition: e.condition,
          actions: cloneActions(e.actions),
          meta: cloneJson(e.meta),
          index: st.nextEdge++,
          dynamic: true,
        });
      }
    }
  }
}

function stageEdges(st: Stage, input: unknown, options: RegisterOptions): void {
  for (const spec of edgeSpecs(st, input)) {
    let condition: Edge["condition"];
    if (spec.condition) {
      try {
        condition = parseCondition(spec.condition);
      } catch (e) {
        problem(st, "INVALID_CONDITION", e instanceof Error ? e.message : String(e), [`${spec.from}->${spec.to}`]);
        continue;
      }
    }
    const id = uniqueEdgeId(st, spec.from, spec.to, spec.id, options.onDuplicate);
    if (id === undefined) continue;
    st.edges.push({
      id,
      from: spec.from,
      to: spec.to,
      cost: spec.cost === undefined ? 1 : spec.cost,
      condition,
      actions: (spec.actions ?? []).map(
        (a): ActionDeclaration => ({
          type: a.type,
          data: a.data ? cloneJson(a.data) : {},
          ...(a.repeat !== undefined ? { repeat: a.repeat } : {}),
        }),
      ),
      meta: spec.meta ? cloneJson(spec.meta) : {},
      index: st.nextEdge++,
      dynamic: true,
    });
  }
}

// ---------------------------------------------------------------------------
// Public registration API

/** Create an empty tree, optionally making it the shared default. */
export function createTree(options: { app?: string; schema?: SchemaDefinition | ResolvedSchema; setAsDefault?: boolean } = {}): NavigationTree {
  return indexGraph(
    { version: 2, app: options.app, variables: [], screens: [], edges: [], hasEnd: true },
    { schema: options.schema, setAsDefault: options.setAsDefault },
  );
}

/**
 * Register screens on a tree in place. With a template, each id becomes
 * `<template>:<id>`, a copy of the template screen, and edges touching the
 * template are copied to the new screen. Returns the same tree.
 *
 * Accepted input: an array of ids or `{ id, name?, meta?, template?, cloneEdges? }`.
 * Pass the tree first, or omit it to use the shared default tree.
 */
export function registerScreens(tree: NavigationTree, screens: ReadonlyArray<ScreenInput>, template?: string, options?: RegisterOptions): NavigationTree;
export function registerScreens(tree: NavigationTree, screens: ReadonlyArray<ScreenInput>, options?: RegisterOptions): NavigationTree;
export function registerScreens(screens: ReadonlyArray<ScreenInput>, template?: string, options?: RegisterOptions): NavigationTree;
export function registerScreens(screens: ReadonlyArray<ScreenInput>, options?: RegisterOptions): NavigationTree;
export function registerScreens(...args: unknown[]): NavigationTree {
  const { tree, rest } = splitTarget(args);
  const [input, second, third] = rest;
  const template = typeof second === "string" ? second : undefined;
  const options = (isPlainObject(second) ? second : isPlainObject(third) ? third : {}) as RegisterOptions;
  const st = newStage(tree);
  stageScreens(st, input, template, options);
  finish(st, options);
  return tree;
}

/** Register edges (transitions) on a tree in place. Accepts an array of `{ from, to, ... }`. Returns the same tree. */
export function registerEdges(tree: NavigationTree, edges: ReadonlyArray<EdgeSpec>, options?: RegisterOptions): NavigationTree;
export function registerEdges(edges: ReadonlyArray<EdgeSpec>, options?: RegisterOptions): NavigationTree;
export function registerEdges(...args: unknown[]): NavigationTree {
  const { tree, rest } = splitTarget(args);
  const options = (isPlainObject(rest[1]) ? rest[1] : {}) as RegisterOptions;
  const st = newStage(tree);
  stageEdges(st, rest[0], options);
  finish(st, options);
  return tree;
}

/** Stage action nodes under `parent`. Each key of the input is the id of one action node. */
function stageActions(st: Stage, parent: string, input: unknown, options: RegisterOptions): void {
  const usage = `registerActions(screen, { remove_item: { actions: [...] } })`;
  if (!isPlainObject(input) || Object.keys(input).length === 0 || typeof input.type === "string") {
    problem(st, "INVALID_ACTION_REGISTRATION", `Each action needs a name. Use ${usage}`, [parent]);
    return;
  }
  for (const [name, raw] of Object.entries(input)) {
    const spec = Array.isArray(raw) ? { actions: raw } : isPlainObject(raw) ? raw : undefined;
    if (!spec || !Array.isArray(spec.actions)) {
      problem(st, "INVALID_ACTION_REGISTRATION", `Action "${name}" must be an array of actions or an object with an "actions" array. Use ${usage}`, [name]);
      continue;
    }
    if (!claimScreen(st, name, options)) continue;
    const destination = typeof spec.to === "string" ? spec.to : parent;
    st.screens.set(name, {
      id: name,
      name: typeof spec.name === "string" ? spec.name : name,
      meta: { ...(isPlainObject(spec.meta) ? cloneJson(spec.meta as JsonObject) : {}), kind: "action", parent } as JsonObject,
      index: st.nextScreen++,
      dynamic: true,
    });
    // The actions sit on the edge into the node, so arriving at the node means the
    // action was performed. The edge out is empty and free: it only moves the app
    // on to `destination` when a route has to continue past the node.
    stageEdges(
      st,
      [
        { from: parent, to: name, cost: typeof spec.cost === "number" ? spec.cost : 1, actions: spec.actions },
        { from: name, to: destination, cost: 0, actions: [] },
      ],
      options,
    );
  }
}

/**
 * Register action nodes under a screen, in place. Each key is the name (and id)
 * of one action node. The parent screen gets an edge into the node that carries
 * the actions, so a route that ends at the node ends with the action. The node
 * gets an empty, zero cost edge to `to` (default the parent), which lets a
 * later route continue from the node.
 *
 * `registerActions("cart", { remove_item: { actions: [{ type: "SWIPE", data: { direction: "left" } }] } })`
 *
 * A bare array is shorthand for `{ actions }`. Names are required, so two
 * actions on one screen never collide. Returns the same tree.
 */
export function registerActions(tree: NavigationTree, screenId: string, actions: ActionSpecMap, options?: RegisterOptions): NavigationTree;
export function registerActions(screenId: string, actions: ActionSpecMap, options?: RegisterOptions): NavigationTree;
export function registerActions(...args: unknown[]): NavigationTree {
  const { tree, rest } = splitTarget(args);
  const [screenId, input, optionsArg] = rest;
  const options = (isPlainObject(optionsArg) ? optionsArg : {}) as RegisterOptions;
  const st = newStage(tree);
  if (typeof screenId !== "string") problem(st, "INVALID_REGISTRATION", `The first argument must be the id of the parent screen. Use registerActions("cart", { remove_item: { actions: [...] } })`, []);
  else stageActions(st, screenId, input, options);
  finish(st, options);
  return tree;
}

/** Apply `{ template?, screens?, edges? }` in one call, all or nothing. Returns the same tree. */
export function augmentTree(tree: NavigationTree, patch: TreePatch, options?: RegisterOptions): NavigationTree;
export function augmentTree(patch: TreePatch, options?: RegisterOptions): NavigationTree;
export function augmentTree(...args: unknown[]): NavigationTree {
  const { tree, rest } = splitTarget(args);
  const [patch, optionsArg] = rest;
  const options = (isPlainObject(optionsArg) ? optionsArg : {}) as RegisterOptions;
  const st = newStage(tree);
  if (!isPlainObject(patch)) {
    problem(st, "INVALID_REGISTRATION", `The patch must be an object. Use ${USAGE.patch}`, []);
  } else if (!unknownKeys(st, "field", patch, PATCH_KEYS, "The patch")) {
    if (patch.template !== undefined && typeof patch.template !== "string") problem(st, "INVALID_REGISTRATION", `"template" must be a screen id`, []);
    else {
      if (patch.screens !== undefined) stageScreens(st, patch.screens, patch.template as string | undefined, options);
      if (patch.edges !== undefined) stageEdges(st, patch.edges, options);
    }
  }
  finish(st, options);
  return tree;
}

// ---------------------------------------------------------------------------
// Removal

export type ScreenSelector = string | readonly string[] | { template: string };

function idList(selector: unknown, usage: string): string[] {
  if (typeof selector === "string") return [selector];
  if (Array.isArray(selector) && selector.every((x) => typeof x === "string")) return [...selector];
  throw new AppNavError("INVALID_REGISTRATION", `Expected an id or an array of ids. Use ${usage}`);
}

function selectScreenIds(tree: NavigationTree, selector: unknown): string[] {
  if (isPlainObject(selector) && typeof selector.template === "string" && Object.keys(selector).length === 1) {
    return [...tree.screens.values()].filter((s) => s.dynamic && s.template === selector.template).map((s) => s.id);
  }
  return idList(selector, `unregisterScreens("item_settings:product_1") or unregisterScreens({ template: "item_settings" })`);
}

/**
 * Remove dynamic screens (and every edge touching them). Accepts an id, a list
 * of ids, or `{ template }` to remove every instance of a template. Unknown ids
 * are ignored so the call is safe to repeat. Screens that came from the graph
 * file cannot be removed. Returns the same tree.
 */
export function unregisterScreens(tree: NavigationTree, selector: ScreenSelector): NavigationTree;
export function unregisterScreens(selector: ScreenSelector): NavigationTree;
export function unregisterScreens(...args: unknown[]): NavigationTree {
  const { tree, rest } = splitTarget(args);
  const ids = selectScreenIds(tree, rest[0]).filter((id) => tree.hasScreen(id));
  for (const id of ids) {
    if (!tree.screen(id).dynamic) {
      throw new AppNavError("NOT_DYNAMIC", `Screen "${id}" came from the graph file and cannot be unregistered`, { ids: [id] });
    }
  }
  for (const id of ids) tree._removeScreen(id);
  return tree;
}

/** Remove dynamic edges by id. Unknown ids are ignored; file edges cannot be removed. Returns the same tree. */
export function unregisterEdges(tree: NavigationTree, ids: string | readonly string[]): NavigationTree;
export function unregisterEdges(ids: string | readonly string[]): NavigationTree;
export function unregisterEdges(...args: unknown[]): NavigationTree {
  const { tree, rest } = splitTarget(args);
  const ids = new Set(idList(rest[0], `unregisterEdges(["home->cart"])`));
  const blocked = tree.edges.filter((e) => ids.has(e.id) && !e.dynamic);
  if (blocked.length > 0) {
    throw new AppNavError("NOT_DYNAMIC", `Edge "${blocked[0]?.id}" came from the graph file and cannot be unregistered`, { ids: blocked.map((e) => e.id) });
  }
  tree._removeEdges((e) => ids.has(e.id));
  return tree;
}

/** Remove everything added at runtime, leaving the file graph. Returns the same tree. */
export function clearDynamic(tree?: NavigationTree): NavigationTree;
export function clearDynamic(...args: unknown[]): NavigationTree {
  const { tree } = splitTarget(args);
  tree._removeEdges((e) => e.dynamic === true);
  for (const s of [...tree.screens.values()]) if (s.dynamic) tree._removeScreen(s.id);
  return tree;
}

/** An independent deep copy of a tree (the default tree when omitted). Changes to the copy never touch the original. */
export function cloneTree(tree?: NavigationTree): NavigationTree;
export function cloneTree(...args: unknown[]): NavigationTree {
  const src = args[0] instanceof NavigationTree ? args[0] : requireDefaultTree();
  const screens = new Map<string, Screen>();
  for (const [id, s] of src.screens) screens.set(id, deepFreeze({ ...s, meta: cloneJson(s.meta) }));
  const edges: Edge[] = src.edges.map((e) => deepFreeze({ ...e, actions: cloneActions(e.actions), meta: cloneJson(e.meta) }));
  const variables: Record<string, VariableDeclaration> = {};
  for (const [k, v] of Object.entries(src.variables)) variables[k] = { ...v };
  return new NavigationTree({
    app: src.app,
    version: src.version,
    file: src.file,
    schema: src.schema,
    variables,
    screens,
    edges,
    diagnostics: [...src.diagnostics],
  });
}

// ---------------------------------------------------------------------------
// Instance methods. Each one calls the free function of the same name, so
// there is one implementation. They return the tree for chaining.

declare module "./graph" {
  interface NavigationTree {
    registerScreens(screens: ReadonlyArray<ScreenInput>, template?: string, options?: RegisterOptions): NavigationTree;
    registerScreens(screens: ReadonlyArray<ScreenInput>, options?: RegisterOptions): NavigationTree;
    registerEdges(edges: ReadonlyArray<EdgeSpec>, options?: RegisterOptions): NavigationTree;
    registerActions(screenId: string, actions: ActionSpecMap, options?: RegisterOptions): NavigationTree;
    unregisterScreens(selector: ScreenSelector): NavigationTree;
    unregisterEdges(ids: string | readonly string[]): NavigationTree;
    clearDynamic(): NavigationTree;
    cloneTree(): NavigationTree;
  }
}

type Loose = (...args: unknown[]) => NavigationTree;
const loose = (fn: unknown): Loose => fn as Loose;
const proto = NavigationTree.prototype as unknown as Record<string, (this: NavigationTree, ...a: unknown[]) => unknown>;
proto.registerScreens = function (...a) {
  return loose(registerScreens)(this, ...a);
};
proto.registerEdges = function (...a) {
  return loose(registerEdges)(this, ...a);
};
proto.registerActions = function (...a) {
  return loose(registerActions)(this, ...a);
};
proto.unregisterScreens = function (...a) {
  return loose(unregisterScreens)(this, ...a);
};
proto.unregisterEdges = function (...a) {
  return loose(unregisterEdges)(this, ...a);
};
proto.clearDynamic = function () {
  return clearDynamic(this);
};
proto.cloneTree = function () {
  return cloneTree(this);
};

// ---------------------------------------------------------------------------
// snake_case names. One per canonical function, nothing else.

export const register_screens = registerScreens;
export const register_edges = registerEdges;
export const register_actions = registerActions;
export const unregister_screens = unregisterScreens;
export const unregister_edges = unregisterEdges;
export const clear_dynamic = clearDynamic;
export const clone_tree = cloneTree;
