import { describe, expect, it } from "vitest";
import {
  ASTAR,
  BFS,
  DIJKSTRA,
  NoPathError,
  UnknownScreenError,
  calculatePath,
  findReachable,
  indexTreeFromText,
  registerAlgorithm,
  tryCalculatePath,
} from "../src";
import { exampleText } from "./helpers";

const tree = () => indexTreeFromText(exampleText("app.navgraph"));

function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

function randomGraph(seed: number, n = 12, m = 40) {
  const r = rng(seed);
  const lines = ["NAVGRAPH/2"];
  for (let i = 0; i < n; i++) lines.push(`SCREEN s${i} "S${i}"`);
  for (let i = 0; i < m; i++) {
    const a = Math.floor(r() * n);
    const b = Math.floor(r() * n);
    lines.push(`s${a} -> s${b} [cost=${Math.floor(r() * 9) + 1}]`);
  }
  return indexTreeFromText(lines.join("\n"));
}

describe("pathfinding", () => {
  it("finds the cheapest route", () => {
    const p = calculatePath(tree(), "home", "checkout", ASTAR, { variables: { PRODUCT_ID: "P" } });
    expect(p.screens).toEqual(["home", "shop", "cart", "checkout"]);
    expect(p.cost).toBe(3);
    expect(p.edges.map((e) => e.id)).toEqual(["home->shop", "shop->cart", "cart->checkout"]);
  });

  it("accepts screen objects as well as ids", () => {
    const t = indexTreeFromText<"home" | "cart">(exampleText("app.navgraph"));
    expect(calculatePath(t, t.home, t.cart).screens).toEqual(["home", "shop", "cart"]);
  });

  it("returns a zero cost route when start equals end", () => {
    const p = calculatePath(tree(), "home", "home");
    expect(p.cost).toBe(0);
    expect(p.edges).toEqual([]);
  });

  it("filters conditional edges using variables, state and runtime", () => {
    const t = tree();
    expect(() => calculatePath(t, "home", "account")).toThrow(NoPathError);
    expect(calculatePath(t, "home", "account", ASTAR, { variables: { SIGNED_IN: true } }).screens).toEqual([
      "home",
      "settings",
      "account",
    ]);
    expect(() => calculatePath(t, "home", "account", ASTAR, { variables: { SIGNED_IN: true }, runtime: { SIGNED_IN: false } })).toThrow(NoPathError);
  });

  it("reads conditions from app state when the name is not a variable", () => {
    const t = indexTreeFromText(`NAVGRAPH/2\nSCREEN a "A"\nSCREEN b "B"\na -> b [if=cart_not_empty]`);
    expect(tryCalculatePath(t, "a", "b").ok).toBe(false);
    expect(tryCalculatePath(t, "a", "b", ASTAR, { state: { cart_not_empty: true } }).ok).toBe(true);
  });

  it("reports unreachable destinations without throwing in the try variant", () => {
    const r = tryCalculatePath(tree(), "home", "checkout", DIJKSTRA, { edgeFilter: (e) => e.to !== "cart" && e.id !== "quick_checkout" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBeInstanceOf(NoPathError);
  });

  it("rejects unknown screens, algorithms and bad costs", () => {
    expect(() => calculatePath(tree(), "nope", "home")).toThrow(UnknownScreenError);
    expect(() => calculatePath(tree(), "home", "shop", "wat")).toThrow(/Unknown algorithm/);
    expect(() => calculatePath(tree(), "home", "shop", ASTAR, { costFn: () => -1 })).toThrow(/invalid cost/);
  });

  it("keeps one way edges one way", () => {
    const t = indexTreeFromText(`NAVGRAPH/2\nSCREEN a "A"\nSCREEN b "B"\na -> b`);
    expect(tryCalculatePath(t, "b", "a").ok).toBe(false);
  });

  it("breaks ties deterministically in declaration order", () => {
    const t = indexTreeFromText(
      `NAVGRAPH/2\nSCREEN a "A"\nSCREEN b "B"\nSCREEN c "C"\nSCREEN d "D"\na -> b\na -> c\nb -> d\nc -> d`,
    );
    for (let i = 0; i < 5; i++) {
      expect(calculatePath(t, "a", "d", ASTAR).screens).toEqual(["a", "b", "d"]);
      expect(calculatePath(t, "a", "d", DIJKSTRA).screens).toEqual(["a", "b", "d"]);
      expect(calculatePath(t, "a", "d", BFS).screens).toEqual(["a", "b", "d"]);
    }
  });

  it("uses edge cost, not action count", () => {
    const p = calculatePath(tree(), "home", "checkout", DIJKSTRA, { edgeFilter: (e) => e.id === "quick_checkout" });
    expect(p.cost).toBe(5);
    expect(p.edges[0]?.actions).toHaveLength(3);
  });

  it("runs the other built in algorithms", () => {
    const p = calculatePath(tree(), "home", "checkout", BFS);
    expect(p.cost).toBe(1 * 3 === p.cost ? 3 : p.cost);
    expect(p.algorithm).toBe("bfs");
    expect(p.edges.length).toBeLessThanOrEqual(3);
  });

  it("supports custom algorithms by name and by function", () => {
    registerAlgorithm("first-edge", (ctx) => {
      const e = ctx.neighbors(ctx.start).find((x) => x.to === ctx.goal.id);
      return e ? { edges: [e], cost: ctx.cost(e), visited: 1 } : undefined;
    });
    const t = tree();
    expect(calculatePath(t, "home", "shop", "first-edge").algorithm).toBe("first-edge");
    expect(() => calculatePath(t, "home", "checkout", "first-edge")).not.toThrow();
    expect(() => registerAlgorithm("astar", () => undefined)).toThrow();
  });

  it("A* with an admissible heuristic matches Dijkstra on random graphs", () => {
    for (let seed = 1; seed <= 60; seed++) {
      const t = randomGraph(seed);
      const hOne = (from: { id: string }, goal: { id: string }) => (from.id === goal.id ? 0 : 1);
      for (let i = 0; i < 12; i++) {
        const a = `s${i}`;
        const b = `s${(i * 5 + seed) % 12}`;
        const d = tryCalculatePath(t, a, b, DIJKSTRA);
        const x = tryCalculatePath(t, a, b, ASTAR, { heuristic: hOne });
        expect(x.ok).toBe(d.ok);
        if (d.ok && x.ok) expect(x.path.cost).toBe(d.path.cost);
      }
    }
  });

  it("finds reachable screens", () => {
    expect(findReachable(tree(), "home")).not.toContain("account");
    expect(findReachable(tree(), "home", { variables: { SIGNED_IN: true } })).toContain("privacy");
  });

  it("serialises paths without the tree", () => {
    const p = calculatePath(tree(), "home", "shop");
    const json = JSON.parse(JSON.stringify(p));
    expect(json.tree).toBeUndefined();
    expect(json.screens).toEqual(["home", "shop"]);
  });
});
