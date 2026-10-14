import { evaluateCondition, type ConditionOperator } from "./conditions";
import { AppNavError, NoPathError, UnknownScreenError } from "./errors";
import type { NavigationTree } from "./graph";
import type { Edge, JsonValue, Screen } from "./types";
import { buildScope } from "./variables";

export const ASTAR = "astar" as const;
export const DIJKSTRA = "dijkstra" as const;
export const BFS = "bfs" as const;

export type BuiltinAlgorithm = typeof ASTAR | typeof DIJKSTRA | typeof BFS;

export type Heuristic = (from: Screen, goal: Screen, tree: NavigationTree) => number;

export interface SearchContext {
  readonly tree: NavigationTree;
  readonly start: Screen;
  readonly goal: Screen;
  /** Traversable edges leaving a screen, already filtered by conditions, in declaration order. */
  neighbors(screen: Screen): readonly Edge[];
  /** Validated edge cost. */
  cost(edge: Edge): number;
  heuristic(screen: Screen): number;
}

export interface SearchResult {
  edges: Edge[];
  cost: number;
  visited: number;
}

/** A pathfinding algorithm. Return undefined when the goal is unreachable. */
export type PathfindingAlgorithm = (ctx: SearchContext) => SearchResult | undefined;

export type AlgorithmRef = BuiltinAlgorithm | (string & {}) | PathfindingAlgorithm;

export interface PathOptions {
  /** Route input variables. Used for condition evaluation and stored on the path. */
  variables?: Readonly<Record<string, JsonValue>>;
  /** Runtime values. Override route inputs. */
  runtime?: Readonly<Record<string, JsonValue>>;
  /** Application state looked up by conditions when a name is not a variable. */
  state?: Readonly<Record<string, unknown>>;
  /** Heuristic for A*. Must be admissible for optimal routes. Default 0. */
  heuristic?: Heuristic;
  /** Override the cost of an edge, for example to penalise risky transitions. Must return a finite number >= 0. */
  costFn?: (edge: Edge) => number;
  /** Extra veto on edges. Return false to exclude an edge. */
  edgeFilter?: (edge: Edge) => boolean;
  /** Extra word operators for conditions. */
  conditionOperators?: Readonly<Record<string, ConditionOperator>>;
  /** Throw when a condition refers to an unknown value. Default false. */
  strictConditions?: boolean;
  /** Reject route variables that are not declared in the graph. */
  strictVariables?: boolean;
}

/** One leg of a route planned with `planRoute`. `leg` is a 0-based index. */
export interface PathLeg {
  readonly leg: number;
  readonly from: string;
  readonly to: string;
  /** Number of edges (steps) in this leg. Zero when the leg starts where it ends. */
  readonly steps: number;
}

export interface Path {
  readonly from: string;
  readonly to: string;
  /** Screen ids in order, including both ends. */
  readonly screens: string[];
  readonly edges: Edge[];
  readonly cost: number;
  readonly algorithm: string;
  /** Number of nodes expanded by the search. */
  readonly visited: number;
  /** Route variables supplied to calculatePath. */
  readonly variables: Record<string, JsonValue>;
  /** Leg boundaries, present only on paths made by `planRoute`. */
  readonly legs?: readonly PathLeg[];
  /** Owning tree (not enumerable, so JSON.stringify(path) stays clean). */
  readonly tree: NavigationTree;
}

export type PathResult =
  | { ok: true; path: Path }
  | { ok: false; error: NoPathError };

const algorithms = new Map<string, PathfindingAlgorithm>();

/** Register a custom algorithm so it can be selected by name. */
export function registerAlgorithm(name: string, fn: PathfindingAlgorithm): void {
  if (name === ASTAR || name === DIJKSTRA || name === BFS) {
    throw new AppNavError("INVALID_OPTION", `"${name}" is a built in algorithm and cannot be replaced`);
  }
  algorithms.set(name, fn);
}

// ---- binary heap ---------------------------------------------------------

interface HeapItem {
  f: number;
  h: number;
  seq: number;
  node: string;
  g: number;
}

class Heap {
  private a: HeapItem[] = [];
  get size() {
    return this.a.length;
  }
  private less(x: HeapItem, y: HeapItem) {
    if (x.f !== y.f) return x.f < y.f;
    if (x.h !== y.h) return x.h < y.h;
    return x.seq < y.seq;
  }
  push(item: HeapItem) {
    const a = this.a;
    a.push(item);
    let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (!this.less(a[i] as HeapItem, a[p] as HeapItem)) break;
      [a[i], a[p]] = [a[p] as HeapItem, a[i] as HeapItem];
      i = p;
    }
  }
  pop(): HeapItem | undefined {
    const a = this.a;
    if (a.length === 0) return undefined;
    const top = a[0] as HeapItem;
    const last = a.pop() as HeapItem;
    if (a.length > 0) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const l = i * 2 + 1;
        const r = l + 1;
        let m = i;
        if (l < a.length && this.less(a[l] as HeapItem, a[m] as HeapItem)) m = l;
        if (r < a.length && this.less(a[r] as HeapItem, a[m] as HeapItem)) m = r;
        if (m === i) break;
        [a[i], a[m]] = [a[m] as HeapItem, a[i] as HeapItem];
        i = m;
      }
    }
    return top;
  }
}

function rebuild(prev: Map<string, Edge>, goal: string): Edge[] {
  const edges: Edge[] = [];
  let at = goal;
  for (let e = prev.get(at); e; e = prev.get(at)) {
    edges.push(e);
    at = e.from;
  }
  return edges.reverse();
}

function bestFirst(ctx: SearchContext, useHeuristic: boolean): SearchResult | undefined {
  const { start, goal, tree } = ctx;
  const h = (s: Screen) => (useHeuristic ? ctx.heuristic(s) : 0);
  const best = new Map<string, number>([[start.id, 0]]);
  const prev = new Map<string, Edge>();
  const heap = new Heap();
  let seq = 0;
  let visited = 0;
  heap.push({ f: h(start), h: h(start), seq: seq++, node: start.id, g: 0 });
  for (let item = heap.pop(); item; item = heap.pop()) {
    if (item.g > (best.get(item.node) ?? Infinity)) continue; // stale entry
    visited++;
    if (item.node === goal.id) return { edges: rebuild(prev, goal.id), cost: item.g, visited };
    const screen = tree.screen(item.node);
    for (const edge of ctx.neighbors(screen)) {
      const g = item.g + ctx.cost(edge);
      if (g < (best.get(edge.to) ?? Infinity)) {
        best.set(edge.to, g);
        prev.set(edge.to, edge);
        const hv = h(tree.screen(edge.to));
        heap.push({ f: g + hv, h: hv, seq: seq++, node: edge.to, g });
      }
    }
  }
  return undefined;
}

function breadthFirst(ctx: SearchContext): SearchResult | undefined {
  const { start, goal, tree } = ctx;
  const prev = new Map<string, Edge>();
  const seen = new Set<string>([start.id]);
  const queue: string[] = [start.id];
  let visited = 0;
  for (let head = 0; head < queue.length; head++) {
    const id = queue[head] as string;
    visited++;
    if (id === goal.id) {
      const edges = rebuild(prev, id);
      return { edges, cost: edges.reduce((sum, e) => sum + ctx.cost(e), 0), visited };
    }
    for (const edge of ctx.neighbors(tree.screen(id))) {
      if (!seen.has(edge.to)) {
        seen.add(edge.to);
        prev.set(edge.to, edge);
        queue.push(edge.to);
      }
    }
  }
  return undefined;
}

const BUILTIN: Record<BuiltinAlgorithm, PathfindingAlgorithm> = {
  astar: (ctx) => bestFirst(ctx, true),
  dijkstra: (ctx) => bestFirst(ctx, false),
  bfs: breadthFirst,
};

function resolveScreen(tree: NavigationTree, ref: string | Screen): Screen {
  const id = typeof ref === "string" ? ref : ref.id;
  const s = tree.screens.get(id);
  if (!s) throw new UnknownScreenError(id);
  return s;
}

/**
 * Compute a route between two screens without throwing for "no route".
 * Unknown screens and invalid options still throw.
 */
export function tryCalculatePath(
  tree: NavigationTree,
  start: string | Screen,
  end: string | Screen,
  algorithm: AlgorithmRef = ASTAR,
  options: PathOptions = {},
): PathResult {
  const from = resolveScreen(tree, start);
  const to = resolveScreen(tree, end);
  const fn =
    typeof algorithm === "function"
      ? algorithm
      : (BUILTIN as Record<string, PathfindingAlgorithm>)[algorithm] ?? algorithms.get(algorithm);
  if (!fn) throw new AppNavError("UNKNOWN_ALGORITHM", `Unknown algorithm "${String(algorithm)}"`, { ids: [String(algorithm)] });
  const label = typeof algorithm === "function" ? algorithm.name || "custom" : algorithm;

  const scope = buildScope(tree.variables, {
    variables: options.variables,
    runtime: options.runtime,
    strict: options.strictVariables,
  });
  const condCtx = { variables: scope, state: options.state };
  const condOpts = { operators: options.conditionOperators, strict: options.strictConditions };

  const available = (e: Edge) =>
    (!e.condition || evaluateCondition(e.condition, condCtx, condOpts)) && (!options.edgeFilter || options.edgeFilter(e));

  const costCache = new Map<Edge, number>();
  const cost = (e: Edge) => {
    let c = costCache.get(e);
    if (c === undefined) {
      c = options.costFn ? options.costFn(e) : e.cost;
      if (typeof c !== "number" || !Number.isFinite(c) || c < 0) {
        throw new AppNavError("INVALID_COST", `Edge "${e.id}" has an invalid cost (${String(c)}). Costs must be finite and non-negative`, { ids: [e.id] });
      }
      costCache.set(e, c);
    }
    return c;
  };

  const ctx: SearchContext = {
    tree,
    start: from,
    goal: to,
    neighbors: (s) => tree.outgoing(s.id).filter(available),
    cost,
    heuristic: (s) => {
      if (!options.heuristic) return 0;
      const v = options.heuristic(s, to, tree);
      return Number.isFinite(v) && v > 0 ? v : 0;
    },
  };

  const found = from.id === to.id ? { edges: [], cost: 0, visited: 1 } : fn(ctx);
  if (!found) return { ok: false, error: new NoPathError(from.id, to.id, label) };

  const screens = [from.id, ...found.edges.map((e) => e.to)];
  const path = {
    from: from.id,
    to: to.id,
    screens,
    edges: found.edges,
    cost: found.cost,
    algorithm: label,
    visited: found.visited,
    variables: { ...(options.variables ?? {}), ...(options.runtime ?? {}) } as Record<string, JsonValue>,
  } as Path;
  Object.defineProperty(path, "tree", { value: tree, enumerable: false });
  return { ok: true, path };
}

/** Compute a route. Throws NoPathError when the destination is unreachable. */
export function calculatePath(
  tree: NavigationTree,
  start: string | Screen,
  end: string | Screen,
  algorithm: AlgorithmRef = ASTAR,
  options: PathOptions = {},
): Path {
  const r = tryCalculatePath(tree, start, end, algorithm, options);
  if (!r.ok) throw r.error;
  return r.path;
}

/** Ids of every screen reachable from `start` under the given conditions (BFS). */
export function findReachable(tree: NavigationTree, start: string | Screen, options: PathOptions = {}): string[] {
  const from = resolveScreen(tree, start);
  const scope = buildScope(tree.variables, { variables: options.variables, runtime: options.runtime });
  const seen = new Set<string>([from.id]);
  const queue = [from.id];
  for (let i = 0; i < queue.length; i++) {
    for (const e of tree.outgoing(queue[i] as string)) {
      const ok =
        (!e.condition ||
          evaluateCondition(e.condition, { variables: scope, state: options.state }, { operators: options.conditionOperators, strict: options.strictConditions })) &&
        (!options.edgeFilter || options.edgeFilter(e));
      if (ok && !seen.has(e.to)) {
        seen.add(e.to);
        queue.push(e.to);
      }
    }
  }
  return [...seen];
}
