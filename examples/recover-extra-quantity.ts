import { ASTAR, buildInstructionsSync, calculatePath, indexTreeFromText, registerActions, type Instructions, type NavigationTree } from "../src";

/**
 * Worked example: a tutorial expects one item in the cart, but the user added
 * extra. The APP notices that and decides to recover. routegraph does not track
 * where the user is or detect that they are off track. It only plans from the
 * screen you give it to the goal you give it.
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
  // The actions run on the way into the node, and `repeat` is filled in at planning time.
  registerActions(tree, "cart", {
    decrease_quantity: {
      name: "Reduce quantity",
      actions: [{ type: "TAP", data: { target: "Reduce Quantity" }, repeat: "$EXTRA_QUANTITY$" }],
    },
  });
  return tree;
}

/**
 * The app's own re-plan. `current` is the screen the app believes the user is
 * on, `extra` is how many items too many are in the cart. Returns one
 * Instructions per leg, in the order to show them.
 */
export function recoverExtraQuantity(tree: NavigationTree, current: string, extra: number): Instructions[] {
  // Leg 1: get to the action node. The last step carries the TAP with repeat: extra.
  const doIt = calculatePath(tree, current, "decrease_quantity", ASTAR, { variables: { EXTRA_QUANTITY: extra } });
  // Leg 2: from the action node back to where the tutorial was. The first step is an empty move back to the parent.
  const goBack = calculatePath(tree, "decrease_quantity", "tutorial_end", ASTAR);
  return [buildInstructionsSync(doIt), buildInstructionsSync(goBack)];
}
