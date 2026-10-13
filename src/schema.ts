import { SchemaError } from "./errors";
import { deepEqual, isPlainObject } from "./json";
import { defaultReadFile } from "./files";
import { matchesType, parseTemplate, typeOfValue } from "./variables";
import type { JsonValue, ReadFile, VariableDeclaration } from "./types";

export type PropertyType = "string" | "number" | "integer" | "boolean" | "null" | "object" | "array" | "any";

export interface PropertySchema {
  type?: PropertyType | PropertyType[];
  description?: string;
  enum?: JsonValue[];
  minimum?: number;
  maximum?: number;
  /** For objects. */
  required?: string[];
  properties?: Record<string, PropertySchema>;
  additionalProperties?: boolean | PropertySchema;
  /** For arrays. */
  items?: PropertySchema;
}

export interface ActionDefinition extends PropertySchema {
  description?: string;
}

export interface SchemaDefinition {
  $schema?: string;
  schemaVersion: 1;
  name?: string;
  /** "default", the name of a registered schema, or a file path when using loadSchema(). */
  extends?: string;
  /** Inherited action names this schema intentionally redefines. */
  overrides?: string[];
  /** Inherited action names this schema intentionally removes. */
  remove?: string[];
  actions?: Record<string, ActionDefinition>;
  /** Validation for custom edge attributes such as [label="x"]. */
  edgeMetadata?: Record<string, PropertySchema>;
  /** Validation for SCREEN metadata objects. */
  screenMetadata?: Record<string, PropertySchema>;
}

export interface ResolvedSchema {
  readonly schemaVersion: 1;
  readonly name: string;
  readonly actions: Readonly<Record<string, ActionDefinition>>;
  readonly edgeMetadata: Readonly<Record<string, PropertySchema>>;
  readonly screenMetadata: Readonly<Record<string, PropertySchema>>;
}

const tap: ActionDefinition = {
  description: "Tap a UI element",
  required: ["target"],
  properties: {
    target: { type: "string" },
    waitFor: { type: "string" },
    timeoutMs: { type: "number" },
  },
};

export const DEFAULT_SCHEMA_DEFINITION: SchemaDefinition = {
  schemaVersion: 1,
  name: "default",
  actions: {
    TAP: tap,
    LONG_PRESS: {
      description: "Press and hold a UI element",
      required: ["target"],
      properties: { target: { type: "string" }, durationMs: { type: "number", minimum: 0 } },
    },
    TYPE: {
      description: "Enter text into a UI element",
      required: ["target", "text"],
      properties: {
        target: { type: "string" },
        text: { type: "string" },
        clearFirst: { type: "boolean" },
      },
    },
    SWIPE: {
      description: "Swipe in a direction",
      required: ["direction"],
      properties: {
        direction: { type: "string", enum: ["up", "down", "left", "right"] },
        target: { type: "string" },
        distance: { type: "number", minimum: 0 },
      },
    },
    SCROLL: {
      description: "Scroll a container or until an element is visible",
      properties: {
        target: { type: "string" },
        to: { type: "string" },
        direction: { type: "string", enum: ["up", "down", "left", "right"] },
      },
    },
    BACK: { description: "Go back one screen", properties: {} },
    WAIT: {
      description: "Wait for a condition or a duration",
      properties: { until: { type: "string" }, durationMs: { type: "number", minimum: 0 }, timeoutMs: { type: "number" } },
    },
    SET_STATE: {
      description: "Set an application state value",
      required: ["key", "value"],
      properties: { key: { type: "string" }, value: { type: "any" } },
    },
    ASSERT: {
      description: "Assert that a condition holds",
      required: ["condition"],
      properties: { condition: { type: "string" }, message: { type: "string" } },
    },
  },
};

const registry = new Map<string, ResolvedSchema>();

function validateDefinitionShape(def: unknown): asserts def is SchemaDefinition {
  if (!isPlainObject(def)) throw new SchemaError("A schema must be an object");
  if (def.schemaVersion !== 1) {
    throw new SchemaError(`Unsupported schemaVersion: ${String(def.schemaVersion)}. Expected 1`);
  }
  for (const key of ["actions", "edgeMetadata", "screenMetadata"] as const) {
    const v = def[key];
    if (v !== undefined && !isPlainObject(v)) throw new SchemaError(`Schema "${key}" must be an object`);
  }
  for (const key of ["overrides", "remove"] as const) {
    const v = def[key];
    if (v !== undefined && (!Array.isArray(v) || v.some((x) => typeof x !== "string"))) {
      throw new SchemaError(`Schema "${key}" must be an array of strings`);
    }
  }
  const actions = (def.actions ?? {}) as Record<string, unknown>;
  for (const name of Object.keys(actions)) {
    if (!/^[A-Z][A-Z0-9_]*$/.test(name)) {
      throw new SchemaError(`Invalid action name "${name}". Use UPPER_SNAKE_CASE`, [name]);
    }
    if (!isPlainObject(actions[name])) throw new SchemaError(`Action "${name}" must be an object`, [name]);
  }
}

/** Resolve a schema definition, applying `extends`. Synchronous; `extends` must be "default" or registered. */
export function resolveSchema(def: SchemaDefinition, parent?: ResolvedSchema): ResolvedSchema {
  validateDefinitionShape(def);
  let base: ResolvedSchema | undefined = parent;
  if (!base && def.extends !== undefined) {
    if (def.extends === "default") base = getDefaultSchema();
    else {
      base = registry.get(def.extends);
      if (!base) {
        throw new SchemaError(
          `Cannot resolve "extends": "${def.extends}". Register it with registerSchema() or use loadSchema() for file paths`,
          [def.extends],
        );
      }
    }
  }
  const actions: Record<string, ActionDefinition> = { ...(base?.actions ?? {}) };
  const overrides = new Set(def.overrides ?? []);
  for (const name of def.remove ?? []) {
    if (!(name in actions)) throw new SchemaError(`Cannot remove "${name}": it is not inherited`, [name]);
    delete actions[name];
  }
  for (const [name, action] of Object.entries(def.actions ?? {})) {
    const inherited = actions[name];
    if (inherited && !deepEqual(inherited, action) && !overrides.has(name)) {
      throw new SchemaError(
        `Action "${name}" is already defined by the parent schema. List it in "overrides" to replace it`,
        [name],
      );
    }
    if (!inherited && overrides.has(name)) {
      throw new SchemaError(`"${name}" is listed in "overrides" but is not inherited`, [name]);
    }
    actions[name] = action;
  }
  return {
    schemaVersion: 1,
    name: def.name ?? "custom",
    actions,
    edgeMetadata: { ...(base?.edgeMetadata ?? {}), ...(def.edgeMetadata ?? {}) },
    screenMetadata: { ...(base?.screenMetadata ?? {}), ...(def.screenMetadata ?? {}) },
  };
}

let defaultResolved: ResolvedSchema | undefined;
export function getDefaultSchema(): ResolvedSchema {
  defaultResolved ??= resolveSchema(DEFAULT_SCHEMA_DEFINITION, {
    schemaVersion: 1,
    name: "default",
    actions: {},
    edgeMetadata: {},
    screenMetadata: {},
  });
  return defaultResolved;
}

/** Register a named schema so other schemas can `extends` it. */
export function registerSchema(name: string, schema: SchemaDefinition | ResolvedSchema): ResolvedSchema {
  if (name === "default") throw new SchemaError('The name "default" is reserved');
  const resolved = "actions" in schema && isResolved(schema) ? schema : resolveSchema(schema as SchemaDefinition);
  registry.set(name, resolved);
  return resolved;
}

function isResolved(s: SchemaDefinition | ResolvedSchema): s is ResolvedSchema {
  return (s as ResolvedSchema).name !== undefined && (s as ResolvedSchema).actions !== undefined && (s as ResolvedSchema).edgeMetadata !== undefined && (s as ResolvedSchema).screenMetadata !== undefined;
}

export function unregisterSchema(name: string): boolean {
  return registry.delete(name);
}

export interface LoadSchemaOptions {
  readFile?: ReadFile;
}

const looksLikePath = (s: string) => /[\\/]/.test(s) || /\.(navschema|json)$/i.test(s);

/**
 * Load a schema. Accepts nothing (the default schema), a definition object, an
 * already resolved schema, or a file path (JSON). File based `extends` chains work.
 */
export async function loadSchema(
  input?: string | SchemaDefinition | ResolvedSchema,
  options: LoadSchemaOptions = {},
): Promise<ResolvedSchema> {
  if (input === undefined) return getDefaultSchema();
  const read = options.readFile ?? defaultReadFile;
  const load = async (source: string | SchemaDefinition, depth: number): Promise<ResolvedSchema> => {
    if (depth > 16) throw new SchemaError("Schema inheritance is nested too deeply or circular");
    let def: unknown = source;
    if (typeof source === "string") {
      const text = await read(source);
      try {
        def = JSON.parse(text);
      } catch (e) {
        throw new SchemaError(`Schema file "${source}" is not valid JSON: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    validateDefinitionShape(def);
    if (def.extends !== undefined && def.extends !== "default" && !registry.has(def.extends) && looksLikePath(def.extends)) {
      return resolveSchema(def, await load(def.extends, depth + 1));
    }
    return resolveSchema(def);
  };
  if (typeof input !== "string" && isResolved(input)) return input;
  return load(input as string | SchemaDefinition, 0);
}

/** Coerce a user supplied schema option (object or resolved) synchronously. */
export function toResolvedSchema(input?: SchemaDefinition | ResolvedSchema): ResolvedSchema {
  if (!input) return getDefaultSchema();
  return isResolved(input) ? input : resolveSchema(input);
}

// ---------------------------------------------------------------------------
// Payload validation

export interface ValidationContext {
  declarations?: Readonly<Record<string, VariableDeclaration>>;
}

const typeMatches = (v: unknown, t: PropertyType): boolean => {
  switch (t) {
    case "any":
      return v !== undefined;
    case "integer":
      return typeof v === "number" && Number.isInteger(v);
    case "number":
    case "string":
    case "boolean":
    case "null":
    case "object":
    case "array":
      return matchesType(v, t);
  }
};

/**
 * Validate a JSON value against a PropertySchema. Strings that are exactly one
 * `$VAR$` reference are checked against the variable's declared type instead of
 * the string value. Returns a list of human readable problems.
 */
export function validateAgainst(
  value: unknown,
  schema: PropertySchema,
  path: string,
  ctx: ValidationContext = {},
): string[] {
  const problems: string[] = [];
  let effective = value;
  let skipType = false;
  if (typeof value === "string") {
    const segs = parseTemplate(value);
    const only = segs.length === 1 && segs[0]?.kind === "var" ? segs[0] : undefined;
    if (only && ctx.declarations) {
      const decl = ctx.declarations[only.name];
      if (decl) {
        // Check the declared type rather than the placeholder text.
        const types = schema.type === undefined ? [] : Array.isArray(schema.type) ? schema.type : [schema.type];
        const ok =
          types.length === 0 ||
          types.includes("any") ||
          decl.type === "any" ||
          types.some((t) => t === decl.type || (t === "integer" && decl.type === "number"));
        if (!ok) problems.push(`${path}: variable "${only.name}" is ${decl.type}, expected ${types.join(" or ")}`);
        return problems;
      }
      return problems; // unknown variables are reported elsewhere
    }
    if (only) skipType = true;
  }
  if (!skipType && schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((t) => typeMatches(effective, t))) {
      problems.push(`${path}: expected ${types.join(" or ")}, got ${typeOfValue(effective)}`);
      return problems;
    }
  }
  if (!skipType && schema.enum && !schema.enum.some((e) => deepEqual(e, effective))) {
    problems.push(`${path}: must be one of ${schema.enum.map((e) => JSON.stringify(e)).join(", ")}`);
  }
  if (!skipType && typeof effective === "number") {
    if (schema.minimum !== undefined && effective < schema.minimum) problems.push(`${path}: must be >= ${schema.minimum}`);
    if (schema.maximum !== undefined && effective > schema.maximum) problems.push(`${path}: must be <= ${schema.maximum}`);
  }
  if (isPlainObject(effective)) {
    const obj = effective;
    for (const key of schema.required ?? []) {
      if (!(key in obj)) problems.push(`${path}: missing required property "${key}"`);
    }
    for (const key of Object.keys(obj)) {
      const sub = schema.properties?.[key];
      if (sub) problems.push(...validateAgainst(obj[key], sub, `${path}.${key}`, ctx));
      else if (schema.additionalProperties === false) problems.push(`${path}: unknown property "${key}"`);
      else if (isPlainObject(schema.additionalProperties) || (schema.additionalProperties && typeof schema.additionalProperties === "object")) {
        problems.push(...validateAgainst(obj[key], schema.additionalProperties as PropertySchema, `${path}.${key}`, ctx));
      }
    }
  } else if (Array.isArray(effective) && schema.items) {
    effective.forEach((item, i) => problems.push(...validateAgainst(item, schema.items as PropertySchema, `${path}[${i}]`, ctx)));
  }
  return problems;
}
