import { describe, expect, it, vi } from "vitest";
import {
  ActionHandlerError,
  AsyncExtensionError,
  buildInstructionsSync,
  calculatePath,
  createRuntime,
  indexTreeFromText,
} from "../src";
import { exampleText } from "./helpers";

const tree = indexTreeFromText(exampleText("app.navgraph"));
const instr = buildInstructionsSync(calculatePath(tree, "home", "cart", "astar", { variables: { PRODUCT_ID: "P" }, edgeFilter: (e) => e.id !== "shop->cart" }));

describe("runtime", () => {
  it("executes actions in order with a handler per type", async () => {
    const seen: string[] = [];
    const rt = createRuntime<{ log: string[] }>({
      TAP: ({ action, context }) => context.log.push(`tap:${String(action.data.target)}`),
      WAIT: async ({ context }) => { await Promise.resolve(); context.log.push("wait"); },
      SET_STATE: ({ context }) => context.log.push("state"),
    });
    const ctx = { log: seen };
    const res = await rt.execute(instr, { context: ctx });
    expect(res.ok).toBe(true);
    expect(seen).toEqual(["tap:Shop", "tap:Product Card", "wait", "tap:Add to Cart", "state"]);
  });

  it("reports missing handlers, can skip them, and can continue on error", async () => {
    const rt = createRuntime({ TAP: () => 1 });
    const stop = await rt.execute(instr);
    expect(stop.ok).toBe(false);
    expect(stop.results.at(-1)?.error).toBeInstanceOf(ActionHandlerError);
    const skip = await rt.execute(instr, { skipUnhandled: true });
    expect(skip.ok).toBe(true);
    expect(skip.results.filter((r) => r.status === "skipped")).toHaveLength(2);
    const cont = await rt.execute(instr, { continueOnError: true });
    expect(cont.results).toHaveLength(5);
  });

  it("retries and times out", async () => {
    let n = 0;
    const rt = createRuntime({
      TAP: { handler: () => { if (++n < 3) throw new Error("flaky"); }, options: { retries: 2 } },
      WAIT: { handler: () => new Promise(() => undefined), options: { timeoutMs: 5 } },
      SET_STATE: () => 1,
    });
    const res = await rt.execute(instr, { continueOnError: true });
    expect(res.results[0]?.attempts).toBe(3);
    expect(res.results[0]?.status).toBe("ok");
    const w = res.results.find((r) => r.type === "WAIT");
    expect(w?.status).toBe("error");
    expect((w?.error as ActionHandlerError).code).toBe("TIMEOUT");
  });

  it("has a sync mode that rejects async handlers", () => {
    const sync = createRuntime({ TAP: () => 1, WAIT: () => 2, SET_STATE: () => 3 });
    expect(sync.executeSync(instr).ok).toBe(true);
    const mixed = createRuntime({ TAP: () => 1, WAIT: async () => 2, SET_STATE: () => 3 });
    expect(() => mixed.executeSync(instr)).toThrow(AsyncExtensionError);
  });

  it("honours abort signals and callbacks", async () => {
    const ac = new AbortController();
    const onAction = vi.fn(() => ac.abort());
    const rt = createRuntime({ TAP: () => 1, WAIT: () => 2, SET_STATE: () => 3 });
    await expect(rt.execute(instr, { signal: ac.signal, onAction })).rejects.toThrow(/aborted/);
    expect(onAction).toHaveBeenCalledTimes(1);
  });
});
