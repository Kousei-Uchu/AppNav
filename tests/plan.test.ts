import { describe, expect, it } from "vitest";
import {
  NoPathError,
  UnknownScreenError,
  VariableError,
  buildInstructions,
  buildInstructionsSync,
  indexTreeFromText,
  planRoute,
  planRouteAsync,
  registerActions,
} from "../src";

const GRAPH = `NAVGRAPH/2
VAR EXTRA_QUANTITY : number = 1
SCREEN home "Home"
SCREEN cart "Cart"
SCREEN tutorial_end "Checkout step"
SCREEN island "Island"
home -> cart { DO TAP { "target": "Cart" } }
cart -> home { DO BACK {} }
cart -> tutorial_end { DO TAP { "target": "Checkout" } }
END`;

function tree() {
  const t = indexTreeFromText(GRAPH);
  registerActions(t, "cart", {
    decrease_quantity: { name: "Reduce quantity", actions: [{ type: "TAP", data: { target: "Reduce Quantity" }, repeat: "$EXTRA_QUANTITY$" }] },
    clear_cart: [{ type: "TAP", data: { target: "Clear" } }],
  });
  return t;
}

const ok = (r: ReturnType<typeof planRoute>) => {
  if (!r.ok) throw new Error(`plan failed at leg ${r.leg}: ${r.error.message}`);
  return r;
};

describe("planRoute", () => {
  it("stitches legs into one path and one instructions object", () => {
    const r = ok(planRoute(tree(), "home", [{ action: "decrease_quantity", repeat: 4 }, { screen: "tutorial_end" }]));
    expect(r.path.screens).toEqual(["home", "cart", "decrease_quantity", "cart", "tutorial_end"]);
    expect(r.path.from).toBe("home");
    expect(r.path.to).toBe("tutorial_end");
    expect(r.instructions.steps.map((s) => [s.n, s.leg, s.from, s.to, s.kind])).toEqual([
      [1, 0, "home", "cart", "navigate"],
      [2, 0, "cart", "decrease_quantity", "action"],
      [3, 1, "decrease_quantity", "cart", "navigate"],
      [4, 1, "cart", "tutorial_end", "navigate"],
    ]);
    expect(r.instructions.steps[1]!.actions).toMatchObject([{ type: "TAP", data: { target: "Reduce Quantity" }, repeat: 4 }]);
    expect(r.instructions.steps[2]!.actions).toEqual([]);
    expect(r.instructions.legs).toEqual([
      { leg: 0, from: "home", to: "decrease_quantity", steps: 2 },
      { leg: 1, from: "decrease_quantity", to: "tutorial_end", steps: 2 },
    ]);
    expect(r.path.cost).toBe(r.instructions.cost);
    expect(r.instructions.to).toBe("tutorial_end");
  });

  it("plans from any screen the app names", () => {
    const r = ok(planRoute(tree(), "cart", [{ action: "clear_cart" }, { screen: "home" }]));
    expect(r.path.screens).toEqual(["cart", "clear_cart", "cart", "home"]);
  });

  it("buildInstructions accepts the combined path with no special casing", async () => {
    const r = ok(planRoute(tree(), "home", [{ action: "clear_cart" }, { screen: "tutorial_end" }]));
    expect(buildInstructionsSync(r.path)).toEqual(r.instructions);
    expect(await buildInstructions(r.path)).toEqual(r.instructions);
  });

  it("planRouteAsync gives the same result", async () => {
    const t = tree();
    const waypoints = [{ action: "decrease_quantity", repeat: 2 }, { screen: "home" }];
    const a = await planRouteAsync(t, "cart", waypoints);
    const s = planRoute(t, "cart", waypoints);
    expect(a).toEqual(s);
  });

  it("does not touch the tree's own edges when it overrides a repeat", () => {
    const t = tree();
    ok(planRoute(t, "cart", [{ action: "decrease_quantity", repeat: 9 }], { variables: { EXTRA_QUANTITY: 2 } }));
    const again = ok(planRoute(t, "cart", [{ action: "decrease_quantity" }], { variables: { EXTRA_QUANTITY: 2 } }));
    expect(again.instructions.steps[0]!.actions[0]!.repeat).toBe(2);
  });
});

describe("repeat on a waypoint", () => {
  it("accepts a variable the app computes", () => {
    const r = ok(planRoute(tree(), "cart", [{ action: "clear_cart", repeat: "$EXTRA_QUANTITY$" }], { variables: { EXTRA_QUANTITY: 3 } }));
    expect(r.instructions.steps[0]!.actions[0]!.repeat).toBe(3);
  });

  it("rejects bad repeats up front and fails clearly when the variable has no usable value", () => {
    const code = (repeat: unknown) => {
      try {
        planRoute(tree(), "cart", [{ action: "clear_cart", repeat: repeat as never }]);
      } catch (e) {
        return (e as { code?: string }).code;
      }
    };
    for (const bad of [0, -1, 1.5, "four", "x$A$", "$A$$B$"]) expect(code(bad), String(bad)).toBe("INVALID_REPEAT");
    expect(() => planRoute(tree(), "cart", [{ action: "clear_cart", repeat: "$NOPE$" }])).toThrow(VariableError);
    expect(() => planRoute(tree(), "cart", [{ action: "clear_cart", repeat: "$EXTRA_QUANTITY$" }], { variables: { EXTRA_QUANTITY: 0 } })).toThrow(VariableError);
  });

  it("reports a repeat that has nothing to repeat, instead of ignoring it", () => {
    const t = tree();
    const r = planRoute(t, "decrease_quantity", [{ action: "decrease_quantity", repeat: 2 }]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r).toMatchObject({ leg: 0, error: { code: "INVALID_WAYPOINT" } });
  });
});

describe("failures", () => {
  it("returns the failing leg and keeps going no further", () => {
    const r = planRoute(tree(), "home", [{ screen: "cart" }, { screen: "island" }, { screen: "home" }]);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.leg).toBe(1);
      expect(r.error).toBeInstanceOf(NoPathError);
    }
  });

  it("returns an unknown screen as a failed leg, since the app's idea of where the user is can be stale", () => {
    const a = planRoute(tree(), "ghost", [{ screen: "cart" }]);
    expect(a.ok === false && a.leg === 0 && a.error instanceof UnknownScreenError).toBe(true);
    const b = planRoute(tree(), "home", [{ screen: "cart" }, { screen: "ghost" }]);
    expect(b.ok === false && b.leg === 1 && b.error instanceof UnknownScreenError).toBe(true);
  });

  it("throws INVALID_WAYPOINT for waypoints that are the wrong shape", () => {
    const code = (w: unknown) => {
      try {
        planRoute(tree(), "home", w as never);
      } catch (e) {
        return (e as { code?: string }).code;
      }
    };
    expect(code([])).toBe("INVALID_WAYPOINT");
    expect(code("cart")).toBe("INVALID_WAYPOINT");
    expect(code([{}])).toBe("INVALID_WAYPOINT");
    expect(code([{ screen: "cart", action: "clear_cart" }])).toBe("INVALID_WAYPOINT");
    expect(code([{ screen: "cart", repeat: 2 }])).toBe("INVALID_WAYPOINT");
    expect(code([{ action: "cart" }])).toBe("INVALID_WAYPOINT");
    expect(code([{ screen: "cart", extra: 1 }])).toBe("INVALID_WAYPOINT");
  });
});

describe("zero length legs", () => {
  it("a waypoint on the screen the user is already on adds no steps", () => {
    const r = ok(planRoute(tree(), "cart", [{ screen: "cart" }, { screen: "home" }]));
    expect(r.instructions.steps.map((s) => s.leg)).toEqual([1]);
    expect(r.instructions.legs?.map((l) => l.steps)).toEqual([0, 1]);
    expect(r.path.screens).toEqual(["cart", "home"]);
  });
});
