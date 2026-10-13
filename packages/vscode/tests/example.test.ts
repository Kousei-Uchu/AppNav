import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { loadSchema, tryCalculatePath } from "routegraph";
import { analyze, routeVariables, toRouteModel } from "../src/analysis";

const pkg = join(__dirname, "../node_modules/routegraph/examples");
const text = readFileSync(join(pkg, "app.navgraph"), "utf8");

describe("the example graph shipped with routegraph", () => {
  it("is clean under the default schema", () => {
    const r = analyze(text);
    expect(r.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    expect(r.tree!.screens.size).toBe(16);
  });

  it("is clean under its own schema", async () => {
    const schema = await loadSchema(join(pkg, "app.navschema"));
    const r = analyze(text, { schema });
    expect(r.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    expect(Object.keys(r.tree!.schema.actions)).toContain("SCAN_QR");
  });

  it("routes across the whole graph and honours conditions", () => {
    const r = analyze(text);
    const vars = routeVariables(r.tree!);
    const ok = tryCalculatePath(r.tree!, "home", "password", "astar", { variables: vars });
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(toRouteModel(ok.path).screens).toEqual(["home", "profile", "edit", "password"]);

    const locked = tryCalculatePath(r.tree!, "home", "privacy", "astar", { variables: vars });
    expect(locked.ok).toBe(false);
    const unlocked = tryCalculatePath(r.tree!, "home", "privacy", "astar", {
      variables: routeVariables(r.tree!, { SIGNED_IN: true }),
    });
    expect(unlocked.ok).toBe(true);
  });
});
