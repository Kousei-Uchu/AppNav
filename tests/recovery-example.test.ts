import { describe, expect, it } from "vitest";
import { createTutorialTree, recoverExtraQuantity } from "../examples/recover-extra-quantity";

describe("worked example: recover from extra quantity", () => {
  it("presses Reduce Quantity four times, then returns to the tutorial step", () => {
    const out = recoverExtraQuantity(createTutorialTree(), "cart", 4);
    expect(out.steps.map((s) => [s.leg, s.from, s.to, s.kind])).toEqual([
      [0, "cart", "decrease_quantity", "action"],
      [1, "decrease_quantity", "cart", "navigate"],
      [1, "cart", "tutorial_end", "navigate"],
    ]);
    expect(out.steps[0]!.actions).toMatchObject([{ type: "TAP", data: { target: "Reduce Quantity" }, repeat: 4 }]);
    expect(out.steps[1]!.actions).toEqual([]);
    expect(out.steps[2]!.actions[0]).toMatchObject({ type: "TAP", data: { target: "Checkout" } });
  });

  it("plans from whatever screen the app passes in, and the count follows the cart", () => {
    const tree = createTutorialTree();
    expect(recoverExtraQuantity(tree, "cart", 2).steps[0]!.actions[0]!.repeat).toBe(2);
    expect(() => recoverExtraQuantity(tree, "cart", 0)).toThrow();
    expect(() => recoverExtraQuantity(tree, "nowhere", 1)).toThrow(/nowhere/);
  });
});
