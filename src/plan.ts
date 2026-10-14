import { AppNavError, UnknownScreenError } from "./errors";
import type { NavigationTree } from "./graph";
import { buildInstructions, buildInstructionsSync, type BuildOptions, type Instructions } from "./instructions";
import { ASTAR, tryCalculatePath, type AlgorithmRef, type Path, type PathLeg, type PathOptions } from "./pathfinding";
import type { Edge, JsonValue } from "./types";
import { parseTemplate } from "./variables";

/**
 * Plan one route through several stops. The app decides where the user is
 * (`from`), what has to happen and where to end up. routegraph only plans each
 * leg from the end of the previous one and stitches the legs together. It never
 * tracks position and never decides that someone is off track.
 */

/** Go to a screen. */
export interface ScreenWaypoint {
  screen: string;
}

/**
 * Perform an action node, then stay on it. `repeat` replaces the repeat of the
 * actions on the step into the node: a whole number of at least 1, or one
 * `$NAME$` reference filled from the route `variables`.
 */
export interface ActionWaypoint {
  action: string;
  repeat?: number | string;
}

export type Waypoint = ScreenWaypoint | ActionWaypoint;

export interface PlanOptions extends PathOptions {
  /** Algorithm for every leg. Default A*. */
  algorithm?: AlgorithmRef;
  /** Options for building the combined instructions. Route variables are shared with `variables`. */
  build?: BuildOptions;
}

export type PlanFailure = { ok: false; leg: number; error: AppNavError };
export type PlanResult = { ok: true; path: Path; instructions: Instructions } | PlanFailure;
export type PlanAsyncResult = { ok: true; path: Path; instructions: Instructions } | PlanFailure;

type Planned = { ok: true; path: Path } | PlanFailure;

function checkWaypoints(tree: NavigationTree, waypoints: readonly Waypoint[]): void {
  const usage = `planRoute(tree, "cart", [{ action: "decrease_quantity", repeat: 4 }, { screen: "tutorial_end" }])`;
  if (!Array.isArray(waypoints) || waypoints.length === 0) {
    throw new AppNavError("INVALID_WAYPOINT", `planRoute needs a non-empty array of waypoints. Use ${usage}`);
  }
  waypoints.forEach((w, i) => {
    const o = w as unknown as Record<string, unknown>;
    const isScreen = typeof o?.screen === "string";
    const isAction = typeof o?.action === "string";
    if (!o || typeof o !== "object" || isScreen === isAction) {
      throw new AppNavError("INVALID_WAYPOINT", `Waypoint ${i} must be { screen } or { action, repeat? }. Use ${usage}`, { ids: [] });
    }
    const extra = Object.keys(o).filter((k) => !(isScreen ? ["screen"] : ["action", "repeat"]).includes(k));
    if (extra.length > 0) {
      throw new AppNavError("INVALID_WAYPOINT", `Waypoint ${i} has unknown ${extra.map((k) => `"${k}"`).join(", ")}${isScreen && "repeat" in o ? ". Only action waypoints take repeat" : ""}`);
    }
    if (isAction) {
      const id = o.action as string;
      if (tree.hasScreen(id) && tree.screen(id).meta.kind !== "action") {
        throw new AppNavError("INVALID_WAYPOINT", `Waypoint ${i}: "${id}" is a screen, not an action node. Use { screen: "${id}" }`, { ids: [id] });
      }
      const r = o.repeat;
      if (r !== undefined) {
        const segs = typeof r === "string" ? parseTemplate(r) : [];
        const okNumber = typeof r === "number" && Number.isInteger(r) && r >= 1;
        const okVar = typeof r === "string" && segs.length === 1 && segs[0]?.kind === "var";
        if (!okNumber && !okVar) {
          throw new AppNavError("INVALID_REPEAT", `Waypoint ${i} has invalid repeat ${JSON.stringify(r)}. Use a whole number of at least 1 or a single $NAME$ reference`, { ids: [id] });
        }
      }
    }
  });
}

function plan(tree: NavigationTree, from: string, waypoints: readonly Waypoint[], options: PlanOptions): Planned {
  checkWaypoints(tree, waypoints);
  const { algorithm = ASTAR, build: _build, ...pathOptions } = options;
  void _build;

  const edges: Edge[] = [];
  const screens: string[] = [];
  const legs: PathLeg[] = [];
  let cost = 0;
  let visited = 0;
  let label = typeof algorithm === "function" ? algorithm.name || "custom" : algorithm;
  let at = from;

  for (let i = 0; i < waypoints.length; i++) {
    const w = waypoints[i] as Waypoint;
    const target = "screen" in w ? w.screen : w.action;
    let result;
    try {
      result = tryCalculatePath(tree, at, target, algorithm, pathOptions);
    } catch (e) {
      if (e instanceof UnknownScreenError) return { ok: false, leg: i, error: e };
      throw e;
    }
    if (!result.ok) return { ok: false, leg: i, error: result.error };
    const leg = result.path;
    let legEdges = leg.edges;
    if ("action" in w && w.repeat !== undefined) {
      const last = legEdges[legEdges.length - 1];
      if (!last || last.actions.length === 0) {
        const why = last ? `the step into "${target}" has no actions to repeat` : `the app is already on "${target}", so there is no step to repeat`;
        return { ok: false, leg: i, error: new AppNavError("INVALID_WAYPOINT", `Waypoint ${i}: ${why}`, { ids: [target] }) };
      }
      const repeat = w.repeat;
      legEdges = [...legEdges.slice(0, -1), { ...last, actions: last.actions.map((a) => ({ ...a, repeat })) }];
    }
    if (i === 0) label = leg.algorithm;
    edges.push(...legEdges);
    // Each leg starts where the previous one ended, so its first screen is already listed.
    screens.push(...(i === 0 ? leg.screens : leg.screens.slice(1)));
    legs.push({ leg: i, from: at, to: target, steps: legEdges.length });
    cost += leg.cost;
    visited += leg.visited;
    at = target;
  }

  const path = {
    from,
    to: at,
    screens,
    edges,
    cost,
    algorithm: label,
    visited,
    variables: { ...(pathOptions.variables ?? {}), ...(pathOptions.runtime ?? {}) } as Record<string, JsonValue>,
    legs,
  } as unknown as Path;
  Object.defineProperty(path, "tree", { value: tree, enumerable: false });
  return { ok: true, path };
}

/**
 * Plan from `from` through each waypoint in order and return one combined
 * `Path` and one `Instructions`. Each leg starts where the previous one ended,
 * so an action node you stop on is simply the start of the next leg (the edge
 * out of it is empty and free). Steps carry `leg` (0-based) and the
 * instructions list the leg boundaries.
 *
 * When a leg cannot be planned, returns `{ ok: false, leg, error }` with the
 * 0-based index of the failing leg, so the app can decide what to do. Bad
 * waypoint shapes throw `INVALID_WAYPOINT`. Variable problems found while
 * building instructions throw, as they do for `buildInstructions`.
 *
 * Uses `buildInstructionsSync`; use `planRouteAsync` when extensions are async.
 */
export function planRoute(tree: NavigationTree, from: string, waypoints: readonly Waypoint[], options: PlanOptions = {}): PlanResult {
  const planned = plan(tree, from, waypoints, options);
  if (!planned.ok) return planned;
  return { ok: true, path: planned.path, instructions: buildInstructionsSync(planned.path, options.build) };
}

/** Same as `planRoute`, building the instructions with the async `buildInstructions`. */
export async function planRouteAsync(
  tree: NavigationTree,
  from: string,
  waypoints: readonly Waypoint[],
  options: PlanOptions = {},
): Promise<PlanAsyncResult> {
  const planned = plan(tree, from, waypoints, options);
  if (!planned.ok) return planned;
  return { ok: true, path: planned.path, instructions: await buildInstructions(planned.path, options.build) };
}
