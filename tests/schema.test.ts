import { afterEach, describe, expect, it } from "vitest";
import {
  SchemaError,
  getDefaultSchema,
  loadSchema,
  registerSchema,
  resolveSchema,
  unregisterSchema,
  validateAgainst,
} from "../src";
import { examplePath } from "./helpers";

describe("schemas", () => {
  afterEach(() => unregisterSchema("base"));

  it("ships a default schema", () => {
    expect(Object.keys(getDefaultSchema().actions)).toContain("TAP");
  });

  it("extends the default with new actions", () => {
    const s = resolveSchema({
      schemaVersion: 1,
      extends: "default",
      actions: { SCAN_QR: { required: ["camera"], properties: { camera: { type: "string" } } } },
    });
    expect(s.actions.SCAN_QR).toBeDefined();
    expect(s.actions.TAP).toBeDefined();
  });

  it("accepts an identical redefinition but rejects silent overrides", () => {
    const tap = getDefaultSchema().actions.TAP!;
    expect(() => resolveSchema({ schemaVersion: 1, extends: "default", actions: { TAP: tap } })).not.toThrow();
    expect(() =>
      resolveSchema({ schemaVersion: 1, extends: "default", actions: { TAP: { required: ["x"] } } }),
    ).toThrow(SchemaError);
    const ok = resolveSchema({ schemaVersion: 1, extends: "default", overrides: ["TAP"], actions: { TAP: { required: ["x"] } } });
    expect(ok.actions.TAP?.required).toEqual(["x"]);
  });

  it("supports explicit removal and rejects bogus removal or overrides", () => {
    expect(resolveSchema({ schemaVersion: 1, extends: "default", remove: ["SWIPE"] }).actions.SWIPE).toBeUndefined();
    expect(() => resolveSchema({ schemaVersion: 1, extends: "default", remove: ["NOPE"] })).toThrow(SchemaError);
    expect(() => resolveSchema({ schemaVersion: 1, overrides: ["TAP"], actions: { TAP: {} } })).toThrow(SchemaError);
  });

  it("rejects malformed schemas", () => {
    expect(() => resolveSchema({ schemaVersion: 2 } as never)).toThrow(/schemaVersion/);
    expect(() => resolveSchema({ schemaVersion: 1, actions: { lower: {} } })).toThrow(/UPPER_SNAKE_CASE/);
    expect(() => resolveSchema({ schemaVersion: 1, extends: "nowhere" })).toThrow(/Cannot resolve/);
  });

  it("resolves registered parents", () => {
    registerSchema("base", { schemaVersion: 1, extends: "default", actions: { A: {} } });
    const s = resolveSchema({ schemaVersion: 1, extends: "base", actions: { B: {} } });
    expect(Object.keys(s.actions)).toEqual(expect.arrayContaining(["TAP", "A", "B"]));
  });

  it("loads schema files, including the one in the spec", async () => {
    const s = await loadSchema(examplePath("app.navschema"));
    expect(s.actions.SCAN_QR).toBeDefined();
    expect(s.edgeMetadata.label).toBeDefined();
  });

  it("validates payloads", () => {
    const schema = { type: "object" as const, required: ["a"], properties: { a: { type: "integer" as const, minimum: 1 }, m: { enum: ["x"] } }, additionalProperties: false };
    expect(validateAgainst({ a: 2, m: "x" }, schema, "p")).toEqual([]);
    expect(validateAgainst({ a: 1.5 }, schema, "p")[0]).toMatch(/expected integer/);
    expect(validateAgainst({ a: 0 }, schema, "p")[0]).toMatch(/>= 1/);
    expect(validateAgainst({}, schema, "p")[0]).toMatch(/missing required/);
    expect(validateAgainst({ a: 1, z: 1 }, schema, "p")[0]).toMatch(/unknown property/);
    expect(validateAgainst({ a: 1, m: "y" }, schema, "p")[0]).toMatch(/one of/);
  });
});
