/** Core shared types for AppNav. Everything here is plain data and JSON friendly. */

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

export type VariableType = "string" | "number" | "boolean" | "null" | "object" | "array" | "any";

export const VARIABLE_TYPES: readonly VariableType[] = [
  "string",
  "number",
  "boolean",
  "null",
  "object",
  "array",
  "any",
];

export type DiagnosticSeverity = "error" | "warning";

export interface Diagnostic {
  severity: DiagnosticSeverity;
  code: string;
  message: string;
  file?: string;
  line?: number;
  column?: number;
  /** Screen, edge, variable or action identifiers involved. */
  ids?: string[];
}

/**
 * Payload shapes for the built in actions. This is a convenience for typed
 * narrowing (see `isAction`). Custom schemas can supply their own map through
 * the generic parameter of `isAction`.
 */
export interface DefaultActionMap {
  TAP: { target: string; waitFor?: string; timeoutMs?: number; match?: JsonObject; index?: number };
  LONG_PRESS: { target: string; durationMs?: number };
  TYPE: { target: string; text: string; clearFirst?: boolean };
  SWIPE: { direction: "up" | "down" | "left" | "right"; target?: string; distance?: number };
  SCROLL: { target?: string; to?: string; direction?: "up" | "down" | "left" | "right" };
  BACK: Record<string, never>;
  WAIT: { until?: string; durationMs?: number; timeoutMs?: number };
  SET_STATE: { key: string; value: JsonValue };
  ASSERT: { condition: string; message?: string };
}

/** Any object whose keys are action types and whose values are payload shapes. */
export type ActionMap = { [type: string]: object };

export interface Screen {
  readonly id: string;
  readonly name: string;
  readonly meta: JsonObject;
  /** Declaration order, used for deterministic tie breaking. */
  readonly index: number;
  /** True for screens added at runtime with `registerScreens` or `registerActions`. */
  readonly dynamic?: boolean;
  /** Id of the screen this one was cloned from, when registered from a template. */
  readonly template?: string;
}

export interface ActionDeclaration {
  readonly type: string;
  readonly data: JsonObject;
  readonly line?: number;
  readonly column?: number;
}

export interface Condition {
  readonly source: string;
  readonly ast: ConditionNode;
}

export type ConditionNode =
  | { type: "literal"; value: JsonValue }
  | { type: "ref"; path: string[] }
  | { type: "not"; arg: ConditionNode }
  | { type: "and"; left: ConditionNode; right: ConditionNode }
  | { type: "or"; left: ConditionNode; right: ConditionNode }
  | { type: "compare"; op: string; left: ConditionNode; right: ConditionNode };

export interface Edge {
  readonly id: string;
  readonly from: string;
  readonly to: string;
  readonly cost: number;
  readonly condition?: Condition;
  readonly actions: readonly ActionDeclaration[];
  readonly meta: JsonObject;
  /** Declaration order, used for deterministic tie breaking. */
  readonly index: number;
  /** True for edges added at runtime. */
  readonly dynamic?: boolean;
  readonly line?: number;
  readonly column?: number;
}

export interface VariableDeclaration {
  readonly name: string;
  readonly type: VariableType;
  readonly hasDefault: boolean;
  readonly default?: JsonValue;
  readonly line?: number;
  readonly column?: number;
}

/** Parsed but unvalidated edge as written in the source. */
export interface RawEdge {
  id?: string;
  from: string;
  to: string;
  cost?: number;
  condition?: string;
  actions: ActionDeclaration[];
  meta: JsonObject;
  line: number;
  column: number;
}

export interface RawScreen {
  id: string;
  name: string;
  meta: JsonObject;
  line: number;
  column: number;
}

/** Intermediate representation produced by `parseGraph`. */
export interface Graph {
  version: number;
  app?: string;
  file?: string;
  variables: VariableDeclaration[];
  screens: RawScreen[];
  edges: RawEdge[];
  hasEnd: boolean;
}

export type ReadFile = (path: string) => Promise<string>;
