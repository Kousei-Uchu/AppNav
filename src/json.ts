import type { JsonObject, JsonValue } from "./types";

export function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (v === null || typeof v !== "object" || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

export function isThenable(v: unknown): v is PromiseLike<unknown> {
  return (
    v !== null &&
    (typeof v === "object" || typeof v === "function") &&
    typeof (v as { then?: unknown }).then === "function"
  );
}

/** Returns an error message when `v` is not JSON compatible, otherwise undefined. */
export function jsonProblem(v: unknown, path = "$", seen: Set<object> = new Set()): string | undefined {
  if (v === null) return undefined;
  switch (typeof v) {
    case "string":
    case "boolean":
      return undefined;
    case "number":
      return Number.isFinite(v) ? undefined : `${path} is not a finite number`;
    case "object": {
      if (seen.has(v as object)) return `${path} is a circular reference`;
      seen.add(v as object);
      let problem: string | undefined;
      if (Array.isArray(v)) {
        for (let i = 0; i < v.length && !problem; i++) problem = jsonProblem(v[i], `${path}[${i}]`, seen);
      } else if (isPlainObject(v)) {
        for (const k of Object.keys(v)) {
          problem = jsonProblem(v[k], `${path}.${k}`, seen);
          if (problem) break;
        }
      } else {
        problem = `${path} is not a plain object`;
      }
      seen.delete(v as object);
      return problem;
    }
    default:
      return `${path} has unsupported type ${typeof v}`;
  }
}

export function isJsonValue(v: unknown): v is JsonValue {
  return jsonProblem(v) === undefined;
}

export function cloneJson<T extends JsonValue>(v: T): T {
  if (v === null || typeof v !== "object") return v;
  if (Array.isArray(v)) return v.map((x) => cloneJson(x)) as T;
  const out: JsonObject = {};
  for (const k of Object.keys(v)) {
    Object.defineProperty(out, k, {
      value: cloneJson((v as JsonObject)[k] as JsonValue),
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return out as T;
}

export function deepFreeze<T>(v: T): T {
  if (v !== null && typeof v === "object" && !Object.isFrozen(v)) {
    Object.freeze(v);
    for (const k of Object.keys(v as object)) deepFreeze((v as Record<string, unknown>)[k]);
  }
  return v;
}

export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null || typeof a !== "object") return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((x, i) => deepEqual(x, b[i]));
  }
  const ka = Object.keys(a as object);
  const kb = Object.keys(b as object);
  if (ka.length !== kb.length) return false;
  return ka.every((k) =>
    deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]),
  );
}

export function setOwn(obj: Record<string, unknown>, key: string, value: unknown): void {
  Object.defineProperty(obj, key, { value, enumerable: true, writable: true, configurable: true });
}
