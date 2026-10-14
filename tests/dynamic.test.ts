import { afterEach, describe, expect, it } from "vitest";
import {
  NavigationTree,
  ValidationError,
  buildInstructionsSync,
  calculatePath,
  clearDynamic,
  cloneTree,
  createTree,
  getDefaultTree,
  indexTreeFromText,
  registerEdges,
  registerScreens,
  setDefaultTree,
  unregisterEdges,
  unregisterScreens,
} from "../src";

const BASE = `NAVGRAPH/2
SCREEN home "Home"
SCREEN cart "Cart"
SCREEN item_settings "Item Settings"
SCREEN done "Done"
home -> cart { DO TAP { "target": "Cart" } }
cart -> home { DO BACK {} }
cart -> item_settings { DO TAP { "target": "Item settings" } }
item_settings -> cart { DO BACK {} }
cart -> done { DO TAP { "target": "Done" } }
END`;

afterEach(() => setDefaultTree(undefined));

describe("shared mutable tree", () => {
  it("registers in place and returns the same tree", () => {
    const tree = indexTreeFromText(BASE);
    const result = registerScreens(tree, ["p1", "p2"], "item_settings");
    expect(result).toBe(tree);
    expect([...tree.screens.keys()]).toContain("item_settings:p1");
    expect(tree.screen("item_settings:p1").dynamic).toBe(true);
    expect(tree.screen("item_settings:p1").template).toBe("item_settings");
    expect(tree.screen("home").dynamic).toBeUndefined();
  });

  it("copies edges touching the template and flags them dynamic", () => {
    const tree = indexTreeFromText(BASE);
    registerScreens(tree, ["p1"], "item_settings");
    const incoming = tree.incoming("item_settings:p1").map((e) => e.id);
    const outgoing = tree.outgoing("item_settings:p1").map((e) => e.id);
    expect(incoming).toEqual(["cart->item_settings:p1"]);
    expect(outgoing).toEqual(["item_settings:p1->cart"]);
    expect(tree.edge("cart->item_settings:p1")?.dynamic).toBe(true);
  });

  it("pathfinding sees new screens immediately, with no re-indexing", () => {
    const tree = indexTreeFromText(BASE);
    registerScreens(tree, ["p1"], "item_settings");
    const path = calculatePath(tree, "home", "item_settings:p1");
    expect(path.screens).toEqual(["home", "cart", "item_settings:p1"]);
    expect(buildInstructionsSync(path).steps).toHaveLength(2);
  });

  it("keeps several holders of one tree in sync", () => {
    const tree = indexTreeFromText(BASE);
    const other = tree;
    registerScreens(tree, ["a"], "item_settings");
    registerScreens(other, ["b"], "item_settings");
    expect(tree.screens.size).toBe(other.screens.size);
    expect(tree.hasScreen("item_settings:a") && tree.hasScreen("item_settings:b")).toBe(true);
  });

  it("is atomic: a failed call leaves the tree unchanged", () => {
    const tree = indexTreeFromText(BASE);
    const screens = tree.screens.size;
    const edges = tree.edges.length;
    expect(() => registerScreens(tree, ["ok", "x"], "nope")).toThrow();
    expect(() => registerEdges(tree, [{ from: "home", to: "cart" }, { from: "home", to: "ghost" }])).toThrow();
    expect(tree.screens.size).toBe(screens);
    expect(tree.edges.length).toBe(edges);
  });

  it("generates deterministic edge ids", () => {
    const tree = indexTreeFromText(BASE);
    registerEdges(tree, [{ from: "home", to: "cart" }, { from: "home", to: "cart" }]);
    expect(tree.edges.slice(-2).map((e) => e.id)).toEqual(["home->cart#2", "home->cart#3"]);
  });

  it("defines tree.<id> shortcuts for safe ids and removes them again", () => {
    const tree = indexTreeFromText(BASE) as NavigationTree & Record<string, unknown>;
    registerScreens(tree, [{ id: "extra", name: "Extra" }]);
    expect((tree.extra as { name: string }).name).toBe("Extra");
    unregisterScreens(tree, "extra");
    expect("extra" in tree).toBe(false);
  });
});

describe("default tree", () => {
  it("is used when no tree is passed", () => {
    const tree = indexTreeFromText(BASE, { setAsDefault: true });
    expect(getDefaultTree()).toBe(tree);
    registerScreens(["p1"], "item_settings");
    expect(tree.hasScreen("item_settings:p1")).toBe(true);
  });

  it("works through the snake_case style and instance methods", () => {
    const tree = indexTreeFromText(BASE);
    setDefaultTree(tree);
    registerScreens({ screens: { a: { name: "A" } } });
    tree.registerScreens(["p1"], "item_settings");
    expect(tree.hasScreen("a")).toBe(true);
    expect(tree.hasScreen("item_settings:p1")).toBe(true);
  });

  it("explains how to fix a missing default", () => {
    expect(() => registerScreens(["p1"], "item_settings")).toThrow(/setDefaultTree/);
  });

  it("createTree makes an empty registrable tree", () => {
    const tree = createTree({ app: "Empty", setAsDefault: true });
    registerScreens([{ id: "a" }, { id: "b" }]);
    registerEdges([{ from: "a", to: "b" }]);
    expect(calculatePath(tree, "a", "b").screens).toEqual(["a", "b"]);
  });
});

describe("removal", () => {
  it("removes dynamic screens and their edges, and leaves the file graph alone", () => {
    const tree = indexTreeFromText(BASE);
    const fileEdges = tree.edges.length;
    registerScreens(tree, ["p1", "p2"], "item_settings");
    unregisterScreens(tree, "item_settings:p1");
    expect(tree.hasScreen("item_settings:p1")).toBe(false);
    expect(tree.edges.some((e) => e.from.endsWith(":p1") || e.to.endsWith(":p1"))).toBe(false);
    expect(tree.hasScreen("item_settings:p2")).toBe(true);
    expect(tree.edges.length).toBe(fileEdges + 2);
  });

  it("removes every instance of a template", () => {
    const tree = indexTreeFromText(BASE);
    registerScreens(tree, ["p1", "p2", "p3"], "item_settings");
    unregisterScreens(tree, { template: "item_settings" });
    expect([...tree.screens.keys()]).toEqual(["home", "cart", "item_settings", "done"]);
  });

  it("refuses to remove file screens or file edges, and ignores unknown ids", () => {
    const tree = indexTreeFromText(BASE);
    expect(() => unregisterScreens(tree, "home")).toThrow(/cannot be unregistered/);
    expect(() => unregisterEdges(tree, "home->cart")).toThrow(/cannot be unregistered/);
    expect(() => unregisterScreens(tree, "never-existed")).not.toThrow();
    expect(tree.hasScreen("home")).toBe(true);
  });

  it("clearDynamic restores the file graph, so a refresh can re-register cleanly", () => {
    const tree = indexTreeFromText(BASE);
    registerScreens(tree, ["p1"], "item_settings");
    registerEdges(tree, [{ from: "home", to: "done" }]);
    clearDynamic(tree);
    expect(tree.screens.size).toBe(4);
    expect(tree.edges.length).toBe(5);
    registerScreens(tree, ["p1"], "item_settings");
    expect(tree.hasScreen("item_settings:p1")).toBe(true);
  });

  it("a path made before removal fails clearly when built afterwards", () => {
    const tree = indexTreeFromText(BASE);
    registerScreens(tree, ["p1"], "item_settings");
    const path = calculatePath(tree, "home", "item_settings:p1");
    unregisterScreens(tree, "item_settings:p1");
    expect(() => buildInstructionsSync(path)).toThrow();
  });
});

describe("cloneTree", () => {
  it("makes an independent copy", () => {
    const tree = indexTreeFromText(BASE);
    registerScreens(tree, ["p1"], "item_settings");
    const copy = cloneTree(tree);
    registerScreens(copy, ["p2"], "item_settings");
    unregisterScreens(copy, "item_settings:p1");
    expect(tree.hasScreen("item_settings:p1")).toBe(true);
    expect(tree.hasScreen("item_settings:p2")).toBe(false);
    expect(copy.hasScreen("item_settings:p2")).toBe(true);
    expect(copy.screen("home")).not.toBe(tree.screen("home"));
  });

  it("clones the default tree when given nothing", () => {
    const tree = indexTreeFromText(BASE, { setAsDefault: true });
    const copy = cloneTree();
    registerScreens(copy, ["only-here"]);
    expect(tree.hasScreen("only-here")).toBe(false);
  });
});

const VARS = `NAVGRAPH/2
VAR ITEM : string = "x"
SCREEN a "A"
SCREEN b "B"
a -> b { DO TAP { "target": "Go" } }
END`;

const failure = (fn: () => unknown): ValidationError => {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(ValidationError);
    return e as ValidationError;
  }
  throw new Error("expected the call to throw");
};
const codesOf = (e: ValidationError) => e.diagnostics.map((d) => d.code);

describe("validation of registered items", () => {
  it("rejects unknown action types and leaves the tree unchanged", () => {
    const tree = indexTreeFromText(VARS);
    const edges = tree.edges.length;
    const err = failure(() => registerEdges(tree, [{ from: "a", to: "b", actions: [{ type: "TOTALLY_FAKE", data: {} }] }]));
    expect(codesOf(err)).toContain("UNKNOWN_ACTION");
    expect(tree.edges.length).toBe(edges);
  });

  it("checks action payloads against the schema", () => {
    const tree = indexTreeFromText(VARS);
    expect(codesOf(failure(() => registerEdges(tree, [{ from: "a", to: "b", actions: [{ type: "TAP", data: {} }] }])))).toContain(
      "INVALID_ACTION_PAYLOAD",
    );
    expect(
      codesOf(failure(() => registerEdges(tree, [{ from: "a", to: "b", actions: [{ type: "TAP", data: { target: 5 } }] }]))),
    ).toContain("INVALID_ACTION_PAYLOAD");
    registerEdges(tree, [{ from: "a", to: "b", actions: [{ type: "TAP", data: { target: "ok" } }] }]);
  });

  it("requires variable references to be declared", () => {
    const tree = indexTreeFromText(VARS);
    const bad = { from: "a", to: "b", actions: [{ type: "TAP", data: { target: "$GHOST$" } }] };
    expect(codesOf(failure(() => registerEdges(tree, [bad])))).toContain("UNDEFINED_VARIABLE");
    registerEdges(tree, [{ from: "a", to: "b", actions: [{ type: "TAP", data: { target: "$ITEM$" } }] }]);
    registerEdges(tree, [bad], { allowUndeclaredVariables: true });
  });

  it("reports unknown endpoints as diagnostics", () => {
    const tree = indexTreeFromText(VARS);
    const err = failure(() => registerEdges(tree, [{ from: "a", to: "ghost" }]));
    expect(codesOf(err)).toEqual(["UNKNOWN_SCREEN"]);
    expect(err.diagnostics[0]?.ids).toContain("ghost");
  });

  it("checks costs, conditions and duplicate explicit ids", () => {
    const tree = indexTreeFromText(VARS);
    expect(codesOf(failure(() => registerEdges(tree, [{ from: "a", to: "b", cost: -1 }])))).toContain("INVALID_COST");
    expect(codesOf(failure(() => registerEdges(tree, [{ from: "a", to: "b", condition: "(x" }])))).toContain("INVALID_CONDITION");
    expect(codesOf(failure(() => registerEdges(tree, [{ from: "a", to: "b", condition: "x wat y" }])))).toContain("UNKNOWN_OPERATOR");
    registerEdges(tree, [{ from: "a", to: "b", id: "mine" }]);
    expect(codesOf(failure(() => registerEdges(tree, [{ from: "b", to: "a", id: "mine" }])))).toContain("DUPLICATE_EDGE");
  });

  it("validates screen metadata against the schema", () => {
    const tree = createTree({ schema: { schemaVersion: 1, extends: "default", screenMetadata: { icon: { type: "string" } } } });
    expect(codesOf(failure(() => registerScreens(tree, [{ id: "s", meta: { icon: 5 } }])))).toContain("INVALID_SCREEN_METADATA");
    registerScreens(tree, [{ id: "s", meta: { icon: "star" } }]);
  });

  it("accepts action types the tree's schema declares", () => {
    const tree = createTree({
      schema: { schemaVersion: 1, extends: "default", actions: { SCAN_QR: { required: ["camera"], properties: { camera: { type: "string" } } } } },
    });
    registerScreens(tree, [{ id: "a" }, { id: "b" }]);
    registerEdges(tree, [{ from: "a", to: "b", actions: [{ type: "SCAN_QR", data: { camera: "back" } }] }]);
    expect(tree.edge("a->b")?.actions[0]?.type).toBe("SCAN_QR");
  });

  it("validates registerActions payloads too", () => {
    const tree = indexTreeFromText(VARS);
    const err = failure(() => tree.registerActions("a", [{ type: "REMOVE_ITEM", data: {} }]));
    expect(codesOf(err)).toContain("UNKNOWN_ACTION");
    expect(tree.screens.size).toBe(2);
  });

  it("reports an unknown template as a diagnostic", () => {
    const tree = indexTreeFromText(VARS);
    const err = failure(() => registerScreens(tree, ["p1"], "nope"));
    expect(codesOf(err)).toEqual(["UNKNOWN_SCREEN"]);
  });

  it("collect mode registers the valid items and records the problems", () => {
    const tree = indexTreeFromText(VARS);
    registerEdges(
      tree,
      [
        { from: "a", to: "b", id: "good", actions: [{ type: "TAP", data: { target: "ok" } }] },
        { from: "a", to: "b", id: "bad", actions: [{ type: "NOPE", data: {} }] },
        { from: "a", to: "ghost", id: "worse" },
      ],
      { diagnostics: "collect" },
    );
    expect(tree.edge("good")).toBeDefined();
    expect(tree.edge("bad")).toBeUndefined();
    expect(tree.edge("worse")).toBeUndefined();
    expect(tree.diagnostics.map((d) => d.code).sort()).toEqual(["UNKNOWN_ACTION", "UNKNOWN_SCREEN"]);
  });
});
