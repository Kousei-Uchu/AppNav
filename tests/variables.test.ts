import { describe, expect, it } from "vitest";
import { VariableError, buildScope, resolveValue, type VariableDeclaration } from "../src";

const d = (name: string, type: VariableDeclaration["type"], def?: VariableDeclaration["default"]): VariableDeclaration =>
  def === undefined ? { name, type, hasDefault: false } : { name, type, hasDefault: true, default: def };

const decls = {
  S: d("S", "string", "SKU-123"),
  N: d("N", "number", 3),
  B: d("B", "boolean", true),
  O: d("O", "object", { a: 1 }),
  REQ: d("REQ", "string"),
};

describe("variables", () => {
  const scope = buildScope(decls);

  it("substitutes whole-string references with native types", () => {
    expect(resolveValue({ p: "$S$", q: "$N$", g: "$B$", o: "$O$", l: "Product $S$" }, scope, decls)).toEqual({
      p: "SKU-123",
      q: 3,
      g: true,
      o: { a: 1 },
      l: "Product SKU-123",
    });
  });

  it("walks arrays and nested objects but not keys", () => {
    expect(resolveValue({ "$S$": ["$N$", { x: "$B$" }] }, scope, decls)).toEqual({ "$S$": [3, { x: true }] });
  });

  it("interpolates non-strings as text", () => {
    expect(resolveValue("n=$N$ b=$B$ o=$O$", scope, decls)).toBe('n=3 b=true o={"a":1}');
  });

  it("supports escapes and ignores lone dollars", () => {
    expect(resolveValue("$$S$$ costs $5 and $a", scope, decls)).toBe("$S$ costs $5 and $a");
  });

  it("does not alias objects from the scope", () => {
    const out = resolveValue("$O$", scope, decls) as { a: number };
    out.a = 99;
    expect(scope.O).toEqual({ a: 1 });
  });

  it("fails on missing and undefined variables", () => {
    expect(() => resolveValue("$REQ$", scope, decls)).toThrow(/required but no value/);
    expect(() => resolveValue("$NOPE$", scope, decls)).toThrow(/Undefined variable/);
    expect(() => resolveValue("$NOPE$", scope, decls)).toThrow(VariableError);
  });

  it("applies precedence: defaults < route < runtime", () => {
    const s = buildScope(decls, { variables: { N: 4, REQ: "r" }, runtime: { N: 5 } });
    expect(s.N).toBe(5);
    expect(s.REQ).toBe("r");
    expect(s.S).toBe("SKU-123");
  });

  it("type checks supplied values and optionally rejects undeclared ones", () => {
    expect(() => buildScope(decls, { variables: { N: "x" } })).toThrow(/must be number/);
    expect(() => buildScope(decls, { variables: { ZZ: 1 }, strict: true })).toThrow(/Unknown route variable/);
    expect(buildScope(decls, { variables: { ZZ: 1 } }).ZZ).toBe(1);
  });
});
