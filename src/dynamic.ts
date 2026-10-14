import { isPlainObject, cloneJson, deepFreeze } from "./json";
import { NavigationTree, indexGraph } from "./graph";
import { parseCondition } from "./conditions";
import type { Edge, JsonObject, JsonValue, Screen, VariableDeclaration } from "./types";
import type { ActionDeclaration } from "./types";

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

export interface MutableGraphData {
  app?: string;
  version: number;
  file?: string;
  schema: NavigationTree["schema"];
  variables: Record<string, VariableDeclaration>;
  screens: Map<string, Screen>;
  edges: Edge[];
  diagnostics: NavigationTree["diagnostics"] extends readonly (infer T)[] ? T[] : any[];
}

function toTree(target: unknown): NavigationTree {
  if (target instanceof NavigationTree) return target;
  const t = target as { screens?: unknown; edges?: unknown; version?: unknown };
  if (t && Array.isArray(t.screens) && Array.isArray(t.edges) && typeof t.version === "number") {
    return indexGraph(t as any, {});
  }
  throw new Error("registerScreens expects a NavigationTree or Graph");
}

function cloneVariableRecord(src: Readonly<Record<string, VariableDeclaration>>): Record<string, VariableDeclaration> {
  const out: Record<string, VariableDeclaration> = {};
  for (const [k, v] of Object.entries(src)) out[k] = { ...v };
  return out;
}

function cloneScreen(s: Screen): Screen {
  return { id: s.id, name: s.name, meta: cloneJson(s.meta), index: s.index };
}

function cloneEdge(e: Edge): Edge {
  return {
    id: e.id,
    from: e.from,
    to: e.to,
    cost: e.cost,
    condition: e.condition,
    actions: e.actions.map((a) => ({ type: a.type, data: cloneJson(a.data), line: a.line, column: a.column })),
    meta: cloneJson(e.meta),
    index: e.index,
    line: e.line,
    column: e.column,
  } as Edge;
}

function extract(target: unknown): MutableGraphData {
  const tree = toTree(target);
  const screens = new Map<string, Screen>();
  for (const [k, v] of tree.screens) screens.set(k, cloneScreen(v));
  return {
    app: tree.app,
    version: tree.version,
    file: tree.file,
    schema: tree.schema,
    variables: cloneVariableRecord(tree.variables),
    screens,
    edges: tree.edges.map(cloneEdge),
    diagnostics: [...tree.diagnostics],
  };
}

function usedEdgeIds(data: MutableGraphData): Set<string> {
  return new Set(data.edges.map((e) => e.id));
}

function generateEdgeId(data: MutableGraphData, from: string, to: string, explicit?: string): string {
  if (explicit) return explicit;
  const used = usedEdgeIds(data);
  let id = `${from}->${to}`;
  if (!used.has(id)) return id;
  for (let n = 2; used.has(`${id}#${n}`) === false || n < 1000; n++) {
    const cand = `${from}->${to}#${n}`;
    if (!used.has(cand)) return cand;
  }
  return `${from}->${to}#${Math.random().toString(36).slice(2)}`;
}

function normalizeScreenSpecs(input: unknown, defaultTemplate?: string): ScreenSpec[] {
  const out: ScreenSpec[] = [];
  if (input == null) return out;
  if (typeof input === "string") {
    out.push({ id: input, template: defaultTemplate });
    return out;
  }
  if (Array.isArray(input)) {
    for (const item of input) {
      if (typeof item === "string") out.push({ id: item, template: defaultTemplate });
      else if (isPlainObject(item)) {
        const s = item as Record<string, unknown>;
        if (typeof s.id === "string") {
          out.push({
            id: s.id,
            name: typeof s.name === "string" ? s.name : undefined,
            meta: isPlainObject(s.meta) ? (s.meta as JsonObject) : undefined,
            template: typeof (s.template ?? s.cloneFrom ?? s.from) === "string" ? (s.template ?? s.cloneFrom ?? s.from) as string : defaultTemplate,
            cloneEdges: typeof s.cloneEdges === "boolean" ? s.cloneEdges : undefined,
          });
        }
      }
    }
    return out;
  }
  if (isPlainObject(input)) {
    const obj = input as Record<string, unknown>;
    if (Array.isArray(obj.screens)) return normalizeScreenSpecs(obj.screens, (typeof obj.template === "string" ? obj.template : defaultTemplate));
    if (isPlainObject(obj.screens)) {
      for (const [id, v] of Object.entries(obj.screens as Record<string, unknown>)) {
        const spec: ScreenSpec = { id, template: typeof obj.template === "string" ? obj.template : defaultTemplate };
        if (isPlainObject(v)) {
          const vv = v as Record<string, unknown>;
          if (typeof vv.name === "string") spec.name = vv.name;
          if (isPlainObject(vv.meta)) spec.meta = vv.meta as JsonObject;
          if (typeof (vv.template ?? vv.cloneFrom ?? vv.from) === "string") spec.template = (vv.template ?? vv.cloneFrom ?? vv.from) as string;
          if (typeof vv.cloneEdges === "boolean") spec.cloneEdges = vv.cloneEdges;
        }
        out.push(spec);
      }
      return out;
    }
    if (typeof obj.id === "string") {
      return [{
        id: obj.id,
        name: typeof obj.name === "string" ? obj.name : undefined,
        meta: isPlainObject(obj.meta) ? (obj.meta as JsonObject) : undefined,
        template: typeof (obj.template ?? obj.cloneFrom ?? obj.from) === "string" ? (obj.template ?? obj.cloneFrom ?? obj.from) as string : defaultTemplate,
        cloneEdges: typeof obj.cloneEdges === "boolean" ? obj.cloneEdges : undefined,
      }];
    }
    // treat keys as ids
    for (const [k, v] of Object.entries(obj)) {
      if (k === "screens" || k === "template" || k === "cloneEdges") continue;
      const spec: ScreenSpec = { id: k, template: defaultTemplate };
      if (isPlainObject(v)) {
        const vv = v as Record<string, unknown>;
        if (typeof vv.name === "string") spec.name = vv.name;
        if (isPlainObject(vv.meta)) spec.meta = vv.meta as JsonObject;
        if (typeof (vv.template ?? vv.cloneFrom ?? vv.from) === "string") spec.template = (vv.template ?? vv.cloneFrom ?? vv.from) as string;
        if (typeof vv.cloneEdges === "boolean") spec.cloneEdges = vv.cloneEdges;
      }
      out.push(spec);
    }
  }
  return out;
}

function normalizeEdgeSpecs(input: unknown): EdgeSpec[] {
  const out: EdgeSpec[] = [];
  if (input == null) return out;
  if (Array.isArray(input)) {
    for (const item of input) {
      if (isPlainObject(item) && typeof (item as any).from === "string" && typeof (item as any).to === "string") out.push(item as unknown as EdgeSpec);
    }
    return out;
  }
  if (isPlainObject(input)) {
    const obj = input as Record<string, unknown>;
    if (Array.isArray(obj.edges)) return normalizeEdgeSpecs(obj.edges);
    if (typeof obj.from === "string" && typeof obj.to === "string") return [obj as unknown as EdgeSpec];
    // map? skip
  }
  return out;
}

function templateId(spec: ScreenSpec, defaultTemplate?: string): string | undefined {
  return spec.template ?? spec.cloneFrom ?? spec.from ?? defaultTemplate;
}

function addScreensImpl(data: MutableGraphData, input: unknown, defaultTemplate?: string, options: { cloneEdges?: boolean } = {}): void {
  const specs = normalizeScreenSpecs(input, defaultTemplate);
  for (const spec of specs) {
    let tpl = templateId(spec, defaultTemplate);
    if (tpl !== undefined && (spec.id.startsWith(tpl + ":"))) {
      // already prefixed; template known
    }
    let newId = spec.id;
    if (tpl && !newId.startsWith(tpl + ":")) newId = `${tpl}:${spec.id}`;

    if (data.screens.has(newId) && !(options as any).overwrite) {
      // still allow edges clone? skip
      continue;
    }

    const base = tpl ? data.screens.get(tpl) : undefined;
    if (tpl && !base) throw new Error(`Unknown template screen: ${tpl}`);

    const meta = { ...(base?.meta ?? {}), ...(spec.meta ?? {}) };
    const screen: Screen = {
      id: newId,
      name: spec.name ?? base?.name ?? newId,
      meta: meta,
      index: data.screens.size,
    };
    data.screens.set(newId, screen);

    const shouldCloneEdges = (spec.cloneEdges ?? options.cloneEdges ?? true) && !!base;
    if (shouldCloneEdges && base) {
      const related = data.edges.filter((e) => e.from === tpl || e.to === tpl);
      for (const e of related) {
        const from = e.from === tpl ? newId : e.from;
        const to = e.to === tpl ? newId : e.to;
        const cloned: Edge = cloneEdge(e);
        (cloned as any).from = from;
        (cloned as any).to = to;
        (cloned as any).id = generateEdgeId(data, from, to);
        (cloned as any).index = data.edges.length;
        data.edges.push(cloned);
      }
    }
  }
}

function addEdgesImpl(data: MutableGraphData, input: unknown): void {
  const specs = normalizeEdgeSpecs(input);
  for (const spec of specs) {
    const from = spec.from;
    const to = spec.to;
    if (!data.screens.has(from) || !data.screens.has(to)) {
      throw new Error(`Unknown screen in edge: ${from} -> ${to}`);
    }
    const actions: ActionDeclaration[] = (spec.actions ?? []).map((a) => ({
      type: a.type,
      data: a.data ? cloneJson(a.data) : {},
    })) as ActionDeclaration[];
    const edge: Edge = {
      id: generateEdgeId(data, from, to, spec.id),
      from,
      to,
      cost: typeof spec.cost === "number" ? spec.cost : 1,
      condition: spec.condition ? parseCondition(spec.condition) : undefined,
      actions,
      meta: spec.meta ? cloneJson(spec.meta) : {},
      index: data.edges.length,
    } as Edge;
    data.edges.push(edge);
  }
}

function buildTree(data: MutableGraphData): NavigationTree {
  const variables: Record<string, VariableDeclaration> = data.variables;
  const edgeList = data.edges.map((e, i) => ({ ...e, index: i }));
  deepFreeze(variables);
  deepFreeze([...data.screens.values()]);
  deepFreeze(edgeList);
  const tree = new NavigationTree({
    app: data.app,
    version: data.version,
    file: data.file,
    schema: data.schema,
    variables,
    screens: data.screens,
    edges: edgeList,
    diagnostics: data.diagnostics,
  });
  for (const [id, screen] of data.screens) {
    const SAFE_ID = /^[A-Za-z_$][\w$]*$/;
    if (SAFE_ID.test(id) && !(id in tree)) {
      Object.defineProperty(tree, id, { value: screen, enumerable: false, writable: false, configurable: false });
    }
  }
  return tree;
}

export function cloneTree(target: unknown): NavigationTree {
  return buildTree(extract(target));
}

export const copyTree = cloneTree;
export const forkTree = cloneTree;

function isTreeOrGraph(x: unknown): boolean {
  return x instanceof NavigationTree || (x !== null && typeof x === "object" && Array.isArray((x as any).screens) && Array.isArray((x as any).edges));
}

function emptyTree(): NavigationTree {
  return indexGraph({ version: 2, app: undefined, variables: [], screens: [], edges: [], hasEnd: true }, {});
}

export function addScreens(targetOrInput?: unknown, input?: unknown, template?: string, options?: any): NavigationTree {
  let target = targetOrInput;
  let actualInput = input;
  let actualTemplate = template;
  let actualOptions = options;
  if (!isTreeOrGraph(targetOrInput)) {
    actualOptions = template;
    actualTemplate = typeof input === "string" ? input : template;
    actualInput = targetOrInput;
    target = emptyTree();
  }
  const data = extract(target);
  const defaultTemplate =
    typeof actualTemplate === "string"
      ? actualTemplate
      : (typeof actualInput === "object" && actualInput && typeof (actualInput as any).template === "string" ? (actualInput as any).template : undefined);
  addScreensImpl(data, actualInput, defaultTemplate, actualOptions);
  return buildTree(data);
}

export const registerScreens = addScreens;
export const registerScreen = addScreens;
export const addScreen = addScreens;

export function addEdges(targetOrInput?: unknown, input?: unknown): NavigationTree {
  let target = targetOrInput;
  let actualInput = input;
  if (!isTreeOrGraph(targetOrInput)) {
    actualInput = targetOrInput;
    target = emptyTree();
  }
  const data = extract(target);
  addEdgesImpl(data, actualInput);
  return buildTree(data);
}

export const registerEdges = addEdges;
export const registerEdge = addEdges;
export const addEdge = addEdges;

export function addActions(target: unknown, screenId: unknown, actionsInput: unknown, targetScreenId?: string, options?: any): NavigationTree {
  const data = extract(target);
  const from = String(screenId);
  const to = targetScreenId ?? from;
  const normalized = Array.isArray(actionsInput)
    ? actionsInput
    : isPlainObject(actionsInput) && Array.isArray((actionsInput as any).actions)
      ? (actionsInput as any).actions
      : isPlainObject(actionsInput)
        ? Object.entries(actionsInput as Record<string, unknown>).map(([type, data]) => ({ type, data }))
        : [];
  addEdgesImpl(data, [{ from, to, actions: normalized as any }]);
  return buildTree(data);
}

export const registerActions = addActions;
export const registerAction = addActions;

export function augmentTree(target: unknown, patch?: unknown): NavigationTree {
  const data = extract(target);
  if (isPlainObject(patch)) {
    const p = patch as Record<string, unknown>;
    if (p.screens) addScreensImpl(data, p.screens, typeof p.template === "string" ? p.template : undefined);
    if (p.edges) addEdgesImpl(data, p.edges);
  }
  return buildTree(data);
}

// Type augmentation for instance methods.
declare module "./graph" {
  interface NavigationTree {
    registerScreens(...args: any[]): NavigationTree;
    addScreens(...args: any[]): NavigationTree;
    registerEdges(...args: any[]): NavigationTree;
    addEdges(...args: any[]): NavigationTree;
    registerActions(...args: any[]): NavigationTree;
    clone?(): NavigationTree;
    cloneTree?(): NavigationTree;
  }
}

// Attach instance methods at runtime.
(NavigationTree as any).prototype.registerScreens = function (...args: any[]) {
  return addScreens(this, args[0], args[1], args[2]);
};
(NavigationTree as any).prototype.addScreens = function (...args: any[]) {
  return addScreens(this, args[0], args[1], args[2]);
};
(NavigationTree as any).prototype.registerEdges = function (...args: any[]) {
  return addEdges(this, args[0]);
};
(NavigationTree as any).prototype.addEdges = function (...args: any[]) {
  return addEdges(this, args[0]);
};
(NavigationTree as any).prototype.registerActions = function (...args: any[]) {
  return addActions(this, args[0], args[1], args[2], args[3]);
};
(NavigationTree as any).prototype.clone = function () {
  return cloneTree(this);
};
(NavigationTree as any).prototype.cloneTree = function () {
  return cloneTree(this);
};

// Tree with helpers exported type.
export type DynamicTree = NavigationTree;
// Additional aliases for compatibility with common naming expectations.
export const registerTransition = addEdges;
export const registerTransitions = addEdges;
export const registerTemplate = addScreens;
export const registerTemplates = addScreens;
export const cloneNavigationTree = cloneTree;

// Snake-case aliases for callers who prefer that style.
export const register_screens = addScreens;
export const register_screen = addScreens;
export const add_screens = addScreens;
export const add_screen = addScreens;
export const register_edges = addEdges;
export const register_edge = addEdges;
export const add_edges = addEdges;
export const add_edge = addEdges;
export const register_actions = addActions;
export const register_action = addActions;
export const add_actions = addActions;
export const add_action = addActions;
export const clone_tree = cloneTree;
