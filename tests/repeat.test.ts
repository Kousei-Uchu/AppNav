import { describe, expect, it } from "vitest";
import {
  ParseError,
  ValidationError,
  VariableError,
  buildInstructionsSync,
  calculatePath,
  createRuntime,
  defineExtension,
  indexTreeFromText,
  parseGraph,
} from "../src";

const wrap = (body: string) => `NAVGRAPH/2\n${body}\n`;

const GRAPH = `NAVGRAPH/2
VAR EXTRA_QUANTITY : number
SCREEN cart "Cart"
SCREEN tutorial "Tutorial"
ACTION decrease_quantity "Reduce quantity"
cart -> decrease_quantity { DO TAP { "target": "Reduce Quantity" } repeat=$EXTRA_QUANTITY$ }
decrease_quantity -> cart
cart -> tutorial { DO TAP { "target": "Next" } }
END`;

const build = (variables: Record<string, number> = {}) =>
  buildInstructionsSync(calculatePath(parsedTree, "cart", "decrease_quantity", "astar", { variables }));
const parsedTree = indexTreeFromText(GRAPH);

const codes = (text: string) => indexTreeFromText(text, { diagnostics: "collect" }).diagnostics.map((d) => d.code);

describe("repeat in graph files", () => {
  it("parses a number, a quoted reference and a bare reference", () => {
    const g = parseGraph(
      wrap(
        `SCREEN a "A"\nSCREEN b "B"\n` +
          `a -> b { DO TAP { "target": "x" } repeat=4\n  DO TAP { "target": "y" } repeat="$N$"\n  DO TAP { "target": "z" } repeat=$N$ }`,
      ),
    );
    expect(g.edges[0]?.actions.map((a) => a.repeat)).toEqual([4, "$N$", "$N$"]);
  });

  it("works without a payload, directly before a closing brace, and leaves other actions alone", () => {
    const g = parseGraph(wrap(`SCREEN a "A"\nSCREEN b "B"\na -> b { DO BACK repeat=2 DO WAIT { "durationMs": 5 } DO TAP { "target": "t" } repeat=3}`));
    const actions = g.edges[0]?.actions ?? [];
    expect(actions.map((a) => a.type)).toEqual(["BACK", "WAIT", "TAP"]);
    expect(actions.map((a) => a.repeat)).toEqual([2, undefined, 3]);
    expect("repeat" in (actions[1] ?? {})).toBe(false);
  });

  it("reports malformed repeats with a position", () => {
    const bad = (value: string) => () => parseGraph(wrap(`SCREEN a "A"\na -> a { DO TAP { "target": "t" } ${value} }`));
    expect(bad("repeat=abc")).toThrow(ParseError);
    expect(bad("repeat=abc")).toThrow(/whole number or a \$NAME\$/);
    expect(bad("repeat=")).toThrow(/got nothing/);
    expect(bad("repeat 4")).toThrow(/Expected "="/);
    try {
      bad("repeat=abc")();
    } catch (e) {
      expect((e as ParseError).code).toBe("INVALID_REPEAT");
      expect((e as ParseError).line).toBe(3);
    }
  });
});

describe("repeat validation", () => {
  const withRepeat = (repeat: string) =>
    `NAVGRAPH/2\nVAR N : number\nVAR S : string = "x"\nVAR ANY : any\nSCREEN a "A"\na -> a { DO TAP { "target": "t" } repeat=${repeat} }`;

  it("accepts whole numbers of at least 1 and number or any variables", () => {
    expect(codes(withRepeat("1"))).toEqual([]);
    expect(codes(withRepeat("12"))).toEqual([]);
    expect(codes(withRepeat("$N$"))).toEqual([]);
    expect(codes(withRepeat('"$ANY$"'))).toEqual([]);
  });

  it("rejects zero, negatives and fractions", () => {
    for (const bad of ["0", "-1", "2.5"]) expect(codes(withRepeat(bad)), bad).toEqual(["INVALID_REPEAT"]);
  });

  it("rejects text and mixed templates", () => {
    expect(codes(withRepeat('"two"'))).toEqual(["INVALID_REPEAT"]);
    expect(codes(withRepeat('"x$N$"'))).toEqual(["INVALID_REPEAT"]);
  });

  it("checks the variable is declared and numeric", () => {
    expect(codes(withRepeat("$GHOST$"))).toEqual(["UNDEFINED_VARIABLE"]);
    expect(codes(withRepeat("$S$"))).toEqual(["INVALID_REPEAT"]);
    expect(() => indexTreeFromText(withRepeat("0"))).toThrow(ValidationError);
  });
});

describe("repeat in instructions", () => {
  it("keeps a literal repeat as data on the action instead of duplicating the step", () => {
    const tree = indexTreeFromText(wrap(`SCREEN a "A"\nSCREEN b "B"\na -> b { DO TAP { "target": "Reduce" } repeat=4 }`));
    const out = buildInstructionsSync(calculatePath(tree, "a", "b"));
    expect(out.steps).toHaveLength(1);
    expect(out.steps[0]?.actions).toHaveLength(1);
    expect(out.steps[0]?.actions[0]?.repeat).toBe(4);
    expect(JSON.parse(JSON.stringify(out))).toEqual(out);
  });

  it("leaves repeat off actions that do not declare one", () => {
    const out = buildInstructionsSync(calculatePath(parsedTree, "cart", "tutorial"));
    expect("repeat" in (out.steps[0]?.actions[0] ?? {})).toBe(false);
  });

  it("resolves a variable repeat from the route variables", () => {
    const out = build({ EXTRA_QUANTITY: 4 });
    expect(out.path).toEqual(["cart", "decrease_quantity"]);
    expect(out.steps[0]?.actions[0]).toMatchObject({ type: "TAP", data: { target: "Reduce Quantity" }, repeat: 4 });
  });

  it("lets build options override the route variables, and runtime values win", () => {
    const path = calculatePath(parsedTree, "cart", "decrease_quantity", "astar", { variables: { EXTRA_QUANTITY: 4 } });
    expect(buildInstructionsSync(path, { variables: { EXTRA_QUANTITY: 2 } }).steps[0]?.actions[0]?.repeat).toBe(2);
    expect(buildInstructionsSync(path, { runtime: { EXTRA_QUANTITY: 7 } }).steps[0]?.actions[0]?.repeat).toBe(7);
  });

  it("fails when the variable has no value", () => {
    expect(() => build()).toThrow(VariableError);
    expect(() => build()).toThrow(/required but no value/);
  });

  it("rejects a resolved value that is not a whole number of at least 1", () => {
    for (const bad of [0, -2, 2.5]) {
      let error: unknown;
      try {
        build({ EXTRA_QUANTITY: bad });
      } catch (e) {
        error = e;
      }
      expect(error, String(bad)).toBeInstanceOf(VariableError);
      expect((error as VariableError).code).toBe("INVALID_REPEAT");
      expect((error as VariableError).message).toMatch(/whole number of at least 1/);
    }
  });

  it("is visible to extensions", () => {
    const seen = defineExtension({ name: "seen", run: ({ action }) => ({ repeat: action.repeat ?? 1 }) });
    const path = calculatePath(parsedTree, "cart", "decrease_quantity", "astar", { variables: { EXTRA_QUANTITY: 3 } });
    expect(buildInstructionsSync(path, { extensions: [seen] }).steps[0]?.actions[0]?.extensions).toEqual({ seen: { repeat: 3 } });
  });

  it("does not change the cost, which belongs to the edge", () => {
    expect(build({ EXTRA_QUANTITY: 9 }).cost).toBe(build({ EXTRA_QUANTITY: 1 }).cost);
  });
});

describe("repeat in registered actions", () => {
  const swipe = { type: "SWIPE", data: { direction: "left" }, repeat: 3 };

  it("registerActions carries repeat onto the edge into the node", () => {
    const tree = indexTreeFromText(wrap(`SCREEN cart "Cart"`));
    tree.registerActions("cart", { remove_item: { actions: [swipe] } });
    expect(tree.edge("cart->remove_item")?.actions[0]?.repeat).toBe(3);
    expect(buildInstructionsSync(calculatePath(tree, "cart", "remove_item")).steps[0]?.actions[0]?.repeat).toBe(3);
  });

  it("registerActions accepts a variable the app fills in at planning time", () => {
    const tree = indexTreeFromText(`NAVGRAPH/2\nVAR EXTRA_QUANTITY : number\nSCREEN cart "Cart"\nEND`);
    tree.registerActions("cart", {
      decrease_quantity: { actions: [{ type: "TAP", data: { target: "Reduce Quantity" }, repeat: "$EXTRA_QUANTITY$" }] },
    });
    const path = calculatePath(tree, "cart", "decrease_quantity", "astar", { variables: { EXTRA_QUANTITY: 4 } });
    expect(buildInstructionsSync(path).steps[0]?.actions[0]?.repeat).toBe(4);
  });

  it("rejects bad repeats at registration and leaves the tree unchanged", () => {
    const tree = indexTreeFromText(wrap(`SCREEN cart "Cart"`));
    const edges = tree.edges.length;
    for (const repeat of [0, 1.5, "$GHOST$", "many"]) {
      let error: unknown;
      try {
        tree.registerActions("cart", { bad: { actions: [{ type: "TAP", data: { target: "t" }, repeat }] } });
      } catch (e) {
        error = e;
      }
      expect(error, String(repeat)).toBeInstanceOf(ValidationError);
    }
    expect(tree.edges.length).toBe(edges);
    expect(tree.hasScreen("bad")).toBe(false);
  });

  it("registerEdges validates repeat the same way", () => {
    const tree = indexTreeFromText(wrap(`SCREEN a "A"\nSCREEN b "B"`));
    expect(() => tree.registerEdges([{ from: "a", to: "b", actions: [{ type: "BACK", repeat: 0 }] }])).toThrow(/INVALID_REPEAT|invalid repeat/);
    tree.registerEdges([{ from: "a", to: "b", actions: [{ type: "BACK", repeat: 2 }] }]);
    expect(tree.edge("a->b")?.actions[0]?.repeat).toBe(2);
  });

  it("template copies keep the repeat of the edges they clone", () => {
    const tree = indexTreeFromText(wrap(`SCREEN list "List"\nSCREEN row "Row"\nlist -> row { DO TAP { "target": "Row" } repeat=2 }\nrow -> list`));
    tree.registerScreens(["a"], "row");
    expect(tree.edge("list->row:a")?.actions[0]?.repeat).toBe(2);
  });
});

describe("repeat in the runtime", () => {
  const instr = build({ EXTRA_QUANTITY: 3 });

  it("runs a handler once per repetition and tells it which one it is", async () => {
    const calls: string[] = [];
    const rt = createRuntime({ TAP: ({ iteration, iterations }) => calls.push(`${iteration}/${iterations}`) });
    const res = await rt.execute(instr);
    expect(res.ok).toBe(true);
    expect(calls).toEqual(["1/3", "2/3", "3/3"]);
    expect(res.results.map((r) => r.iteration)).toEqual([1, 2, 3]);
    expect(res.results.every((r) => r.status === "ok" && r.stepN === 1 && r.actionIndex === 0)).toBe(true);
  });

  it("works with the synchronous executor", () => {
    let n = 0;
    const res = createRuntime({ TAP: () => ++n }).executeSync(instr);
    expect(n).toBe(3);
    expect(res.results).toHaveLength(3);
  });

  it("runs actions without a repeat once and adds no iteration to their results", async () => {
    const plain = buildInstructionsSync(calculatePath(parsedTree, "cart", "tutorial"));
    const seen: Array<[number, number]> = [];
    const res = await createRuntime({ TAP: ({ iteration, iterations }) => seen.push([iteration, iterations]) }).execute(plain);
    expect(seen).toEqual([[1, 1]]);
    expect("iteration" in (res.results[0] ?? {})).toBe(false);
  });

  it("stops repeating an action after a failed repetition", async () => {
    let n = 0;
    const rt = createRuntime({
      TAP: () => {
        if (++n === 2) throw new Error("boom");
      },
    });
    const stop = await rt.execute(instr);
    expect(stop.ok).toBe(false);
    expect(stop.results.map((r) => r.status)).toEqual(["ok", "error"]);
    n = 0;
    const cont = await rt.execute(instr, { continueOnError: true });
    expect(cont.results.map((r) => r.status)).toEqual(["ok", "error"]);
    expect(n).toBe(2);
  });

  it("reports a missing handler once, not once per repetition", async () => {
    const res = await createRuntime({}).execute(instr, { continueOnError: true });
    expect(res.results).toHaveLength(1);
    expect(res.results[0]?.status).toBe("error");
  });
});
