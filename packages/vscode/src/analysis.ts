import {
  AppNavError,
  getDefaultSchema,
  indexGraph,
  parseGraph,
  validateGraph,
  type Diagnostic,
  type Edge,
  type Graph,
  type JsonValue,
  type NavigationTree,
  type Path,
  type ResolvedSchema,
} from "routegraph";

/**
 * Everything in this file is free of VS Code APIs so it can be unit tested and
 * reused by the scanner and recorder tools later.
 */

export interface AnalysisOptions {
  file?: string;
  schema?: ResolvedSchema;
  strictConditions?: boolean;
}

export interface AnalysisResult {
  /** Present when the text parsed. */
  graph?: Graph;
  /** Present when the text parsed and could be indexed, even with validation errors. */
  tree?: NavigationTree;
  diagnostics: Diagnostic[];
}

const LOCATION_SUFFIX = /\s\((?:[^()]*:)?\d+(?::\d+)?\)$/;

/** Parse and validate graph text. Never throws for problems in the graph itself. */
export function analyze(text: string, options: AnalysisOptions = {}): AnalysisResult {
  let graph: Graph;
  try {
    graph = parseGraph(text, { file: options.file });
  } catch (err) {
    if (err instanceof AppNavError) {
      return {
        diagnostics: [
          {
            severity: "error",
            code: err.code,
            message: err.message.replace(LOCATION_SUFFIX, ""),
            line: err.line,
            column: err.column,
            ids: err.ids,
          },
        ],
      };
    }
    throw err;
  }

  const validation = validateGraph(graph, options.schema, {
    strictConditions: options.strictConditions,
  });

  let tree: NavigationTree | undefined;
  try {
    tree = indexGraph(graph, {
      schema: options.schema,
      strictConditions: options.strictConditions,
      diagnostics: "collect",
    });
  } catch {
    tree = undefined;
  }
  return { graph, tree, diagnostics: validation.diagnostics };
}

export type LineState = "code" | "string" | "comment";

/** What kind of text sits at `column` (0-based) on this line. */
export function lineState(lineText: string, column: number): LineState {
  let inString = false;
  for (let i = 0; i < column && i < lineText.length; i++) {
    const c = lineText[i];
    if (inString) {
      if (c === "\\") i++;
      else if (c === '"') inString = false;
    } else if (c === '"') inString = true;
    else if (c === "#") return "comment";
  }
  return inString ? "string" : "code";
}

/** True when `column` (0-based) sits inside a double quoted string on this line. */
export function insideString(lineText: string, column: number): boolean {
  return lineState(lineText, column) === "string";
}

/** How many `{` or `[` are still open at `offset`, ignoring strings and comments. */
export function bracketDepthAt(text: string, offset: number): number {
  let depth = 0;
  let inString = false;
  let inComment = false;
  for (let i = 0; i < offset && i < text.length; i++) {
    const c = text[i];
    if (inComment) {
      if (c === "\n") inComment = false;
    } else if (inString) {
      if (c === "\\") i++;
      else if (c === '"') inString = false;
    } else if (c === '"') inString = true;
    else if (c === "#") inComment = true;
    else if (c === "{" || c === "[") depth++;
    else if (c === "}" || c === "]") depth = Math.max(0, depth - 1);
  }
  return depth;
}

export interface IdPosition {
  line: number;
  start: number;
  end: number;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Find the 0-based column span of an id on its declaration line, or undefined. */
export function findDeclaredId(lineText: string, keyword: "SCREEN" | "VAR", id: string): { start: number; end: number } | undefined {
  const re = new RegExp(`\\b${keyword}\\s+(${escapeRegExp(id)})(?![A-Za-z0-9_.:])`);
  const m = re.exec(lineText);
  if (!m || m.index === undefined) return undefined;
  const start = m.index + m[0].length - id.length;
  return { start, end: start + id.length };
}

export interface DeclarationIndex {
  screens: Map<string, IdPosition>;
  variables: Map<string, IdPosition>;
}

/** Locate where each screen and variable is declared. Lines are 0-based. */
export function indexDeclarations(graph: Graph, lines: readonly string[]): DeclarationIndex {
  const screens = new Map<string, IdPosition>();
  const variables = new Map<string, IdPosition>();
  for (const s of graph.screens) {
    if (screens.has(s.id)) continue;
    const line = s.line - 1;
    const span = findDeclaredId(lines[line] ?? "", "SCREEN", s.id);
    screens.set(s.id, { line, start: span?.start ?? Math.max(0, s.column - 1), end: span?.end ?? s.column - 1 + s.id.length });
  }
  for (const v of graph.variables) {
    if (variables.has(v.name) || v.line === undefined) continue;
    const line = v.line - 1;
    const span = findDeclaredId(lines[line] ?? "", "VAR", v.name);
    variables.set(v.name, { line, start: span?.start ?? 0, end: span?.end ?? v.name.length });
  }
  return { screens, variables };
}

function jsonShort(value: JsonValue | undefined): string {
  const s = JSON.stringify(value);
  return s.length > 40 ? `${s.slice(0, 37)}...` : s;
}

/** One line summary of what an edge does, for hovers and route listings. */
export function summarizeActions(edge: Edge, max = 3): string {
  if (edge.actions.length === 0) return "no actions";
  const parts = edge.actions.slice(0, max).map((a) => {
    const target = a.data["target"] ?? a.data["until"] ?? a.data["key"] ?? a.data["condition"];
    return target === undefined ? a.type : `${a.type} ${jsonShort(target as JsonValue)}`;
  });
  const more = edge.actions.length > max ? `, +${edge.actions.length - max} more` : "";
  return parts.join(", ") + more;
}

/** Markdown for a screen hover. */
export function describeScreen(tree: NavigationTree, id: string): string | undefined {
  const screen = tree.screens.get(id);
  if (!screen) return undefined;
  const out = tree.outgoing(id);
  const incoming = tree.incoming(id).length;
  const lines = [`**${screen.name}** \`${screen.id}\``];
  lines.push(`${out.length} outgoing, ${incoming} incoming`);
  if (out.length > 0) {
    lines.push("");
    for (const e of out.slice(0, 12)) {
      const extras = [e.cost !== 1 ? `cost ${e.cost}` : "", e.condition ? `if ${e.condition.source}` : ""].filter(Boolean);
      lines.push(`- \`${e.to}\`${extras.length ? ` (${extras.join(", ")})` : ""}: ${summarizeActions(e, 2)}`);
    }
    if (out.length > 12) lines.push(`- ${out.length - 12} more`);
  } else {
    lines.push("", "No way out of this screen. Routes can end here but not continue.");
  }
  return lines.join("\n");
}

/** Markdown for a `$NAME$` hover. */
export function describeVariable(graph: Graph, name: string): string | undefined {
  const v = graph.variables.find((x) => x.name === name);
  if (!v) return undefined;
  const dflt = v.hasDefault ? ` = ${JSON.stringify(v.default)}` : "";
  const note = v.hasDefault ? "" : "\n\nRequired: every route that uses it must supply a value.";
  return `\`VAR ${v.name} : ${v.type}${dflt}\`${note}`;
}

/** Snippet text for an action, built from the schema's required properties. */
export function actionSnippet(name: string, schema: ResolvedSchema): string {
  const def = schema.actions[name];
  const required = def?.required ?? [];
  if (required.length === 0) return `${name} {$0}`;
  let tab = 1;
  const props = required.map((key) => {
    const t = def?.properties?.[key]?.type;
    const type = Array.isArray(t) ? t[0] : t;
    if (type === "number" || type === "integer") return `"${key}": \${${tab++}:0}`;
    if (type === "boolean") return `"${key}": \${${tab++}:false}`;
    if (type === "object") return `"${key}": {\${${tab++}}}`;
    if (type === "array") return `"${key}": [\${${tab++}}]`;
    return `"${key}": "\${${tab++}}"`;
  });
  return `${name} { ${props.join(", ")} }$0`;
}

export function schemaOrDefault(result: AnalysisResult | undefined): ResolvedSchema {
  return result?.tree?.schema ?? getDefaultSchema();
}

export interface PreviewScreen {
  id: string;
  name: string;
  line: number;
}

export interface PreviewEdge {
  id: string;
  from: string;
  to: string;
  cost: number;
  condition?: string;
  label?: string;
  actions: string;
  line?: number;
}

export interface PreviewModel {
  app?: string;
  screens: PreviewScreen[];
  edges: PreviewEdge[];
}

export interface RouteStep {
  n: number;
  edge: string;
  from: string;
  to: string;
  summary: string;
  line?: number;
}

export interface RouteModel {
  from: string;
  to: string;
  cost: number;
  screens: string[];
  edges: string[];
  steps: RouteStep[];
}

/** Build the data the preview webview draws. Lines are 1-based. */
export function toPreviewModel(graph: Graph, tree: NavigationTree): PreviewModel {
  const seen = new Set<string>();
  const screens: PreviewScreen[] = [];
  for (const s of graph.screens) {
    if (seen.has(s.id)) continue;
    seen.add(s.id);
    screens.push({ id: s.id, name: s.name, line: s.line });
  }
  const edges: PreviewEdge[] = tree.edges.map((e) => ({
    id: e.id,
    from: e.from,
    to: e.to,
    cost: e.cost,
    condition: e.condition?.source,
    label: typeof e.meta["label"] === "string" ? (e.meta["label"] as string) : undefined,
    actions: summarizeActions(e),
    line: e.line,
  }));
  return { app: graph.app, screens, edges };
}

export function toRouteModel(path: Path): RouteModel {
  return {
    from: path.from,
    to: path.to,
    cost: path.cost,
    screens: [...path.screens],
    edges: path.edges.map((e) => e.id),
    steps: path.edges.map((e, i) => ({
      n: i + 1,
      edge: e.id,
      from: e.from,
      to: e.to,
      summary: summarizeActions(e),
      line: e.line,
    })),
  };
}

/** Variables with no default. Routes must supply these before instructions can be built. */
export function requiredVariables(tree: NavigationTree): { name: string; type: string }[] {
  return Object.values(tree.variables)
    .filter((v) => !v.hasDefault)
    .map((v) => ({ name: v.name, type: v.type }));
}

/** Defaults declared in the graph, overlaid with user supplied values. */
export function routeVariables(tree: NavigationTree, overrides: Record<string, JsonValue> = {}): Record<string, JsonValue> {
  const out: Record<string, JsonValue> = {};
  for (const v of Object.values(tree.variables)) {
    if (v.hasDefault && v.default !== undefined) out[v.name] = v.default;
  }
  return { ...out, ...overrides };
}

/** Parse text typed into an input box according to a declared variable type. */
export function parseVariableInput(text: string, type: string): JsonValue {
  const t = text.trim();
  switch (type) {
    case "number":
      return Number(t);
    case "boolean":
      return t.toLowerCase() === "true";
    case "null":
      return null;
    case "string":
      return text;
    default:
      try {
        return JSON.parse(t) as JsonValue;
      } catch {
        return text;
      }
  }
}
