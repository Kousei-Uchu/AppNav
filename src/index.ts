export * from "./types";
export * from "./errors";
export { parseGraph, SUPPORTED_GRAPH_VERSIONS, type ParseOptions } from "./parser";
export {
  parseCondition,
  evaluateCondition,
  conditionRefs,
  BUILTIN_OPERATORS,
  type ConditionContext,
  type ConditionOperator,
  type ConditionOptions,
} from "./conditions";
export {
  buildScope,
  resolveValue,
  collectReferences,
  parseTemplate,
  matchesType,
  typeOfValue,
  type VariableScope,
  type ScopeInputs,
} from "./variables";
export {
  DEFAULT_SCHEMA_DEFINITION,
  getDefaultSchema,
  loadSchema,
  resolveSchema,
  registerSchema,
  unregisterSchema,
  validateAgainst,
  type ActionDefinition,
  type LoadSchemaOptions,
  type PropertySchema,
  type PropertyType,
  type ResolvedSchema,
  type SchemaDefinition,
} from "./schema";
export { defaultReadFile } from "./files";
export {
  NavigationTree,
  assertValid,
  indexGraph,
  indexTree,
  indexTreeFromText,
  validateEdgeRecord,
  validateGraph,
  validateScreenRecord,
  type IndexFileOptions,
  type IndexOptions,
  type NavTree,
  type RecordValidationEnv,
  type ValidateOptions,
  type ValidationResult,
} from "./graph";
export {
  ASTAR,
  BFS,
  DIJKSTRA,
  calculatePath,
  findReachable,
  registerAlgorithm,
  tryCalculatePath,
  type AlgorithmRef,
  type BuiltinAlgorithm,
  type Heuristic,
  type Path,
  type PathOptions,
  type PathResult,
  type PathfindingAlgorithm,
  type SearchContext,
  type SearchResult,
} from "./pathfinding";
export {
  buildInstructions,
  buildInstructionsSync,
  isAction,
  type BuildOptions,
  type InstructionAction,
  type InstructionStep,
  type StepKind,
  type Instructions,
} from "./instructions";
export {
  defineExtension,
  getExtensionOutput,
  normalizeExtensions,
  type ActionContext,
  type AnyExtension,
  type Extension,
  type ExtensionDefinition,
  type ExtensionsInput,
  type Hook,
  type InlineExtension,
  type NameOf,
  type OutputOf,
  type RouteContext,
  type StepContext,
} from "./extensions";
export {
  Runtime,
  createRuntime,
  defaultRuntime,
  registerActionHandler,
  type ActionHandler,
  type ActionResult,
  type ExecuteOptions,
  type ExecutionResult,
  type HandlerContext,
  type HandlerOptions,
} from "./runtime";
export { getDefaultTree, setDefaultTree } from "./default-tree";
export * from "./dynamic";

import * as AppNavNamespace from "./api-namespace";
/** Namespace object for `import { AppNav } from "routegraph"`. */
export const AppNav = AppNavNamespace;
export const VERSION = "0.1.0";
