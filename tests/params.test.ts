import { afterEach, describe, expect, it } from "vitest";
import { ValidationError, buildInstructionsSync, calculatePath, cloneTree, indexTreeFromText, registerScreens, setDefaultTree } from "../src";

const GRAPH = (itemDecl = "VAR ITEM_ID : string") => `NAVGRAPH/2
${itemDecl}
VAR LABEL : string = "plain"
SCREEN cart "Cart"
SCREEN item_settings "Item settings"
cart -> item_settings { DO TAP { "target": "Item card", "match": { "itemId": "$ITEM_ID$" }, "waitFor": "$LABEL$" } }
item_settings -> cart { DO BACK {} }
END`;

afterEach(() => setDefaultTree(undefined));

const tapData = (tree: ReturnType<typeof indexTreeFromText>, to: string, variables?: Record<string, never>) =>
  buildInstructionsSync(calculatePath(tree, "cart", to, "astar", { variables }), {}).steps[0]!.actions[0]!.data;

const codes = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    return e instanceof ValidationError ? e.diagnostics.map((d) => d.code) : [(e as { code?: string }).code];
  }
  return [];
};

describe("per item params", () => {
  it("gives each template copy its own instructions, with ITEM_ID defaulting from the id", () => {
    const tree = indexTreeFromText(GRAPH());
    registerScreens(tree, ["product_1", "product_2"], "item_settings");
    expect(tapData(tree, "item_settings:product_1").match).toEqual({ itemId: "product_1" });
    expect(tapData(tree, "item_settings:product_2").match).toEqual({ itemId: "product_2" });
    expect(tree.screen("item_settings:product_1").params).toEqual({ ITEM_ID: "product_1" });
  });

  it("keeps ids with colons whole after the template prefix", () => {
    const tree = indexTreeFromText(GRAPH());
    registerScreens(tree, ["sku:42"], "item_settings");
    expect(tapData(tree, "item_settings:sku:42").match).toEqual({ itemId: "sku:42" });
  });

  it("takes explicit params per id, and they beat the ITEM_ID default", () => {
    const tree = indexTreeFromText(GRAPH());
    registerScreens(tree, [{ id: "p1", params: { ITEM_ID: "SKU-9", LABEL: "special" } }, "p2"], "item_settings");
    expect(tapData(tree, "item_settings:p1")).toMatchObject({ match: { itemId: "SKU-9" }, waitFor: "special" });
    expect(tapData(tree, "item_settings:p2")).toMatchObject({ match: { itemId: "p2" }, waitFor: "plain" });
  });

  it("ranks graph defaults < screen params < route variables", () => {
    const tree = indexTreeFromText(GRAPH('VAR ITEM_ID : string = "from-graph"'));
    registerScreens(tree, ["p1"], "item_settings");
    expect(tapData(tree, "item_settings:p1").match).toEqual({ itemId: "p1" });
    const path = calculatePath(tree, "cart", "item_settings:p1", "astar", { variables: { ITEM_ID: "from-route" } });
    expect(buildInstructionsSync(path).steps[0]!.actions[0]!.data.match).toEqual({ itemId: "from-route" });
  });

  it("does not leak params onto edges that do not touch the screen", () => {
    const tree = indexTreeFromText(GRAPH());
    registerScreens(tree, ["p1", "p2"], "item_settings");
    const out = buildInstructionsSync(calculatePath(tree, "item_settings:p1", "item_settings:p2"));
    expect(out.steps.map((s) => s.to)).toEqual(["cart", "item_settings:p2"]);
    expect(out.steps[1]!.actions[0]!.data.match).toEqual({ itemId: "p2" });
  });

  it("rejects params that are not declared variables or have the wrong type, and changes nothing", () => {
    const tree = indexTreeFromText(GRAPH());
    expect(codes(() => registerScreens(tree, [{ id: "p1", params: { NOPE: "x" } }], "item_settings"))).toEqual(["UNKNOWN_PARAM"]);
    expect(codes(() => registerScreens(tree, [{ id: "p1", params: { ITEM_ID: 5 } }], "item_settings"))).toEqual(["PARAM_TYPE"]);
    expect(codes(() => registerScreens(tree, [{ id: "p1", params: "x" as never }], "item_settings"))).toEqual(["INVALID_REGISTRATION"]);
    expect(tree.hasScreen("item_settings:p1")).toBe(false);
  });

  it("reports an unfilled $ITEM_ID$ when the template never declared it", () => {
    const tree = indexTreeFromText(GRAPH("VAR OTHER : string = \"x\""), { diagnostics: "collect" });
    expect(tree.diagnostics.some((d) => d.severity === "error")).toBe(true);
    const clean = indexTreeFromText(`NAVGRAPH/2
SCREEN cart "Cart"
SCREEN item_settings "Item settings"
cart -> item_settings { DO TAP { "target": "Card" } }
item_settings -> cart
END`);
    registerScreens(clean, ["p1"], "item_settings"); // nothing to fill, nothing declared: fine
    expect(clean.screen("item_settings:p1").params).toBeUndefined();
  });

  it("a required variable with no param and no route value fails at build time", () => {
    const tree = indexTreeFromText(GRAPH('VAR ITEM_ID : string'));
    registerScreens(tree, ["p1"], "item_settings");
    expect(() => buildInstructionsSync(calculatePath(tree, "cart", "item_settings"))).toThrow(/ITEM_ID/);
  });

  it("survives cloneTree and is independent of the original", () => {
    const tree = indexTreeFromText(GRAPH());
    registerScreens(tree, ["p1"], "item_settings");
    const copy = cloneTree(tree);
    expect(tapData(copy, "item_settings:p1").match).toEqual({ itemId: "p1" });
    expect(copy.screen("item_settings:p1").params).not.toBe(tree.screen("item_settings:p1").params);
  });
});
