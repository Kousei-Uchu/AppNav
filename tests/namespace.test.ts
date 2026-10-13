import { describe, expect, it } from "vitest";
import * as Everything from "../src";
import { AppNav, VERSION } from "../src";
import { exampleText } from "./helpers";

describe("public API", () => {
  it("exposes the spec's usage shape", async () => {
    const tree = AppNav.indexTreeFromText(exampleText("app.navgraph"));
    const path = AppNav.calculatePath(tree, "home", "checkout", AppNav.ASTAR, { variables: { PRODUCT_ID: "PRODUCT_123" } });
    const out = await AppNav.buildInstructions(path, { variables: { PRODUCT_ID: "PRODUCT_123" } });
    expect(out.steps).toHaveLength(3);
    expect(VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("namespace and named exports agree", () => {
    expect(Everything.AppNav.calculatePath).toBe(Everything.calculatePath);
    expect(Everything.AppNav.ASTAR).toBe("astar");
  });
});
