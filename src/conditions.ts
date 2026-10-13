import { ConditionError } from "./errors";
import { deepEqual } from "./json";
import type { Condition, ConditionNode, JsonValue } from "./types";

/**
 * Safe condition language. No eval, no JS.
 *
 *   expr    := or
 *   or      := and (("||" | "or") and)*
 *   and     := not (("&&" | "and") not)*
 *   not     := ("!" | "not") not | compare
 *   compare := primary [op primary]      op: == != < <= > >= or a word operator
 *   primary := string | number | true | false | null | path | "(" expr ")"
 *   path    := ident ("." ident)*
 *
 * Unknown values: a path that resolves to nothing is `undefined`. Undefined is
 * falsy, every comparison with undefined is false except "!=" which is true.
 * Set `strict` to throw instead.
 */

export type ConditionOperator = (left: JsonValue | undefined, right: JsonValue | undefined) => boolean;

export interface ConditionContext {
  variables?: Readonly<Record<string, JsonValue>>;
  state?: Readonly<Record<string, unknown>>;
}

export interface ConditionOptions {
  /** Extra word operators, e.g. { startsWith: (a, b) => ... }. */
  operators?: Readonly<Record<string, ConditionOperator>>;
  /** Throw on unknown paths instead of treating them as undefined. */
  strict?: boolean;
}

type Token =
  | { t: "str" | "num" | "word" | "op" | "punct"; v: string; at: number }
  | { t: "end"; v: ""; at: number };

const BUILTIN_WORDS = new Set(["and", "or", "not", "true", "false", "null"]);

export const BUILTIN_OPERATORS: Readonly<Record<string, ConditionOperator>> = {
  in: (l, r) => Array.isArray(r) && r.some((x) => deepEqual(x, l)),
  contains: (l, r) =>
    (typeof l === "string" && typeof r === "string" && l.includes(r)) ||
    (Array.isArray(l) && l.some((x) => deepEqual(x, r))),
};

function tokenize(src: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  const bad = (msg: string, at: number): never => {
    throw new ConditionError(`${msg} in condition "${src}" at position ${at}`, {}, "INVALID_CONDITION");
  };
  while (i < src.length) {
    const c = src[i] as string;
    if (/\s/.test(c)) {
      i++;
    } else if (c === '"' || c === "'") {
      const at = i++;
      let s = "";
      while (i < src.length && src[i] !== c) {
        if (src[i] === "\\" && i + 1 < src.length) i++;
        s += src[i++];
      }
      if (i >= src.length) bad("Unterminated string", at);
      i++;
      out.push({ t: "str", v: s, at });
    } else if (/[0-9]/.test(c) || (c === "-" && /[0-9]/.test(src[i + 1] ?? ""))) {
      const at = i++;
      while (i < src.length && /[0-9.eE]/.test(src[i] as string)) i++;
      if (Number.isNaN(Number(src.slice(at, i)))) bad("Invalid number", at);
      out.push({ t: "num", v: src.slice(at, i), at });
    } else if (/[A-Za-z_]/.test(c)) {
      const at = i;
      while (i < src.length && /[A-Za-z0-9_]/.test(src[i] as string)) i++;
      out.push({ t: "word", v: src.slice(at, i), at });
    } else {
      const two = src.slice(i, i + 2);
      if (["==", "!=", "<=", ">=", "&&", "||"].includes(two)) {
        out.push({ t: "op", v: two, at: i });
        i += 2;
      } else if (["<", ">", "!"].includes(c)) {
        out.push({ t: "op", v: c, at: i++ });
      } else if (["(", ")", "."].includes(c)) {
        out.push({ t: "punct", v: c, at: i++ });
      } else bad(`Unexpected character "${c}"`, i);
    }
  }
  out.push({ t: "end", v: "", at: src.length });
  return out;
}

/** Parse a condition expression into an AST. Throws ConditionError on bad syntax. */
export function parseCondition(source: string): Condition {
  const tokens = tokenize(source);
  let p = 0;
  const cur = () => tokens[p] as Token;
  const fail = (msg: string): never => {
    throw new ConditionError(`${msg} in condition "${source}" at position ${cur().at}`, {}, "INVALID_CONDITION");
  };
  const isWord = (w: string) => cur().t === "word" && cur().v === w;
  const isOp = (o: string) => cur().t === "op" && cur().v === o;

  const parseOr = (): ConditionNode => {
    let left = parseAnd();
    while (isOp("||") || isWord("or")) {
      p++;
      left = { type: "or", left, right: parseAnd() };
    }
    return left;
  };
  const parseAnd = (): ConditionNode => {
    let left = parseNot();
    while (isOp("&&") || isWord("and")) {
      p++;
      left = { type: "and", left, right: parseNot() };
    }
    return left;
  };
  const parseNot = (): ConditionNode => {
    if (isOp("!") || isWord("not")) {
      p++;
      return { type: "not", arg: parseNot() };
    }
    return parseCompare();
  };
  const parseCompare = (): ConditionNode => {
    const left = parsePrimary();
    const t = cur();
    if (t.t === "op" && ["==", "!=", "<", "<=", ">", ">="].includes(t.v)) {
      p++;
      return { type: "compare", op: t.v, left, right: parsePrimary() };
    }
    if (t.t === "word" && !BUILTIN_WORDS.has(t.v)) {
      p++;
      return { type: "compare", op: t.v, left, right: parsePrimary() };
    }
    return left;
  };
  const parsePrimary = (): ConditionNode => {
    const t = cur();
    if (t.t === "str") {
      p++;
      return { type: "literal", value: t.v };
    }
    if (t.t === "num") {
      p++;
      return { type: "literal", value: Number(t.v) };
    }
    if (t.t === "punct" && t.v === "(") {
      p++;
      const e = parseOr();
      if (!(cur().t === "punct" && cur().v === ")")) fail('Expected ")"');
      p++;
      return e;
    }
    if (t.t === "word") {
      if (t.v === "true" || t.v === "false") {
        p++;
        return { type: "literal", value: t.v === "true" };
      }
      if (t.v === "null") {
        p++;
        return { type: "literal", value: null };
      }
      if (BUILTIN_WORDS.has(t.v)) fail(`Unexpected "${t.v}"`);
      const path = [t.v];
      p++;
      while (cur().t === "punct" && cur().v === ".") {
        p++;
        const n = cur();
        if (n.t !== "word") fail("Expected a name after \".\"");
        path.push(n.v);
        p++;
      }
      return { type: "ref", path };
    }
    return fail(t.t === "end" ? "Unexpected end of expression" : `Unexpected "${t.v}"`);
  };

  if (source.trim() === "") fail("Empty condition");
  const ast = parseOr();
  if (cur().t !== "end") fail(`Unexpected "${cur().v}"`);
  return { source, ast };
}

/** All paths referenced by a condition, as dotted strings. */
export function conditionRefs(node: ConditionNode, out: string[] = []): string[] {
  switch (node.type) {
    case "ref":
      out.push(node.path.join("."));
      break;
    case "not":
      conditionRefs(node.arg, out);
      break;
    case "and":
    case "or":
    case "compare":
      conditionRefs(node.left, out);
      conditionRefs(node.right, out);
      break;
    default:
  }
  return out;
}

export function conditionOperatorNames(node: ConditionNode, out: string[] = []): string[] {
  switch (node.type) {
    case "compare":
      out.push(node.op);
      conditionOperatorNames(node.left, out);
      conditionOperatorNames(node.right, out);
      break;
    case "not":
      conditionOperatorNames(node.arg, out);
      break;
    case "and":
    case "or":
      conditionOperatorNames(node.left, out);
      conditionOperatorNames(node.right, out);
      break;
    default:
  }
  return out;
}

function lookup(path: string[], ctx: ConditionContext): unknown {
  const root = path[0] as string;
  let value: unknown;
  if (ctx.variables && Object.prototype.hasOwnProperty.call(ctx.variables, root)) value = ctx.variables[root];
  else if (ctx.state && Object.prototype.hasOwnProperty.call(ctx.state, root)) value = ctx.state[root];
  else {
    // Allow flat keys with dots in state, e.g. { "cart.notEmpty": true }.
    const flat = path.join(".");
    if (ctx.state && Object.prototype.hasOwnProperty.call(ctx.state, flat)) return ctx.state[flat];
    return undefined;
  }
  for (let i = 1; i < path.length; i++) {
    if (value === null || typeof value !== "object") return undefined;
    const key = path[i] as string;
    if (!Object.prototype.hasOwnProperty.call(value, key)) return undefined;
    value = (value as Record<string, unknown>)[key];
  }
  return value;
}

/** Evaluate a parsed condition against a context. */
export function evaluateCondition(
  condition: Condition | ConditionNode,
  ctx: ConditionContext = {},
  options: ConditionOptions = {},
): boolean {
  const root: ConditionNode = "ast" in condition ? condition.ast : condition;
  const source = "ast" in condition ? condition.source : "<condition>";

  const value = (n: ConditionNode): JsonValue | undefined => {
    switch (n.type) {
      case "literal":
        return n.value;
      case "ref": {
        const v = lookup(n.path, ctx);
        if (v === undefined && options.strict) {
          throw new ConditionError(
            `Unknown value "${n.path.join(".")}" in condition "${source}"`,
            { ids: [n.path.join(".")] },
            "UNKNOWN_CONDITION_VALUE",
          );
        }
        return v as JsonValue | undefined;
      }
      default:
        return test(n);
    }
  };

  const truthy = (v: JsonValue | undefined) =>
    v !== undefined && v !== null && v !== false && v !== 0 && v !== "";

  const test = (n: ConditionNode): boolean => {
    switch (n.type) {
      case "literal":
      case "ref":
        return truthy(value(n));
      case "not":
        return !test(n.arg);
      case "and":
        return test(n.left) && test(n.right);
      case "or":
        return test(n.left) || test(n.right);
      case "compare": {
        const l = value(n.left);
        const r = value(n.right);
        switch (n.op) {
          case "==":
            return l !== undefined && r !== undefined && deepEqual(l, r);
          case "!=":
            return !(l !== undefined && r !== undefined && deepEqual(l, r));
          case "<":
          case "<=":
          case ">":
          case ">=": {
            const comparable =
              (typeof l === "number" && typeof r === "number") || (typeof l === "string" && typeof r === "string");
            if (!comparable) return false;
            const a = l as number | string;
            const b = r as number | string;
            return n.op === "<" ? a < b : n.op === "<=" ? a <= b : n.op === ">" ? a > b : a >= b;
          }
          default: {
            const fn = options.operators?.[n.op] ?? BUILTIN_OPERATORS[n.op];
            if (!fn) {
              throw new ConditionError(
                `Unknown operator "${n.op}" in condition "${source}"`,
                { ids: [n.op] },
                "UNKNOWN_OPERATOR",
              );
            }
            return fn(l, r);
          }
        }
      }
    }
  };

  return test(root);
}
