import { describe, expect, it } from "vitest";
import { createTutorialTree, recoverExtraQuantity } from "../examples/recover-extra-quantity";

describe("worked example: recover from extra quantity", () => {
  it("presses Reduce Quantity four times, then returns to the tutorial step", () => {
    const [doIt, goBack] = recoverExtraQuantity(createTutorialTree(), "cart", 4);
    const last = doIt!.steps.at(-1)!;
    expect(last.kind).toBe("action");
    expect(last.actionNode).toBe("decrease_quantity");
    expect(last.actions).toMatchObject([{ type: "TAP", data: { target: "Reduce Quantity" }, repeat: 4 }]);
    expect(goBack!.steps.map((s) => [s.from, s.to, s.kind])).toEqual([
      ["decrease_quantity", "cart", "navigate"],
      ["cart", "tutorial_end", "navigate"],
    ]);
    expect(goBack!.steps[0]!.actions).toEqual([]);
    expect(goBack!.steps.at(-1)!.actions[0]).toMatchObject({ type: "TAP", data: { target: "Checkout" } });
  });

  it("plans from whatever screen the app passes in, and the count follows the cart", () => {
    const tree = createTutorialTree();
    const [a] = recoverExtraQuantity(tree, "cart", 2);
    expect(a!.steps.at(-1)!.actions[0]!.repeat).toBe(2);
    expect(() => recoverExtraQuantity(tree, "cart", 0)).toThrow();
  });
});
