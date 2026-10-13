import { describe, expect, it } from "vitest";
import { ConditionError, evaluateCondition, parseCondition, type ConditionOptions } from "../src";

const ev = (src: string, variables = {}, state = {}, opts: ConditionOptions = {}) =>
  evaluateCondition(parseCondition(src), { variables, state }, opts);

describe("conditions", () => {
  it("handles booleans, precedence and parentheses", () => {
    expect(ev("a || b && c", { a: true, b: false, c: false })).toBe(true);
    expect(ev("(a || b) && c", { a: true, b: false, c: false })).toBe(false);
    expect(ev("!a")).toBe(true);
    expect(ev("not a and b", { a: false, b: true })).toBe(true);
  });

  it("compares values", () => {
    expect(ev("n >= 3 and n < 10", { n: 3 })).toBe(true);
    expect(ev('s == "x"', { s: "x" })).toBe(true);
    expect(ev("s != 'x'", { s: "y" })).toBe(true);
    expect(ev("n < 'a'", { n: 1 })).toBe(false);
    expect(ev("o == p", { o: { a: [1] }, p: { a: [1] } })).toBe(true);
  });

  it("looks up dotted paths in variables and state", () => {
    expect(ev("user.age > 17", { user: { age: 20 } })).toBe(true);
    expect(ev("cart.notEmpty", {}, { cart: { notEmpty: true } })).toBe(true);
    expect(ev("cart.notEmpty", {}, { "cart.notEmpty": true })).toBe(true);
    expect(ev("v", { v: true }, { v: false })).toBe(true);
  });

  it("treats unknown values as undefined, or throws in strict mode", () => {
    expect(ev("missing")).toBe(false);
    expect(ev("missing == 1")).toBe(false);
    expect(ev("missing != 1")).toBe(true);
    expect(() => ev("missing", {}, {}, { strict: true })).toThrow(ConditionError);
  });

  it("supports built in and custom word operators", () => {
    expect(ev("role in roles", { role: "a", roles: ["a", "b"] })).toBe(true);
    expect(ev('name contains "sp"', { name: "Aspen" })).toBe(true);
    expect(ev("a startsWith 'As'", { a: "Aspen" }, {}, { operators: { startsWith: (l, r) => String(l).startsWith(String(r)) } })).toBe(true);
    expect(() => ev("a nope 'x'", { a: "x" })).toThrow(/Unknown operator/);
  });

  it("rejects bad syntax and never evaluates code", () => {
    for (const bad of ["", "a &&", "(a", "a ==", "a.", "process.exit()", "1 +", "a b c"]) {
      expect(() => ev(bad)).toThrow(ConditionError);
    }
  });
});
