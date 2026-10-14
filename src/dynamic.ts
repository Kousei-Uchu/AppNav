import { parseCondition } from "./conditions";
import { requireDefaultTree } from "./default-tree";
import { AppNavError, UnknownScreenError } from "./errors";
import { NavigationTree, indexGraph } from "./graph";
import { cloneJson, deepFreeze, isPlainObject } from "./json";
import type { ResolvedSchema, SchemaDefinition } from "./schema";
import type { ActionDeclaration, Edge, JsonObject, Screen, VariableDeclaration } from "./types";

/**
 * Runtime registration. Screens, edges and actions are added to a live tree in
 * place and flagged `dynamic`. Every function takes the tree as its first
 * argument, or omits it to use the shared default tree (`setDefaultTree`).
 * Registration is staged first and committed only when the whole call
 * succeeds, so a failed call leaves the tree untouched.
 */

export interface ScreenSpec {
  id: string;
  name?: string;
  meta?: JsonObject;
  /** Clone an existing screen instead of starting from scratch. */
  template?: string;
  cloneFrom?: string;
  from?: string;
  /** Copy edges incident to the template screen. Default true. */
  cloneEdges?: boolean;
}

export interface EdgeSpec {
  from: string;
  to: string;
  id?: string;
  cost?: number;
  condition?: string;
  meta?: JsonObject;
  actions?: ReadonlyArray<{ type: string; data?: JsonObject }>;
}

export interface RegisterOptions {
  /** Copy edges incident to the template screen. Default true. */
  cloneEdges?: boolean;
}

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
  nextScreen: number;
  nextEdge: number;
}

function newStage(tree: NavigationTree): Stage {
  return {
    tree,
    screens: new Map(),
    edges: [],
    usedEdgeIds: new Set(tree.edges.map((e) => e.id)),
    nextScreen: tree._nextScreenIndex(),
    nextEdge: tree._nextEdgeIndex(),
  };
}

const hasScreen = (st: Stage, id: string) => st.screens.has(id) || st.tree.hasScreen(id);
const getScreen = (st: Stage, id: string) => st.screens.get(id) ?? st.tree.screens.get(id);

/** Deterministic edge id: `from->to`, then `from->to#2`, `#3`, and so on. */
function uniqueEdgeId(st: Stage, from: string, to: string, explicit?: string): string {
  if (explicit !== undefined) {
    if (st.usedEdgeIds.has(explicit)) throw new AppNavError("DUPLICATE_EDGE", `Duplicate edge id "${explicit}"`, { ids: [explicit] });
    st.usedEdgeIds.add(explicit);
    return explicit;
  }
  const base = `${from}->${to}`;
  let id = base;
  for (let n = 2; st.usedEdgeIds.has(id); n++) id = `${base}#${n}`;
  st.usedEdgeIds.add(id);
  return id;
}

function commit(st: Stage): void {
  for (const screen of st.screens.values()) st.tree._addScreen(deepFreeze(screen));
  for (const edge of st.edges) st.tree._addEdge(deepFreeze(edge));
}

function cloneActions(actions: readonly ActionDeclaration[]): ActionDeclaration[] {
  return actions.map((a) => ({ type: a.type, data: cloneJson(a.data), line: a.line, column: a.column }));
}

// ---------------------------------------------------------------------------
// Input normalisation (accepts a few shapes; tightened in a later change)

function normalizeScreenSpecs(input: unknown, defaultTemplate?: string): ScreenSpec[] {
  const out: ScreenSpec[] = [];
  if (input == null) return out;
  const fromObject = (id: string, v: Record<string, unknown>): ScreenSpec => {
    const spec: ScreenSpec = { id, template: defaultTemplate };
    if (typeof v.name === "string") spec.name = v.name;
    if (isPlainObject(v.meta)) spec.meta = v.meta as JsonObject;
    const tpl = v.template ?? v.cloneFrom ?? v.from;
    if (typeof tpl === "string") spec.template = tpl;
    if (typeof v.cloneEdges === "boolean") spec.cloneEdges = v.cloneEdges;
    return spec;
  };
  if (typeof input === "string") return [{ id: input, template: defaultTemplate }];
  if (Array.isArray(input)) {
    for (const item of input) {
      if (typeof item === "string") out.push({ id: item, template: defaultTemplate });
      else if (isPlainObject(item) && typeof item.id === "string") out.push(fromObject(item.id, item));
    }
    return out;
  }
  if (isPlainObject(input)) {
    const obj = input;
    if (Array.isArray(obj.screens)) return normalizeScreenSpecs(obj.screens, typeof obj.template === "string" ? obj.template : defaultTemplate);
    if (isPlainObject(obj.screens)) {
      const tpl = typeof obj.template === "string" ? obj.template : defaultTemplate;
      for (const [id, v] of Object.entries(obj.screens)) {
        const spec = fromObject(id, isPlainObject(v) ? v : {});
        out.push({ ...spec, template: spec.template ?? tpl });
      }
      return out;
    }
    if (typeof obj.id === "string") return [fromObject(obj.id, obj)];
    for (const [k, v] of Object.entries(obj)) {
      if (k === "screens" || k === "template" || k === "cloneEdges") continue;
      out.push(fromObject(k, isPlainObject(v) ? v : {}));
    }
  }
  return out;
}

function normalizeEdgeSpecs(input: unknown): EdgeSpec[] {
  if (input == null) return [];
  if (Array.isArray(input)) {
    return input.filter((item): item is EdgeSpec => isPlainObject(item) && typeof item.from === "string" && typeof item.to === "string");
  }
  if (isPlainObject(input)) {
    if (Array.isArray(input.edges)) return normalizeEdgeSpecs(input.edges);
    if (typeof input.from === "string" && typeof input.to === "string") return [input as unknown as EdgeSpec];
  }
  return [];
}

// ---------------------------------------------------------------------------
// Staging

function stageScreens(st: Stage, input: unknown, defaultTemplate: string | undefined, options: RegisterOptions): void {
  for (const spec of normalizeScreenSpecs(input, defaultTemplate)) {
    const tpl = spec.template ?? spec.cloneFrom ?? spec.from ?? defaultTemplate;
    const newId = tpl && !spec.id.startsWith(`${tpl}:`) ? `${tpl}:${spec.id}` : spec.id;
    if (hasScreen(st, newId)) continue;

    const base = tpl ? getScreen(st, tpl) : undefined;
    if (tpl && !base) throw new UnknownScreenError(tpl);

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
          id: uniqueEdgeId(st, from, to),
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

function stageEdges(st: Stage, input: unknown): void {
  for (const spec of normalizeEdgeSpecs(input)) {
    for (const end of [spec.from, spec.to]) if (!hasScreen(st, end)) throw new UnknownScreenError(end);
    st.edges.push({
      id: uniqueEdgeId(st, spec.from, spec.to, spec.id),
      from: spec.from,
      to: spec.to,
      cost: typeof spec.cost === "number" ? spec.cost : 1,
      condition: spec.condition ? parseCondition(spec.condition) : undefined,
      actions: (spec.actions ?? []).map((a) => ({ type: a.type, data: a.data ? cloneJson(a.data) : {} })),
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
 * `registerScreens(tree, ids, template?, options?)` or, using the shared
 * default tree, `registerScreens(ids, template?, options?)`.
 */
export function registerScreens(...args: unknown[]): NavigationTree {
  const { tree, rest } = splitTarget(args);
  const [input, third, fourth] = rest;
  const template = typeof third === "string" ? third : undefined;
  const options = (isPlainObject(third) ? third : isPlainObject(fourth) ? fourth : {}) as RegisterOptions;
  const defaultTemplate =
    template ?? (isPlainObject(input) && typeof input.template === "string" ? input.template : undefined);
  const st = newStage(tree);
  stageScreens(st, input, defaultTemplate, options);
  commit(st);
  return tree;
}

/** Register edges (transitions) on a tree in place. Returns the same tree. */
export function registerEdges(...args: unknown[]): NavigationTree {
  const { tree, rest } = splitTarget(args);
  const st = newStage(tree);
  stageEdges(st, rest[0]);
  commit(st);
  return tree;
}

/**
 * Register an action node under a screen: the parent screen gets an edge to the
 * new node, and the node gets an edge to `targetScreenId` (default the parent)
 * carrying the actions. Returns the same tree.
 */
export function registerActions(...args: unknown[]): NavigationTree {
  const { tree, rest } = splitTarget(args);
  const [screenId, actionsInput, targetScreenId] = rest;
  const parent = String(screenId);
  const destination = typeof targetScreenId === "string" ? targetScreenId : parent;
  const normalized = Array.isArray(actionsInput)
    ? actionsInput
    : isPlainObject(actionsInput) && Array.isArray(actionsInput.actions)
      ? actionsInput.actions
      : isPlainObject(actionsInput)
        ? Object.entries(actionsInput).map(([type, value]) => ({ type, data: value }))
        : [];
  const actionId = isPlainObject(actionsInput) && typeof actionsInput.id === "string" ? actionsInput.id : `${parent}:action`;

  const st = newStage(tree);
  if (!hasScreen(st, actionId)) {
    st.screens.set(actionId, {
      id: actionId,
      name: isPlainObject(actionsInput) && typeof actionsInput.name === "string" ? actionsInput.name : `Action ${actionId}`,
      meta: { kind: "action" } as JsonObject,
      index: st.nextScreen++,
      dynamic: true,
    });
  }
  stageEdges(st, [
    { from: parent, to: actionId, actions: [] },
    { from: actionId, to: destination, actions: normalized },
  ]);
  commit(st);
  return tree;
}

/** Apply `{ screens, edges, template }` in one call. Returns the same tree. */
export function augmentTree(...args: unknown[]): NavigationTree {
  const { tree, rest } = splitTarget(args);
  const patch = rest[0];
  if (isPlainObject(patch)) {
    const st = newStage(tree);
    if (patch.screens) stageScreens(st, patch.screens, typeof patch.template === "string" ? patch.template : undefined, {});
    if (patch.edges) stageEdges(st, patch.edges);
    commit(st);
  }
  return tree;
}

// ---------------------------------------------------------------------------
// Removal

export type ScreenSelector = string | readonly string[] | { template: string };

function selectIds(tree: NavigationTree, selector: unknown): string[] {
  if (typeof selector === "string") return [selector];
  if (Array.isArray(selector)) return selector.filter((x): x is string => typeof x === "string");
  if (isPlainObject(selector) && typeof selector.template === "string") {
    return [...tree.screens.values()].filter((s) => s.dynamic && s.template === selector.template).map((s) => s.id);
  }
  return [];
}

/**
 * Remove dynamic screens (and every edge touching them). Accepts an id, a list
 * of ids, or `{ template }` to remove every instance of a template. Unknown ids
 * are ignored so the call is safe to repeat. Screens that came from the graph
 * file cannot be removed. Returns the same tree.
 */
export function unregisterScreens(...args: unknown[]): NavigationTree {
  const { tree, rest } = splitTarget(args);
  const ids = selectIds(tree, rest[0]).filter((id) => tree.hasScreen(id));
  for (const id of ids) {
    if (!tree.screen(id).dynamic) {
      throw new AppNavError("NOT_DYNAMIC", `Screen "${id}" came from the graph file and cannot be unregistered`, { ids: [id] });
    }
  }
  for (const id of ids) tree._removeScreen(id);
  return tree;
}

/** Remove dynamic edges by id. Unknown ids are ignored; file edges cannot be removed. Returns the same tree. */
export function unregisterEdges(...args: unknown[]): NavigationTree {
  const { tree, rest } = splitTarget(args);
  const ids = new Set(selectIds(tree, rest[0]));
  const blocked = tree.edges.filter((e) => ids.has(e.id) && !e.dynamic);
  if (blocked.length > 0) {
    throw new AppNavError("NOT_DYNAMIC", `Edge "${blocked[0]?.id}" came from the graph file and cannot be unregistered`, { ids: blocked.map((e) => e.id) });
  }
  tree._removeEdges((e) => ids.has(e.id));
  return tree;
}

/** Remove everything added at runtime, leaving the file graph. Returns the same tree. */
export function clearDynamic(...args: unknown[]): NavigationTree {
  const { tree } = splitTarget(args);
  tree._removeEdges((e) => e.dynamic === true);
  for (const s of [...tree.screens.values()]) if (s.dynamic) tree._removeScreen(s.id);
  return tree;
}

/** An independent deep copy of a tree (the default tree when omitted). Changes to the copy never touch the original. */
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
// Instance methods

declare module "./graph" {
  interface NavigationTree {
    registerScreens(input: unknown, template?: string | RegisterOptions, options?: RegisterOptions): NavigationTree;
    addScreens(input: unknown, template?: string | RegisterOptions, options?: RegisterOptions): NavigationTree;
    registerEdges(input: unknown): NavigationTree;
    addEdges(input: unknown): NavigationTree;
    registerActions(screenId: string, actions: unknown, targetScreenId?: string): NavigationTree;
    unregisterScreens(selector: ScreenSelector): NavigationTree;
    unregisterEdges(ids: string | readonly string[]): NavigationTree;
    clearDynamic(): NavigationTree;
    clone(): NavigationTree;
    cloneTree(): NavigationTree;
  }
}

const proto = NavigationTree.prototype as unknown as Record<string, (this: NavigationTree, ...a: unknown[]) => unknown>;
proto.registerScreens = proto.addScreens = function (...a) {
  return registerScreens(this, ...a);
};
proto.registerEdges = proto.addEdges = function (...a) {
  return registerEdges(this, ...a);
};
proto.registerActions = function (...a) {
  return registerActions(this, ...a);
};
proto.unregisterScreens = function (...a) {
  return unregisterScreens(this, ...a);
};
proto.unregisterEdges = function (...a) {
  return unregisterEdges(this, ...a);
};
proto.clearDynamic = function () {
  return clearDynamic(this);
};
proto.clone = proto.cloneTree = function () {
  return cloneTree(this);
};

// ---------------------------------------------------------------------------
// Aliases (consolidated in a later change)

export type DynamicTree = NavigationTree;
export const addScreens = registerScreens;
export const registerScreen = registerScreens;
export const addScreen = registerScreens;
export const addEdges = registerEdges;
export const registerEdge = registerEdges;
export const addEdge = registerEdges;
export const addActions = registerActions;
export const registerAction = registerActions;
export const copyTree = cloneTree;
export const forkTree = cloneTree;
export const registerTransition = registerEdges;
export const registerTransitions = registerEdges;
export const registerTemplate = registerScreens;
export const registerTemplates = registerScreens;
export const cloneNavigationTree = cloneTree;

export const register_screens = registerScreens;
export const register_screen = registerScreens;
export const add_screens = registerScreens;
export const add_screen = registerScreens;
export const register_edges = registerEdges;
export const register_edge = registerEdges;
export const add_edges = registerEdges;
export const add_edge = registerEdges;
export const register_actions = registerActions;
export const register_action = registerActions;
export const add_actions = registerActions;
export const add_action = registerActions;
export const unregister_screens = unregisterScreens;
export const unregister_edges = unregisterEdges;
export const clear_dynamic = clearDynamic;
export const clone_tree = cloneTree;
