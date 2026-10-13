import { describe, expect, it } from "vitest";
import { ParseError, UnsupportedVersionError, parseGraph } from "../src";
import { exampleText } from "./helpers";

const wrap = (body: string) => `NAVGRAPH/2\n${body}\n`;

describe("parseGraph", () => {
  it("parses the example graph", () => {
    const g = parseGraph(exampleText("app.navgraph"), { file: "app.navgraph" });
    expect(g.app).toBe("Example Store");
    expect(g.screens).toHaveLength(16);
    expect(g.variables.map((v) => v.name)).toEqual(["USER_NAME", "PRODUCT_ID", "QUANTITY", "SIGNED_IN"]);
    expect(g.hasEnd).toBe(true);
    const quick = g.edges.find((e) => e.id === "quick_checkout");
    expect(quick?.cost).toBe(5);
    expect(quick?.actions.map((a) => a.data.target)).toEqual(["Shop", "Cart", "Checkout"]);
  });

  it("keeps variable defaults and required variables apart", () => {
    const g = parseGraph(wrap('VAR A : string\nVAR B : number = 0\nVAR C : null = null'));
    expect(g.variables.map((v) => v.hasDefault)).toEqual([false, true, true]);
    expect(g.variables[2]?.default).toBeNull();
  });

  it("parses nested JSON payloads, comments and strings containing braces", () => {
    const g = parseGraph(
      wrap(`SCREEN a "A # not a comment"\nSCREEN b "B" { "x": [1, {"y": "}"}] } # trailing\n` +
        `a -> b { # comment\n DO TAP { "target": "t}", "match": { "k": [1,2,{"z":null}] } }\n}`),
    );
    expect(g.screens[0]?.name).toBe("A # not a comment");
    expect(g.screens[1]?.meta).toEqual({ x: [1, { y: "}" }] });
    expect(g.edges[0]?.actions[0]?.data).toEqual({ target: "t}", match: { k: [1, 2, { z: null }] } });
  });

  it("supports empty action edges, bare DO and keyword named screens", () => {
    const g = parseGraph(wrap(`SCREEN a "A"\nSCREEN END2 "E"\nSCREEN b "B"\na -> b\nb -> a { DO BACK DO TAP {"target":"x"} }`));
    expect(g.edges[0]?.actions).toEqual([]);
    expect(g.edges[1]?.actions.map((a) => a.type)).toEqual(["BACK", "TAP"]);
  });

  it("parses edge attributes", () => {
    const g = parseGraph(wrap(`SCREEN a "A"\nSCREEN b "B"\na -> b [cost=2.5, if=a == "x, y" and b > 3, id=hop, label="Go", weight=7, flag=true]`));
    const e = g.edges[0];
    expect(e?.cost).toBe(2.5);
    expect(e?.condition).toBe('a == "x, y" and b > 3');
    expect(e?.id).toBe("hop");
    expect(e?.meta).toEqual({ label: "Go", weight: 7, flag: true });
  });

  it("reports line and column", () => {
    try {
      parseGraph(wrap(`SCREEN a "A"\n  a -> $`), { file: "x.navgraph" });
      throw new Error("expected failure");
    } catch (e) {
      expect(e).toBeInstanceOf(ParseError);
      const err = e as ParseError;
      expect(err.file).toBe("x.navgraph");
      expect(err.line).toBe(3);
      expect(err.column).toBe(8);
    }
  });

  it("rejects bad input", () => {
    expect(() => parseGraph("SCREEN a \"A\"")).toThrow(/Missing header/);
    expect(() => parseGraph("NAVGRAPH/1\n")).toThrow(UnsupportedVersionError);
    expect(() => parseGraph(wrap(`SCREEN a "A`))).toThrow(/Unterminated string/);
    expect(() => parseGraph(wrap(`SCREEN a "A"\na -> a { DO TAP { "t": } }`))).toThrow(/Invalid JSON/);
    expect(() => parseGraph(wrap(`SCREEN a "A"\na -> a { DO TAP { "t": 1 }`))).toThrow(/Unterminated/);
    expect(() => parseGraph(wrap(`VAR X : thing`))).toThrow(/Unknown variable type/);
    expect(() => parseGraph(wrap(`SCREEN a "A"\na -> a [cost=abc]`))).toThrow(/cost must be a number/);
    expect(() => parseGraph(wrap(`SCREEN a "A"\na -> a [cost=1, cost=2]`))).toThrow(/Duplicate attribute/);
    expect(() => parseGraph(wrap(`END\nSCREEN a "A"`))).toThrow(/after END/);
    expect(() => parseGraph(wrap(`SCREEN a "A" junk`))).toThrow(/Unexpected content/);
  });

  it("allows a missing END and a UTF-8 BOM", () => {
    const g = parseGraph("\uFEFFNAVGRAPH/2\nSCREEN a \"A\"");
    expect(g.hasEnd).toBe(false);
    expect(g.screens).toHaveLength(1);
  });
});
