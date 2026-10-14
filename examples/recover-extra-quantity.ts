import { indexTreeFromText, planRoute, registerActions, type Instructions, type NavigationTree } from "../src";

/**
 * Worked example: a tutorial expects one item in the cart, but the user added
 * extra. The APP notices that and decides to recover. routegraph does not track
 * where the user is or detect that they are off track. It only plans from the
 * screen you give it, through the stops you give it.
 */

export const GRAPH = `NAVGRAPH/2
VAR EXTRA_QUANTITY : number = 1
SCREEN cart "Cart"
SCREEN tutorial_end "Checkout step"
cart -> tutorial_end { DO TAP { "target": "Checkout" } }
END`;

export function createTutorialTree(): NavigationTree {
  const tree = indexTreeFromText(GRAPH);
  // Registered at runtime, for example when the cart screen mounts.
  // The actions run on the way into the node.
  registerActions(tree, "cart", {
    decrease_quantity: {
      name: "Reduce quantity",
      actions: [{ type: "TAP", data: { target: "Reduce Quantity" } }],
    },
  });
  return tree;
}

/**
 * The app's own re-plan. `current` is the screen the app believes the user is
 * on, `extra` is how many items too many are in the cart. Returns one
 * Instructions: press Reduce Quantity `extra` times, then go on to the tutorial
 * step. Each step says which leg it belongs to.
 */
export function recoverExtraQuantity(tree: NavigationTree, current: string, extra: number): Instructions {
  const plan = planRoute(tree, current, [{ action: "decrease_quantity", repeat: extra }, { screen: "tutorial_end" }]);
  if (!plan.ok) throw plan.error; // or show something else: plan.leg says which leg failed
  return plan.instructions;
}
