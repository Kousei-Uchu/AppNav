import { AppNavError } from "./errors";
import type { NavigationTree } from "./graph";

/**
 * The shared tree used by registration functions when no tree is passed.
 * Apps that want one live graph set it once at startup and register screens
 * and actions from anywhere without threading a tree through their code.
 */
let current: NavigationTree | undefined;

/** Set (or clear, with `undefined`) the shared tree. Returns the previous one. */
export function setDefaultTree(tree: NavigationTree | undefined): NavigationTree | undefined {
  const previous = current;
  current = tree;
  return previous;
}

export function getDefaultTree(): NavigationTree | undefined {
  return current;
}

/** The shared tree, or an error that says how to set one. */
export function requireDefaultTree(): NavigationTree {
  if (!current) {
    throw new AppNavError(
      "NO_DEFAULT_TREE",
      "No tree was passed and no default tree is set. Pass a tree as the first argument, or call setDefaultTree(tree) once at startup",
    );
  }
  return current;
}
