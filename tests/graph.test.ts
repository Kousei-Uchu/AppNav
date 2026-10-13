import { describe, expect, it, vi } from "vitest";
import {
  NavigationTree,
  ValidationError,
  indexTree,
  indexTreeFromText,
  parseGraph,
  validateGraph,
  type NavTree,
} from "../src";
import { examplePath, exampleText } from "./helpers";

const g = (body: string) => `NAVGRAPH/2\nSCREEN a "A"\nSCREEN b "B"\n${body}\n`;
const codes = (text: string, opts = {}) => validateGraph(parseGraph(text), undefined, opts).errors.map((e) => e.code);

describe("validation", () => {
  it("accepts the example graph", () => {
    const r = validateGraph(parseGraph(exampleText("app.navgraph")));
    expect(r.errors).toEqual([]);
  });

  it("reports structural problems", () => {
    expect(codes(g(`SCREEN a "dup"`))).toContain("DUPLICATE_SCREEN");
    expect(codes(g(`a -> zzz`))).toContain("UNKNOWN_SCREEN");
    expect(codes(g(`a -> b [id=x]\nb -> a [id=x]`))).toContain("DUPLICATE_EDGE");
    expect(codes(g(`a -> b [cost=-1]`))).toContain("INVALID_COST");
    expect(codes(g(`a -> b [cost=Infinity]`))).toContain("INVALID_COST");
    expect(codes(g(`a -> b [if="(a"]`))).toContain("INVALID_CONDITION");
    expect(codes(g(`a -> b [if=x wat y]`))).toContain("UNKNOWN_OPERATOR");
    expect(codes(g(`a -> b [if=ghost]`), { strictConditions: true })).toContain("UNKNOWN_CONDITION_VARIABLE");
    expect(codes(`NAVGRAPH/2\nVAR X : string\nVAR X : string`)).toContain("DUPLICATE_VARIABLE");
    expect(codes(`NAVGRAPH/2\nVAR X : number = "s"`)).toContain("VARIABLE_TYPE_MISMATCH");
  });

  it("validates actions against the schema", () => {
    expect(codes(g(`a -> b { DO NOPE {} }`))).toContain("UNKNOWN_ACTION");
    expect(codes(g(`a -> b { DO TAP {} }`))).toContain("INVALID_ACTION_PAYLOAD");
    expect(codes(g(`a -> b { DO TAP { "target": 5 } }`))).toContain("INVALID_ACTION_PAYLOAD");
    expect(codes(g(`a -> b { DO TAP { "target": "$X$" } }`))).toContain("UNDEFINED_VARIABLE");
    expect(codes(g(`a -> b { DO TAP { "target": "$X$" } }`), { allowUndeclaredVariables: true })).not.toContain("UNDEFINED_VARIABLE");
  });

  it("checks variable references against declared types", () => {
    const text = `NAVGRAPH/2\nVAR N : number = 1\nSCREEN a "A"\nSCREEN b "B"\na -> b { DO TAP { "target": "$N$" } }`;
    expect(codes(text)).toContain("INVALID_ACTION_PAYLOAD");
    const ok = `NAVGRAPH/2\nVAR N : number = 1\nSCREEN a "A"\nSCREEN b "B"\na -> b { DO TAP { "target": "t", "timeoutMs": "$N$" } }`;
    expect(codes(ok)).toEqual([]);
  });

  it("validates declared edge metadata", () => {
    const schema = { schemaVersion: 1 as const, extends: "default", edgeMetadata: { label: { type: "string" as const } } };
    const r = validateGraph(parseGraph(g(`a -> b [label=5]`)), schema);
    expect(r.errors.map((e) => e.code)).toContain("INVALID_EDGE_METADATA");
  });
});

describe("indexing", () => {
  it("throws a ValidationError with all diagnostics by default", () => {
    try {
      indexTreeFromText(g(`a -> x\na -> y`));
      throw new Error("expected failure");
    } catch (e) {
      expect(e).toBeInstanceOf(ValidationError);
      expect((e as ValidationError).diagnostics).toHaveLength(2);
    }
  });

  it("can collect diagnostics and keep the valid parts", () => {
    const t = indexTreeFromText(g(`a -> x\na -> b`), { diagnostics: "collect" });
    expect(t.edges).toHaveLength(1);
    expect(t.diagnostics.filter((d) => d.severity === "error")).toHaveLength(1);
  });

  it("indexes screens, adjacency and ids", () => {
    const t = indexTreeFromText(g(`a -> b\na -> b [cost=2]\nb -> a`));
    expect(t).toBeInstanceOf(NavigationTree);
    expect(t.outgoing("a").map((e) => e.id)).toEqual(["a->b", "a->b#2"]);
    expect(t.incoming("a")).toHaveLength(1);
    expect(t.outgoing("a")[0]?.cost).toBe(1);
    expect(indexTreeFromText(g(`a -> b`), { defaultCost: 4 }).edges[0]?.cost).toBe(4);
  });

  it("never invents reverse edges", () => {
    const t = indexTreeFromText(g(`a -> b`));
    expect(t.outgoing("b")).toHaveLength(0);
  });

  it("exposes tree.<id> only where safe, and screens.get always", () => {
    const text = `NAVGRAPH/2\nSCREEN home "Home"\nSCREEN screens "S"\nSCREEN a.b "AB"\nSCREEN toString "T"`;
    const t = indexTreeFromText<"home">(text);
    expect(t.home.name).toBe("Home");
    expect(t.screens.get("screens")?.name).toBe("S");
    expect(typeof t.screens.get).toBe("function");
    expect(Object.prototype.hasOwnProperty.call(t, "a.b")).toBe(false);
    expect(t.screens.get("a.b")?.name).toBe("AB");
    expect(typeof t.toString).toBe("function");
  });

  it("freezes graph data", () => {
    const t = indexTreeFromText(exampleText("app.navgraph"));
    expect(Object.isFrozen(t.edges[0])).toBe(true);
    expect(Object.isFrozen(t.edges[0]?.actions[0]?.data)).toBe(true);
  });

  it("serialises to JSON", () => {
    const t = indexTreeFromText(exampleText("app.navgraph"));
    expect(() => JSON.stringify(t)).not.toThrow();
    expect(t.toJSON().app).toBe("Example Store");
  });

  it("loads files, with and without a custom reader", async () => {
    const t = await indexTree<"home" | "cart">(examplePath("app.navgraph"), { schema: examplePath("app.navschema") });
    expect(t.home.id).toBe("home");
    const text = exampleText("app.navgraph");
    const t2 = await indexTree("virtual.navgraph", { readFile: async () => text });
    expect(t2.file).toBe("virtual.navgraph");
    await expect(indexTree("nope.navgraph")).rejects.toThrow(/Cannot read/);
  });

  it("explains how to supply a reader when there is no filesystem", async () => {
    // Simulate React Native: a global `process` with no Node version information.
    vi.stubGlobal("process", { env: {} });
    try {
      await expect(indexTree("x.navgraph")).rejects.toThrow(/readFile/);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("still reads files when process.getBuiltinModule is missing (Node 18, early Node 20)", async () => {
    const proc = (globalThis as { process: { getBuiltinModule?: unknown } }).process;
    const saved = proc.getBuiltinModule;
    proc.getBuiltinModule = undefined;
    try {
      const t = await indexTree(examplePath("app.navgraph"));
      expect(t.screens.size).toBeGreaterThan(0);
    } finally {
      proc.getBuiltinModule = saved;
    }
  });

  it("types shortcuts through NavTree", () => {
    const t: NavTree<"home"> = indexTreeFromText<"home">(`NAVGRAPH/2\nSCREEN home "Home"`);
    expect(t.home.name).toBe("Home");
  });
});