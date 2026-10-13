import { VariableError } from "./errors";
import { isPlainObject, setOwn } from "./json";
import type { JsonObject, JsonValue, VariableDeclaration, VariableType } from "./types";

export type VariableScope = Readonly<Record<string, JsonValue>>;

export interface ScopeInputs {
  /** Route inputs. Override graph defaults. */
  variables?: Readonly<Record<string, JsonValue>>;
  /** Runtime values discovered during execution. Override route inputs. */
  runtime?: Readonly<Record<string, JsonValue>>;
  /** When true, values for undeclared variables are rejected. */
  strict?: boolean;
}

type Segment = { kind: "text"; value: string } | { kind: "var"; name: string };

const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Tokenise a template string. `$NAME$` is a reference, `$$` is a literal `$`.
 * A lone `$` that does not form a reference is kept as text.
 */
export function parseTemplate(input: string): Segment[] {
  const out: Segment[] = [];
  let text = "";
  const flush = () => {
    if (text) out.push({ kind: "text", value: text });
    text = "";
  };
  let i = 0;
  while (i < input.length) {
    const c = input[i] as string;
    if (c !== "$") {
      text += c;
      i++;
      continue;
    }
    if (input[i + 1] === "$") {
      text += "$";
      i += 2;
      continue;
    }
    const end = input.indexOf("$", i + 1);
    const name = end === -1 ? "" : input.slice(i + 1, end);
    if (end !== -1 && NAME.test(name)) {
      flush();
      out.push({ kind: "var", name });
      i = end + 1;
    } else {
      text += c;
      i++;
    }
  }
  flush();
  return out;
}

/** Names of all variables referenced anywhere inside a JSON value (strings only, not keys). */
export function collectReferences(value: JsonValue, out: Set<string> = new Set()): Set<string> {
  if (typeof value === "string") {
    for (const s of parseTemplate(value)) if (s.kind === "var") out.add(s.name);
  } else if (Array.isArray(value)) {
    for (const v of value) collectReferences(v, out);
  } else if (value !== null && typeof value === "object") {
    for (const k of Object.keys(value)) collectReferences(value[k] as JsonValue, out);
  }
  return out;
}

export function typeOfValue(v: unknown): VariableType {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  if (typeof v === "string") return "string";
  if (typeof v === "number") return "number";
  if (typeof v === "boolean") return "boolean";
  if (isPlainObject(v)) return "object";
  return "any";
}

export function matchesType(v: unknown, type: VariableType): boolean {
  if (type === "any") return v !== undefined;
  if (type === "number") return typeof v === "number" && Number.isFinite(v);
  return typeOfValue(v) === type;
}

/**
 * Build the effective variable scope.
 * Precedence, lowest to highest: graph defaults, route inputs, runtime values.
 * Every supplied value for a declared variable is type checked.
 */
export function buildScope(
  declarations: Readonly<Record<string, VariableDeclaration>>,
  inputs: ScopeInputs = {},
): VariableScope {
  const scope: Record<string, JsonValue> = {};
  for (const name of Object.keys(declarations)) {
    const d = declarations[name] as VariableDeclaration;
    if (d.hasDefault) setOwn(scope, name, d.default as JsonValue);
  }
  for (const [label, layer] of [
    ["route variable", inputs.variables],
    ["runtime variable", inputs.runtime],
  ] as const) {
    if (!layer) continue;
    for (const name of Object.keys(layer)) {
      const value = layer[name] as JsonValue;
      const decl = declarations[name];
      if (!decl) {
        if (inputs.strict) {
          throw new VariableError(`Unknown ${label} "${name}"`, { ids: [name] }, "UNKNOWN_VARIABLE");
        }
      } else if (!matchesType(value, decl.type)) {
        throw new VariableError(
          `${label} "${name}" must be ${decl.type}, got ${typeOfValue(value)}`,
          { ids: [name] },
          "VARIABLE_TYPE_MISMATCH",
        );
      }
      setOwn(scope, name, value);
    }
  }
  return scope;
}

function stringify(v: JsonValue): string {
  return typeof v === "string" ? v : typeof v === "object" && v !== null ? JSON.stringify(v) : String(v);
}

/** Resolve `$VAR$` references inside a JSON value. Returns a new value; the input is untouched. */
export function resolveValue(
  value: JsonValue,
  scope: VariableScope,
  declarations: Readonly<Record<string, VariableDeclaration>> = {},
  where: { ids?: string[] } = {},
): JsonValue {
  const lookup = (name: string): JsonValue => {
    if (Object.prototype.hasOwnProperty.call(scope, name)) return scope[name] as JsonValue;
    const declared = declarations[name];
    throw new VariableError(
      declared
        ? `Variable "${name}" is required but no value was provided`
        : `Undefined variable "${name}"`,
      { ids: [...(where.ids ?? []), name] },
      declared ? "MISSING_VARIABLE" : "UNDEFINED_VARIABLE",
    );
  };
  const walk = (v: JsonValue): JsonValue => {
    if (typeof v === "string") {
      const segs = parseTemplate(v);
      if (segs.length === 1 && segs[0]?.kind === "var") return clone(lookup(segs[0].name));
      if (segs.length === 0) return "";
      return segs.map((s) => (s.kind === "text" ? s.value : stringify(lookup(s.name)))).join("");
    }
    if (Array.isArray(v)) return v.map(walk);
    if (v !== null && typeof v === "object") {
      const out: JsonObject = {};
      for (const k of Object.keys(v)) setOwn(out, k, walk(v[k] as JsonValue));
      return out;
    }
    return v;
  };
  const clone = (v: JsonValue): JsonValue => (v !== null && typeof v === "object" ? JSON.parse(JSON.stringify(v)) : v);
  return walk(value);
}
