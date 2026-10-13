import { describe, expect, it } from "vitest";
import {
  AsyncExtensionError,
  ExtensionError,
  VariableError,
  buildInstructions,
  buildInstructionsSync,
  calculatePath,
  defineExtension,
  getExtensionOutput,
  indexTreeFromText,
  isAction,
} from "../src";
import type { JsonObject } from "../src";
import { exampleText } from "./helpers";

const tree = indexTreeFromText(exampleText("app.navgraph"));
const vars = { PRODUCT_ID: "PRODUCT_123", QUANTITY: 2 };
const path = (to = "cart") => calculatePath(tree, "home", to, "astar", { variables: vars });
// Forces the longer route home -> shop -> product -> cart so payload variables are exercised.
const viaProduct = () =>
  calculatePath(tree, "home", "cart", "astar", { variables: vars, edgeFilter: (e) => e.id !== "shop->cart" });

describe("buildInstructions", () => {
  it("builds the documented instruction shape", async () => {
    const out = await buildInstructions(path("checkout"));
    expect(out.from).toBe("home");
    expect(out.to).toBe("checkout");
    expect(out.path).toEqual(["home", "shop", "cart", "checkout"]);
    expect(out.cost).toBe(3);
    expect(out.steps.map((s) => s.n)).toEqual([1, 2, 3]);
    expect(out.steps[0]?.actions[0]).toEqual({ type: "TAP", data: { target: "Shop", waitFor: "screen:shop" }, extensions: {} });
    expect(out.meta).toEqual({ app: "Example Store", algorithm: "astar", generator: "appnav" });
    expect(JSON.parse(JSON.stringify(out))).toEqual(out);
  });

  it("resolves variables with native types and keeps action order", async () => {
    const out = await buildInstructions(viaProduct());
    const step = out.steps[1];
    expect(step?.actions.map((a) => a.type)).toEqual(["TAP", "WAIT"]);
    expect(step?.actions[0]?.data).toEqual({ target: "Product Card", match: { productId: "PRODUCT_123" }, index: 0 });
    const last = out.steps[2];
    expect(last?.actions[1]?.data).toEqual({ key: "cart.quantity", value: 2 });
  });

  it("uses variables stored on the path and lets build options override them", async () => {
    expect((await buildInstructions(viaProduct())).steps[1]?.actions[0]?.data).toMatchObject({ match: { productId: "PRODUCT_123" } });
    const o = await buildInstructions(viaProduct(), { variables: { PRODUCT_ID: "OTHER" } });
    expect(o.steps[1]?.actions[0]?.data).toMatchObject({ match: { productId: "OTHER" } });
    const r = await buildInstructions(viaProduct(), { runtime: { PRODUCT_ID: "RT" } });
    expect(r.steps[1]?.actions[0]?.data).toMatchObject({ match: { productId: "RT" } });
  });

  it("fails clearly when a required variable is missing", async () => {
    const p = calculatePath(tree, "home", "product");
    await expect(buildInstructions(p)).rejects.toThrow(VariableError);
    expect(() => buildInstructionsSync(p)).toThrow(/required but no value/);
  });

  it("can keep unresolved payloads for debugging", async () => {
    const out = await buildInstructions(viaProduct(), { includeUnresolved: true });
    expect(out.steps[1]?.actions[0]?.unresolved).toMatchObject({ match: { productId: "$PRODUCT_ID$" } });
  });

  it("narrows actions by type", async () => {
    const out = await buildInstructions(path("cart"));
    const a = out.steps[0]!.actions[0]!;
    if (isAction(a, "TAP")) {
      expect(a.data.target).toBe("Shop");
    } else throw new Error("expected TAP");
  });

  it("rejects things that are not paths", async () => {
    await expect(buildInstructions({} as never)).rejects.toThrow(/expects a Path/);
  });
});

describe("extensions", () => {
  const narration = defineExtension({
    name: "narration",
    variables: { style: "concise" },
    run({ action, variables }) {
      return { text: `${variables.style}: tap ${String(action.data.target)}.` };
    },
  });

  it("adds namespaced action output during generation", async () => {
    const out = await buildInstructions(path("checkout"), { extensions: [narration] });
    expect(out.steps[0]?.actions[0]?.extensions).toEqual({ narration: { text: "concise: tap Shop." } });
    expect(getExtensionOutput(out.steps[0]!.actions[0]!, narration)?.text).toBe("concise: tap Shop.");
  });

  it("supports the inline object form and per build variable overrides", async () => {
    const out = await buildInstructions(path("checkout"), {
      extensions: {
        formatInstruction: {
          variables: { tone: "friendly" },
          run: ({ action, from, to, variables }) => ({
            text: `From ${from.name}, tap ${String(action.data.target).toLowerCase()} to reach ${to.name}.`,
            tone: String(variables.tone),
          }),
        },
      },
      extensionVariables: { formatInstruction: { tone: "formal" } },
    });
    expect(out.steps[0]?.actions[0]?.extensions.formatInstruction).toEqual({ text: "From Home, tap shop to reach Shop.", tone: "formal" });
  });

  it("calls action, step and route hooks in a deterministic order with correct counts", async () => {
    const calls: string[] = [];
    const ext = defineExtension({
      name: "order",
      run: ({ step, actionIndex }) => {
        calls.push(`a${step.n}.${actionIndex}`);
      },
      step: ({ step }) => {
        calls.push(`s${step.n}`);
      },
      route: () => {
        calls.push("r");
        return { done: true };
      },
    });
    const out = await buildInstructions(viaProduct(), { extensions: [ext] });
    expect(calls).toEqual(["a1.0", "s1", "a2.0", "a2.1", "s2", "a3.0", "a3.1", "s3", "r"]);
    expect(out.extensions.order).toEqual({ done: true });
  });

  it("gives step hooks the action output and route hooks everything", async () => {
    const a = defineExtension({ name: "a", run: () => ({ n: 1 }) });
    const b = defineExtension<"b", JsonObject>({
      name: "b",
      step: ({ step }) => ({ actions: step.actions.length, sawA: step.actions.every((x) => "a" in x.extensions) }),
      route: ({ instructions }) => ({ steps: instructions.steps.length, stepOutput: "b" in (instructions.steps[0]?.extensions ?? {}) }),
    });
    const out = await buildInstructions(path("shop"), { extensions: [a, b] });
    expect(out.steps[0]?.extensions.b).toEqual({ actions: 1, sawA: true });
    expect(out.extensions.b).toEqual({ steps: 1, stepOutput: true });
  });

  it("supports declared dependencies and orders them", async () => {
    const second = defineExtension({ name: "second", dependsOn: ["first"], run: ({ outputs }) => ({ saw: outputs.first ?? null }) });
    const first = defineExtension({ name: "first", run: () => ({ v: 1 }) });
    const out = await buildInstructions(path("shop"), { extensions: [second, first] });
    expect(out.steps[0]?.actions[0]?.extensions.second).toEqual({ saw: { v: 1 } });
    expect(() => defineExtension({ name: "x", dependsOn: ["y"], run: () => undefined })).not.toThrow();
    const lone = defineExtension({ name: "lone", dependsOn: ["ghost"], run: () => undefined });
    await expect(buildInstructions(path("shop"), { extensions: [lone] })).rejects.toThrow(/unknown extension/);
    const c1 = defineExtension({ name: "c1", dependsOn: ["c2"], run: () => undefined });
    const c2 = defineExtension({ name: "c2", dependsOn: ["c1"], run: () => undefined });
    await expect(buildInstructions(path("shop"), { extensions: [c1, c2] })).rejects.toThrow(/circular/);
  });

  it("hides outputs of extensions that were not declared as dependencies", async () => {
    const first = defineExtension({ name: "first", run: () => ({ v: 1 }) });
    const peek = defineExtension({ name: "peek", run: ({ outputs }) => ({ keys: Object.keys(outputs) }) });
    const out = await buildInstructions(path("shop"), { extensions: [first, peek] });
    expect(out.steps[0]?.actions[0]?.extensions.peek).toEqual({ keys: [] });
  });

  it("passes read only inputs", async () => {
    const mut = defineExtension({
      name: "mut",
      run: ({ action }) => {
        (action.data as Record<string, unknown>).target = "hacked";
      },
    });
    await expect(buildInstructions(path("shop"), { extensions: [mut] })).rejects.toThrow(ExtensionError);
    const out = await buildInstructions(path("shop"), { extensions: [narration] });
    expect(out.steps[0]?.actions[0]?.data.target).toBe("Shop");
  });

  it("awaits async hooks, and the sync builder rejects them", async () => {
    const slow = defineExtension({
      name: "slow",
      run: async ({ action }) => {
        await new Promise((r) => setTimeout(r, 2));
        return { t: String(action.data.target) };
      },
    });
    const out = await buildInstructions(path("shop"), { extensions: [slow] });
    expect(out.steps[0]?.actions[0]?.extensions.slow).toEqual({ t: "Shop" });
    expect(() => buildInstructionsSync(path("shop"), { extensions: [slow] })).toThrow(AsyncExtensionError);
  });

  it("builds synchronously with sync hooks", () => {
    const out = buildInstructionsSync(path("shop"), { extensions: [narration] });
    expect(out.steps[0]?.actions[0]?.extensions.narration).toEqual({ text: "concise: tap Shop." });
  });

  it("fails with ExtensionError by default, or collects warnings", async () => {
    const boom = defineExtension({ name: "boom", run: () => { throw new Error("nope"); } });
    await expect(buildInstructions(path("shop"), { extensions: [boom] })).rejects.toThrow(/boom.*nope/);
    const rejecting = defineExtension({ name: "rej", run: async () => { throw new Error("async nope"); } });
    await expect(buildInstructions(path("shop"), { extensions: [rejecting] })).rejects.toBeInstanceOf(ExtensionError);
    const out = await buildInstructions(path("shop"), { extensions: [boom, narration], onError: "collect" });
    expect(out.warnings).toHaveLength(1);
    expect(out.warnings?.[0]?.severity).toBe("warning");
    expect(out.steps[0]?.actions[0]?.extensions).toEqual({ narration: { text: "concise: tap Shop." } });
    expect(() => buildInstructionsSync(path("shop"), { extensions: [boom] })).toThrow(ExtensionError);
  });

  it("rejects non JSON output and output that fails validation", async () => {
    const bad = defineExtension({ name: "bad", run: () => ({ f: () => 1 }) as never });
    await expect(buildInstructions(path("shop"), { extensions: [bad] })).rejects.toThrow(/not JSON compatible/);
    const nan = defineExtension({ name: "nan", run: () => ({ n: NaN }) });
    await expect(buildInstructions(path("shop"), { extensions: [nan] })).rejects.toThrow(/finite/);
    const strict = defineExtension({ name: "strict", run: () => ({ n: 1 }), validate: (o) => (o.n === 2 ? true : "n must be 2") });
    await expect(buildInstructions(path("shop"), { extensions: [strict] })).rejects.toThrow(/n must be 2/);
  });

  it("validates definitions and names", () => {
    expect(() => defineExtension({ name: "bad name", run: () => undefined })).toThrow(ExtensionError);
    expect(() => defineExtension({ name: "__proto__", run: () => undefined })).toThrow(ExtensionError);
    expect(() => defineExtension({ name: "empty" })).toThrow(/at least one hook/);
    expect(() => defineExtension({ name: "both", run: () => undefined, action: () => undefined })).toThrow(/not both/);
  });

  it("rejects duplicate names and hand rolled extension objects", async () => {
    await expect(buildInstructions(path("shop"), { extensions: [narration, narration] })).rejects.toThrow(/duplicate/);
    await expect(buildInstructions(path("shop"), { extensions: [{ name: "x" } as never] })).rejects.toThrow(/defineExtension/);
  });

  it("does not let extensions change the path or cost", async () => {
    const p = path("checkout");
    const before = JSON.stringify(p);
    const out = await buildInstructions(p, { extensions: [narration] });
    expect(JSON.stringify(p)).toBe(before);
    expect(out.cost).toBe(p.cost);
  });
});
