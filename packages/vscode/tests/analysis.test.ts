import { describe, expect, it } from "vitest";
import { tryCalculatePath, indexGraph, parseGraph } from "routegraph";
import {
  actionSnippet,
  analyze,
  describeScreen,
  describeVariable,
  findDeclaredId,
  indexDeclarations,
  insideString,
  parseVariableInput,
  requiredVariables,
  routeVariables,
  schemaOrDefault,
  toPreviewModel,
  toRouteModel,
} from "../src/analysis";

const GOOD = `NAVGRAPH/2
APP "Shop"
VAR PRODUCT_ID : string
VAR SIGNED_IN : boolean = false

SCREEN home "Home"
SCREEN shop "Shop"
SCREEN cart "Cart"
SCREEN admin "Admin"

home -> shop { DO TAP { "target": "Shop" } }
shop -> home { DO BACK {} }
shop -> cart [cost=2] { DO TAP { "target": "Cart", "match": { "id": "$PRODUCT_ID$" } } }
cart -> admin [if=SIGNED_IN] { DO TAP { "target": "Admin" } }
END
`;

describe("analyze", () => {
  it("accepts a valid graph", () => {
    const r = analyze(GOOD);
    expect(r.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    expect(r.tree?.screens.size).toBe(4);
  });

  it("maps a syntax error to a line and column without the location suffix", () => {
    const r = analyze("NAVGRAPH/2\nSCREEN home\n");
    expect(r.graph).toBeUndefined();
    expect(r.diagnostics).toHaveLength(1);
    const d = r.diagnostics[0]!;
    expect(d.severity).toBe("error");
    expect(d.line).toBeGreaterThan(0);
    expect(d.message).not.toMatch(/\(<input>/);
  });

  it("reports unknown screens but still returns a tree", () => {
    const r = analyze(GOOD.replace("shop -> home", "shop -> nowhere"));
    const err = r.diagnostics.find((d) => d.code === "UNKNOWN_SCREEN");
    expect(err?.line).toBeGreaterThan(0);
    expect(r.tree).toBeDefined();
    expect(r.graph).toBeDefined();
  });
});

describe("text helpers", () => {
  it("detects strings and ignores # comments", () => {
    const line = 'DO TAP { "target": "home" } # "x"';
    expect(insideString(line, line.indexOf("home") + 1)).toBe(true);
    expect(insideString(line, line.indexOf("TAP"))).toBe(false);
    expect(insideString(line, line.length - 2)).toBe(false);
  });

  it("finds a declared id only on its own line", () => {
    expect(findDeclaredId('SCREEN shop "Shop"', "SCREEN", "shop")).toEqual({ start: 7, end: 11 });
    expect(findDeclaredId('SCREEN shopping "Shop"', "SCREEN", "shop")).toBeUndefined();
    expect(findDeclaredId("VAR QTY : number", "VAR", "QTY")).toEqual({ start: 4, end: 7 });
  });

  it("indexes declarations with 0-based lines", () => {
    const graph = parseGraph(GOOD);
    const idx = indexDeclarations(graph, GOOD.split("\n"));
    expect(idx.screens.get("shop")).toEqual({ line: 6, start: 7, end: 11 });
    expect(idx.variables.get("PRODUCT_ID")?.line).toBe(2);
  });
});

describe("hover text", () => {
  const r = analyze(GOOD);
  it("describes a screen with its exits", () => {
    const md = describeScreen(r.tree!, "shop")!;
    expect(md).toContain("**Shop** `shop`");
    expect(md).toContain("`cart` (cost 2)");
  });
  it("says so when a screen has no exits", () => {
    expect(describeScreen(r.tree!, "admin")).toContain("No way out");
  });
  it("describes variables", () => {
    expect(describeVariable(r.graph!, "SIGNED_IN")).toContain("= false");
    expect(describeVariable(r.graph!, "PRODUCT_ID")).toContain("Required");
    expect(describeVariable(r.graph!, "MISSING")).toBeUndefined();
  });
});

describe("snippets", () => {
  it("builds snippets from required properties", () => {
    const schema = schemaOrDefault(undefined);
    expect(actionSnippet("TAP", schema)).toBe('TAP { "target": "${1}" }$0');
    expect(actionSnippet("BACK", schema)).toBe("BACK {$0}");
    expect(actionSnippet("SET_STATE", schema)).toContain('"key": "${1}"');
  });
});

describe("models", () => {
  const r = analyze(GOOD);
  it("builds a preview model with lines", () => {
    const m = toPreviewModel(r.graph!, r.tree!);
    expect(m.app).toBe("Shop");
    expect(m.screens.map((s) => s.id)).toEqual(["home", "shop", "cart", "admin"]);
    expect(m.edges.find((e) => e.id === "shop->cart")?.cost).toBe(2);
    expect(m.edges.find((e) => e.id === "cart->admin")?.condition).toBe("SIGNED_IN");
  });

  it("builds a route model with ordered steps", () => {
    const res = tryCalculatePath(r.tree!, "home", "cart", "astar", {
      variables: routeVariables(r.tree!),
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const route = toRouteModel(res.path);
    expect(route.screens).toEqual(["home", "shop", "cart"]);
    expect(route.steps.map((s) => s.n)).toEqual([1, 2]);
    expect(route.steps[0]!.summary).toContain('TAP "Shop"');
    expect(route.cost).toBe(3);
  });

  it("respects conditions through route variables", () => {
    const blocked = tryCalculatePath(r.tree!, "home", "admin", "astar", { variables: routeVariables(r.tree!) });
    expect(blocked.ok).toBe(false);
    const open = tryCalculatePath(r.tree!, "home", "admin", "astar", {
      variables: routeVariables(r.tree!, { SIGNED_IN: true }),
    });
    expect(open.ok).toBe(true);
  });

  it("lists required variables and parses typed input", () => {
    expect(requiredVariables(r.tree!)).toEqual([{ name: "PRODUCT_ID", type: "string" }]);
    expect(parseVariableInput("3", "number")).toBe(3);
    expect(parseVariableInput("TRUE", "boolean")).toBe(true);
    expect(parseVariableInput('{"a":1}', "object")).toEqual({ a: 1 });
    expect(parseVariableInput("not json", "array")).toBe("not json");
  });
});

describe("indexGraph sanity", () => {
  it("keeps working on a graph with an invalid edge in collect mode", () => {
    const graph = parseGraph(GOOD.replace("shop -> home", "shop -> nowhere"));
    const tree = indexGraph(graph, { diagnostics: "collect" });
    expect(tree.diagnostics.some((d) => d.code === "UNKNOWN_SCREEN")).toBe(true);
  });
});

import { bracketDepthAt, lineState } from "../src/analysis";

describe("line state and brackets", () => {
  it("classifies code, strings and comments", () => {
    const line = 'a -> b { DO TAP { "target": "x # y" } } # note';
    expect(lineState(line, 2)).toBe("code");
    expect(lineState(line, line.indexOf("x # y") + 3)).toBe("string");
    expect(lineState(line, line.indexOf("note"))).toBe("comment");
  });

  it("counts open brackets outside strings and comments", () => {
    const text = 'a -> b {\n  DO TAP { "target": "}" }\n  # {\n';
    expect(bracketDepthAt(text, text.length)).toBe(1);
    expect(bracketDepthAt("a -> b { }\n", 11)).toBe(0);
  });
});
