import {
  conditionOperatorNames,
  conditionRefs,
  parseCondition,
  BUILTIN_OPERATORS,
  type ConditionOperator,
} from "./conditions";
import { AppNavError, UnknownScreenError, ValidationError } from "./errors";
import { setDefaultTree } from "./default-tree";
import { defaultReadFile } from "./files";
import { deepFreeze, setOwn } from "./json";
import { parseGraph, type ParseOptions } from "./parser";
import {
  loadSchema,
  toResolvedSchema,
  validateAgainst,
  type ResolvedSchema,
  type SchemaDefinition,
} from "./schema";
import type {
  ActionDeclaration,
  Condition,
  Diagnostic,
  Edge,
  Graph,
  JsonObject,
  ReadFile,
  Screen,
  VariableDeclaration,
} from "./types";
import { collectReferences, matchesType, typeOfValue } from "./variables";

export interface ValidateOptions {
  /** Require condition identifiers to be declared VARs. Default false (unknown names are looked up in app state). */
  strictConditions?: boolean;
  /** Allow `$NAME$` references to variables that are not declared. Default false. */
  allowUndeclaredVariables?: boolean;
  /** Extra word operators permitted in conditions. */
  conditionOperators?: Readonly<Record<string, ConditionOperator>>;
}

export interface ValidationResult {
  ok: boolean;
  errors: Diagnostic[];
  warnings: Diagnostic[];
  diagnostics: Diagnostic[];
}

/** Everything a single screen or edge needs to be validated on its own. */
export interface RecordValidationEnv {
  schema: ResolvedSchema;
  /** Declared variables, used to check `$NAME$` references. */
  declarations: Readonly<Record<string, VariableDeclaration>>;
  /** Whether a screen id exists (including screens about to be added). */
  hasScreen(id: string): boolean;
  options?: ValidateOptions;
  file?: string;
}

const diag = (
  env: RecordValidationEnv,
  code: string,
  message: string,
  at?: { line?: number; column?: number },
  ids?: string[],
): Diagnostic => ({ severity: "error", code, message, file: env.file, line: at?.line, column: at?.column, ids });

/** Validate one screen against the schema. Used for parsed screens and for runtime registration. */
export function validateScreenRecord(
  screen: { id: string; meta: JsonObject; line?: number; column?: number },
  env: RecordValidationEnv,
): Diagnostic[] {
  const out: Diagnostic[] = [];
  for (const [key, sub] of Object.entries(env.schema.screenMetadata)) {
    if (key in screen.meta) {
      for (const p of validateAgainst(screen.meta[key], sub, `screen "${screen.id}" metadata ${key}`)) {
        out.push(diag(env, "INVALID_SCREEN_METADATA", p, screen, [screen.id]));
      }
    }
  }
  return out;
}

/**
 * Validate one edge: endpoints, cost, condition, metadata, action types and
 * payloads, and variable references. Used for parsed edges and for runtime
 * registration, so both get identical checks.
 */
export function validateEdgeRecord(
  e: {
    id?: string;
    from: string;
    to: string;
    cost?: number;
    condition?: string | { source: string };
    actions: readonly ActionDeclaration[];
    meta: JsonObject;
    line?: number;
    column?: number;
  },
  env: RecordValidationEnv,
): Diagnostic[] {
  const out: Diagnostic[] = [];
  const err = (code: string, message: string, at?: { line?: number; column?: number }, ids?: string[]) =>
    out.push(diag(env, code, message, at, ids));
  const options = env.options ?? {};
  const operators = { ...BUILTIN_OPERATORS, ...(options.conditionOperators ?? {}) };
  const label = e.id ?? `${e.from}->${e.to}`;

  if (!env.hasScreen(e.from)) err("UNKNOWN_SCREEN", `Edge "${label}" references unknown screen "${e.from}"`, e, [label, e.from]);
  if (!env.hasScreen(e.to)) err("UNKNOWN_SCREEN", `Edge "${label}" references unknown screen "${e.to}"`, e, [label, e.to]);
  if (e.cost !== undefined && (!Number.isFinite(e.cost) || e.cost < 0)) {
    err("INVALID_COST", `Edge "${label}" has invalid cost ${e.cost}. Costs must be finite and non-negative`, e, [label]);
  }
  if (e.condition !== undefined) {
    try {
      const cond = parseCondition(typeof e.condition === "string" ? e.condition : e.condition.source);
      for (const op of conditionOperatorNames(cond.ast)) {
        if (!["==", "!=", "<", "<=", ">", ">="].includes(op) && !operators[op]) {
          err("UNKNOWN_OPERATOR", `Edge "${label}" uses unknown condition operator "${op}"`, e, [label, op]);
        }
      }
      if (options.strictConditions) {
        for (const ref of conditionRefs(cond.ast)) {
          const root = ref.split(".")[0] as string;
          if (!env.declarations[root]) err("UNKNOWN_CONDITION_VARIABLE", `Edge "${label}" condition references undeclared variable "${root}"`, e, [label, root]);
        }
      }
    } catch (ex) {
      err("INVALID_CONDITION", ex instanceof AppNavError ? ex.message : String(ex), e, [label]);
    }
  }
  for (const [key, sub] of Object.entries(env.schema.edgeMetadata)) {
    if (key in e.meta) {
      for (const p of validateAgainst(e.meta[key], sub, `edge "${label}" attribute ${key}`)) {
        err("INVALID_EDGE_METADATA", p, e, [label]);
      }
    }
  }
  e.actions.forEach((a, i) => {
    const where = { line: a.line, column: a.column };
    const def = env.schema.actions[a.type];
    if (!def) {
      err("UNKNOWN_ACTION", `Unknown action type "${a.type}" on edge "${label}"`, where, [label, a.type]);
    } else {
      for (const p of validateAgainst(a.data, { ...def, type: "object" }, `edge "${label}" action ${i + 1} (${a.type})`, {
        declarations: env.declarations,
      })) {
        err("INVALID_ACTION_PAYLOAD", p, where, [label, a.type]);
      }
    }
    if (!options.allowUndeclaredVariables) {
      for (const name of collectReferences(a.data)) {
        if (!env.declarations[name]) err("UNDEFINED_VARIABLE", `Edge "${label}" action ${i + 1} uses undeclared variable "${name}"`, where, [label, name]);
      }
    }
  });
  return out;
}

/** Semantic validation of a parsed graph. Never throws for graph problems. */
export function validateGraph(
  graph: Graph,
  schema?: SchemaDefinition | ResolvedSchema,
  options: ValidateOptions = {},
): ValidationResult {
  const resolved = toResolvedSchema(schema);
  const out: Diagnostic[] = [];
  const file = graph.file;
  const add = (
    severity: Diagnostic["severity"],
    code: string,
    message: string,
    at?: { line?: number; column?: number },
    ids?: string[],
  ) => out.push({ severity, code, message, file, line: at?.line, column: at?.column, ids });
  const err = (code: string, message: string, at?: { line?: number; column?: number }, ids?: string[]) =>
    add("error", code, message, at, ids);

  // Variables
  const decls: Record<string, VariableDeclaration> = {};
  for (const v of graph.variables) {
    if (Object.prototype.hasOwnProperty.call(decls, v.name)) {
      err("DUPLICATE_VARIABLE", `Duplicate variable "${v.name}"`, v, [v.name]);
      continue;
    }
    setOwn(decls, v.name, v);
    if (v.hasDefault && !matchesType(v.default, v.type)) {
      err(
        "VARIABLE_TYPE_MISMATCH",
        `Default for "${v.name}" must be ${v.type}, got ${typeOfValue(v.default)}`,
        v,
        [v.name],
      );
    }
  }

  const screens = new Set(graph.screens.map((s) => s.id));
  const env: RecordValidationEnv = { schema: resolved, declarations: decls, hasScreen: (id) => screens.has(id), options, file };

  // Screens
  const seenScreens = new Set<string>();
  for (const s of graph.screens) {
    if (seenScreens.has(s.id)) err("DUPLICATE_SCREEN", `Duplicate screen id "${s.id}"`, s, [s.id]);
    seenScreens.add(s.id);
    out.push(...validateScreenRecord(s, env));
  }

  // Edges
  const explicit = new Set<string>();
  for (const e of graph.edges) {
    if (e.id !== undefined) {
      if (explicit.has(e.id)) err("DUPLICATE_EDGE", `Duplicate edge id "${e.id}"`, e, [e.id]);
      explicit.add(e.id);
    }
    out.push(...validateEdgeRecord(e, env));
  }

  const errors = out.filter((d) => d.severity === "error");
  const warnings = out.filter((d) => d.severity === "warning");
  return { ok: errors.length === 0, errors, warnings, diagnostics: out };
}

/** Throws a ValidationError when the result has errors. */
export function assertValid(result: ValidationResult, file?: string): void {
  if (!result.ok) throw new ValidationError(result.diagnostics, file);
}

// ---------------------------------------------------------------------------
// Tree

export interface IndexOptions extends ParseOptions, ValidateOptions {
  /** A schema object, or a resolved schema. For file paths use indexTree(). */
  schema?: SchemaDefinition | ResolvedSchema;
  /** Cost applied to edges that do not declare one. Default 1. */
  defaultCost?: number;
  /** "throw" (default) raises ValidationError. "collect" keeps going and records tree.diagnostics. */
  diagnostics?: "throw" | "collect";
  /** Make the new tree the shared default used by registration functions. Default false. */
  setAsDefault?: boolean;
}

export interface IndexFileOptions extends Omit<IndexOptions, "schema"> {
  /** Schema object, resolved schema, or path to a .navschema JSON file. */
  schema?: string | SchemaDefinition | ResolvedSchema;
  /** Custom file reader. Required in runtimes without Node's fs (React Native). */
  readFile?: ReadFile;
}

const SAFE_ID = /^[A-Za-z_$][\w$]*$/;

/**
 * Methods and data shared by every tree.
 *
 * A tree loaded from a file is fixed, but trees are live objects: screens and
 * edges registered at runtime (see `registerScreens`) are added in place and
 * flagged `dynamic`. Screens and edges that came from the file are never
 * removed by the dynamic API.
 */
export class NavigationTree {
  readonly app?: string;
  readonly version: number;
  readonly file?: string;
  readonly schema: ResolvedSchema;
  readonly variables: Readonly<Record<string, VariableDeclaration>>;
  readonly screens: ReadonlyMap<string, Screen>;
  readonly edges: readonly Edge[];
  readonly diagnostics: readonly Diagnostic[];
  private readonly adjacency: Map<string, Edge[]>;
  private readonly reverse: Map<string, Edge[]>;
  private screenCounter = 0;
  private edgeCounter = 0;

  constructor(parts: {
    app?: string;
    version: number;
    file?: string;
    schema: ResolvedSchema;
    variables: Record<string, VariableDeclaration>;
    screens: Map<string, Screen>;
    edges: Edge[];
    diagnostics: Diagnostic[];
  }) {
    this.app = parts.app;
    this.version = parts.version;
    this.file = parts.file;
    this.schema = parts.schema;
    this.variables = parts.variables;
    this.screens = parts.screens;
    this.edges = parts.edges;
    this.diagnostics = [...parts.diagnostics];
    this.adjacency = new Map();
    this.reverse = new Map();
    for (const s of parts.screens.values()) {
      this.adjacency.set(s.id, []);
      this.reverse.set(s.id, []);
      this.screenCounter = Math.max(this.screenCounter, s.index + 1);
    }
    for (const e of parts.edges) {
      this.adjacency.get(e.from)?.push(e);
      this.reverse.get(e.to)?.push(e);
      this.edgeCounter = Math.max(this.edgeCounter, e.index + 1);
    }
    for (const s of parts.screens.values()) this.defineShortcut(s);
  }

  /** `tree.<id>` shortcut for ids that are safe identifiers and do not collide with members. */
  private defineShortcut(screen: Screen): void {
    if (SAFE_ID.test(screen.id) && !(screen.id in this)) {
      Object.defineProperty(this, screen.id, { value: screen, enumerable: false, writable: false, configurable: true });
    }
  }

  /** Authoritative lookup. Throws UnknownScreenError when missing. */
  screen(id: string): Screen {
    const s = this.screens.get(id);
    if (!s) throw new UnknownScreenError(id);
    return s;
  }

  hasScreen(id: string): boolean {
    return this.screens.has(id);
  }

  /** Edges leaving a screen, in declaration order. */
  outgoing(id: string): readonly Edge[] {
    return this.adjacency.get(id) ?? [];
  }

  incoming(id: string): readonly Edge[] {
    return this.reverse.get(id) ?? [];
  }

  edge(id: string): Edge | undefined {
    return this.edges.find((e) => e.id === id);
  }

  /** Plain JSON snapshot of the graph. */
  toJSON(): JsonObject {
    return JSON.parse(
      JSON.stringify({
        app: this.app,
        version: this.version,
        variables: this.variables,
        screens: [...this.screens.values()],
        edges: this.edges.map((e) => ({ ...e, condition: e.condition?.source })),
      }),
    ) as JsonObject;
  }

  // -- Internal mutation primitives. The dynamic registration API is the public way to use these.

  /** @internal Next free declaration index for a screen. */
  _nextScreenIndex(): number {
    return this.screenCounter;
  }

  /** @internal Next free declaration index for an edge. */
  _nextEdgeIndex(): number {
    return this.edgeCounter;
  }

  /** @internal Add a screen and maintain adjacency and the `tree.<id>` shortcut. */
  _addScreen(screen: Screen): void {
    (this.screens as Map<string, Screen>).set(screen.id, screen);
    this.adjacency.set(screen.id, []);
    this.reverse.set(screen.id, []);
    this.screenCounter = Math.max(this.screenCounter, screen.index + 1);
    this.defineShortcut(screen);
  }

  /** @internal Add an edge. Both endpoints must already exist. */
  _addEdge(edge: Edge): void {
    (this.edges as Edge[]).push(edge);
    this.adjacency.get(edge.from)?.push(edge);
    this.reverse.get(edge.to)?.push(edge);
    this.edgeCounter = Math.max(this.edgeCounter, edge.index + 1);
  }

  /** @internal Remove every edge matching the predicate. Returns the removed edges. */
  _removeEdges(match: (edge: Edge) => boolean): Edge[] {
    const all = this.edges as Edge[];
    const removed = all.filter(match);
    if (removed.length === 0) return removed;
    const gone = new Set(removed);
    for (let i = all.length - 1; i >= 0; i--) if (gone.has(all[i] as Edge)) all.splice(i, 1);
    for (const list of [...this.adjacency.values(), ...this.reverse.values()]) {
      for (let i = list.length - 1; i >= 0; i--) if (gone.has(list[i] as Edge)) list.splice(i, 1);
    }
    return removed;
  }

  /** @internal Remove a screen, its edges and its shortcut. Returns the removed edges. */
  _removeScreen(id: string): Edge[] {
    const screen = this.screens.get(id);
    if (!screen) return [];
    const removed = this._removeEdges((e) => e.from === id || e.to === id);
    (this.screens as Map<string, Screen>).delete(id);
    this.adjacency.delete(id);
    this.reverse.delete(id);
    const desc = Object.getOwnPropertyDescriptor(this, id);
    if (desc && desc.value === screen) delete (this as unknown as Record<string, unknown>)[id];
    return removed;
  }

  /** @internal Append diagnostics produced by dynamic registration. */
  _addDiagnostics(items: readonly Diagnostic[]): void {
    (this.diagnostics as Diagnostic[]).push(...items);
  }
}

type Reserved = keyof NavigationTree;

/**
 * A tree plus `tree.<screenId>` shortcuts. Provide the ids as a type argument
 * for typed shortcuts: `indexTree<"home" | "cart">(...)`. Without a type
 * argument only the core API is typed; use `tree.screen("id")`.
 */
export type NavTree<Id extends string = string> = NavigationTree &
  (string extends Id
    ? unknown
    : { readonly [K in Exclude<Id, Reserved | "constructor" | "__proto__">]: Screen });

export function indexGraph<Id extends string = string>(graph: Graph, options: IndexOptions = {}): NavTree<Id> {
  const schema = toResolvedSchema(options.schema);
  const result = validateGraph(graph, schema, options);
  if (!result.ok && options.diagnostics !== "collect") throw new ValidationError(result.diagnostics, graph.file);
  const defaultCost = options.defaultCost ?? 1;
  if (!Number.isFinite(defaultCost) || defaultCost < 0) {
    throw new AppNavError("INVALID_OPTION", "defaultCost must be a finite, non-negative number");
  }

  const variables: Record<string, VariableDeclaration> = {};
  for (const v of graph.variables) if (!(v.name in variables)) setOwn(variables, v.name, v);

  const screens = new Map<string, Screen>();
  for (const s of graph.screens) {
    if (screens.has(s.id)) continue;
    screens.set(s.id, { id: s.id, name: s.name, meta: s.meta, index: screens.size });
  }

  const used = new Set(graph.edges.flatMap((e) => (e.id !== undefined ? [e.id] : [])));
  const edges: Edge[] = [];
  const seenExplicit = new Set<string>();
  graph.edges.forEach((e, index) => {
    let id = e.id;
    if (id === undefined) {
      const base = `${e.from}->${e.to}`;
      id = base;
      for (let n = 2; used.has(id); n++) id = `${base}#${n}`;
      used.add(id);
    } else if (seenExplicit.has(id)) {
      return; // duplicate (collect mode); keep first
    } else seenExplicit.add(id);
    let condition: Condition | undefined;
    if (e.condition !== undefined) {
      try {
        condition = parseCondition(e.condition);
      } catch {
        return; // reported by validateGraph in collect mode
      }
    }
    if (!screens.has(e.from) || !screens.has(e.to)) return;
    const cost = e.cost ?? defaultCost;
    if (!Number.isFinite(cost) || cost < 0) return;
    edges.push({
      id,
      from: e.from,
      to: e.to,
      cost,
      condition,
      actions: e.actions,
      meta: e.meta,
      index,
      line: e.line,
      column: e.column,
    });
  });

  deepFreeze(variables);
  deepFreeze([...screens.values()]);
  for (const e of edges) deepFreeze(e);

  const tree = new NavigationTree({
    app: graph.app,
    version: graph.version,
    file: graph.file,
    schema,
    variables,
    screens,
    edges,
    diagnostics: result.diagnostics,
  });
  if (options.setAsDefault) setDefaultTree(tree);
  return tree as NavTree<Id>;
}

/** Synchronous: parse, validate and index graph text that is already in memory. */
export function indexTreeFromText<Id extends string = string>(text: string, options: IndexOptions = {}): NavTree<Id> {
  return indexGraph<Id>(parseGraph(text, options), options);
}

/** Async: read a .navgraph file (and optional schema file), then parse, validate and index it. */
export async function indexTree<Id extends string = string>(
  path: string,
  options: IndexFileOptions = {},
): Promise<NavTree<Id>> {
  const read = options.readFile ?? defaultReadFile;
  const text = await read(path);
  const schema =
    typeof options.schema === "string"
      ? await loadSchema(options.schema, { readFile: read })
      : (options.schema as SchemaDefinition | ResolvedSchema | undefined);
  return indexTreeFromText<Id>(text, { ...options, file: options.file ?? path, schema });
}

