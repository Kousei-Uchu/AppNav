import * as vscode from "vscode";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
  VariableError,
  buildInstructionsSync,
  getDefaultSchema,
  loadSchema,
  tryCalculatePath,
  type Diagnostic,
  type JsonValue,
  type Path,
  type ResolvedSchema,
} from "routegraph";
import {
  actionSnippet,
  analyze,
  bracketDepthAt,
  describeScreen,
  describeVariable,
  indexDeclarations,
  lineState,
  parseVariableInput,
  requiredVariables,
  routeVariables,
  schemaOrDefault,
  toPreviewModel,
  toRouteModel,
  type AnalysisResult,
  type DeclarationIndex,
  type PreviewModel,
  type RouteModel,
} from "./analysis";
import { PreviewPanel, type PreviewHandlers } from "./preview";

const LANGUAGE = "navgraph";
const EMPTY_MODEL: PreviewModel = { screens: [], edges: [] };

interface DocState {
  version: number;
  result: AnalysisResult;
  lines: string[];
  decl?: DeclarationIndex;
  /** Last model built from a file that parsed. Kept so the preview survives typos. */
  model?: PreviewModel;
}

const states = new Map<string, DocState>();
const timers = new Map<string, ReturnType<typeof setTimeout>>();
let diagnostics: vscode.DiagnosticCollection;
let output: vscode.OutputChannel;
let extensionUri: vscode.Uri;
let lastRoute: { uri: string; path: Path } | undefined;

const isNavgraph = (doc: vscode.TextDocument) => doc.languageId === LANGUAGE;

/* ---------- schema discovery ---------- */

async function exists(file: string): Promise<boolean> {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}

async function schemaFor(doc: vscode.TextDocument): Promise<{ schema?: ResolvedSchema; problem?: string }> {
  if (doc.uri.scheme !== "file") return {};
  const explicit = vscode.workspace.getConfiguration("routegraph", doc.uri).get<string>("schema", "").trim();
  let file: string | undefined;
  if (explicit) {
    const folder = vscode.workspace.getWorkspaceFolder(doc.uri)?.uri.fsPath ?? path.dirname(doc.uri.fsPath);
    file = path.isAbsolute(explicit) ? explicit : path.join(folder, explicit);
  } else {
    const sibling = doc.uri.fsPath.replace(/\.navgraph$/i, ".navschema");
    if (sibling !== doc.uri.fsPath && (await exists(sibling))) file = sibling;
  }
  if (!file) return {};
  try {
    return { schema: await loadSchema(file) };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { problem: `Could not load schema ${path.basename(file)}: ${message}` };
  }
}

/* ---------- analysis and diagnostics ---------- */

function toVsDiagnostic(doc: vscode.TextDocument, d: Diagnostic, lines: string[]): vscode.Diagnostic {
  const line = Math.max(0, (d.line ?? 1) - 1);
  const text = lines[line] ?? "";
  let start = Math.max(0, (d.column ?? 1) - 1);
  let end: number;

  const target = d.code === "UNKNOWN_SCREEN" ? d.ids?.[1] : undefined;
  const found = target ? new RegExp(`(?<![A-Za-z0-9_.:])${target.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![A-Za-z0-9_.:])`).exec(text) : null;
  if (found) {
    start = found.index;
    end = start + target!.length;
  } else {
    const token = /^[^\s{}[\],]+/.exec(text.slice(start));
    end = token ? start + token[0].length : Math.max(start + 1, text.length);
  }
  const range = doc.validateRange(new vscode.Range(line, start, line, Math.max(end, start + 1)));
  const out = new vscode.Diagnostic(
    range,
    d.message,
    d.severity === "error" ? vscode.DiagnosticSeverity.Error : vscode.DiagnosticSeverity.Warning,
  );
  out.source = "routegraph";
  out.code = d.code;
  return out;
}

async function refresh(doc: vscode.TextDocument): Promise<void> {
  if (!isNavgraph(doc)) return;
  const key = doc.uri.toString();
  const version = doc.version;
  const text = doc.getText();
  const { schema, problem } = await schemaFor(doc);
  const cfg = vscode.workspace.getConfiguration("routegraph", doc.uri);

  const result = analyze(text, {
    file: doc.uri.scheme === "file" ? doc.uri.fsPath : undefined,
    schema,
    strictConditions: cfg.get<boolean>("strictConditions", false),
  });
  if (doc.version !== version) return;

  const lines = text.split(/\r?\n/);
  const previous = states.get(key);
  const model = result.graph && result.tree ? toPreviewModel(result.graph, result.tree) : previous?.model;
  states.set(key, {
    version,
    result,
    lines,
    decl: result.graph ? indexDeclarations(result.graph, lines) : previous?.decl,
    model,
  });

  const list = result.diagnostics.map((d) => toVsDiagnostic(doc, d, lines));
  if (problem) {
    list.unshift(
      Object.assign(new vscode.Diagnostic(new vscode.Range(0, 0, 0, 1), problem, vscode.DiagnosticSeverity.Warning), {
        source: "routegraph",
        code: "SCHEMA_LOAD",
      }),
    );
  }
  diagnostics.set(doc.uri, list);
  pushPreview(doc);
}

function schedule(doc: vscode.TextDocument): void {
  const key = doc.uri.toString();
  clearTimeout(timers.get(key));
  timers.set(
    key,
    setTimeout(() => void refresh(doc), 250),
  );
}

function refreshAllOpen(): void {
  for (const doc of vscode.workspace.textDocuments) if (isNavgraph(doc)) void refresh(doc);
}

/* ---------- preview ---------- */

function pushPreview(doc: vscode.TextDocument): void {
  const panel = PreviewPanel.current;
  if (!panel || panel.uri.toString() !== doc.uri.toString()) return;
  const st = states.get(doc.uri.toString());
  if (!st) return;
  const errors = st.result.diagnostics.filter((d) => d.severity === "error");
  let notice: string | undefined;
  if (!st.result.graph) {
    const d = errors[0];
    notice = d ? `Showing the last valid version. Line ${d.line ?? "?"}: ${d.message}` : "Showing the last valid version.";
  } else if (errors.length > 0) {
    notice = `${errors.length} ${errors.length === 1 ? "problem" : "problems"} in this file, see the Problems panel. Some edges may be missing.`;
  }
  panel.update(st.model ?? EMPTY_MODEL, notice);
}

async function docFor(uri: vscode.Uri): Promise<vscode.TextDocument> {
  return (
    vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri.toString()) ??
    (await vscode.workspace.openTextDocument(uri))
  );
}

const previewHandlers: PreviewHandlers = {
  async reveal(uri, line) {
    const doc = await docFor(uri);
    const visible = vscode.window.visibleTextEditors.find((e) => e.document === doc);
    const editor = await vscode.window.showTextDocument(doc, {
      viewColumn: visible?.viewColumn ?? vscode.ViewColumn.One,
      preserveFocus: false,
    });
    const pos = new vscode.Position(Math.max(0, line - 1), 0);
    editor.selection = new vscode.Selection(pos, pos);
    editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenterIfOutsideViewport);
  },
  async findRoute(uri, from, to) {
    const doc = await docFor(uri);
    const res = await computeRoute(doc, from, to);
    const panel = PreviewPanel.current;
    if (!panel) return;
    if (res.ok) {
      lastRoute = { uri: uri.toString(), path: res.path };
      writeRoute(res.route);
      panel.showRoute(res.route);
    } else {
      panel.routeError(res.message);
    }
  },
  disposed() {
    /* nothing to release */
  },
};

function openPreview(doc: vscode.TextDocument): PreviewPanel {
  const panel = PreviewPanel.show(extensionUri, doc.uri, previewHandlers);
  panel.setDocument(doc.uri);
  if (!states.has(doc.uri.toString())) void refresh(doc);
  else pushPreview(doc);
  return panel;
}

/* ---------- routes ---------- */

type RouteOutcome = { ok: true; route: RouteModel; path: Path } | { ok: false; message: string };

async function computeRoute(doc: vscode.TextDocument, from: string, to: string): Promise<RouteOutcome> {
  const timer = timers.get(doc.uri.toString());
  if (timer) clearTimeout(timer);
  await refresh(doc);
  const tree = states.get(doc.uri.toString())?.result.tree;
  if (!tree) return { ok: false, message: "Fix the syntax error in this file before finding a route." };

  const cfg = vscode.workspace.getConfiguration("routegraph", doc.uri);
  const overrides = cfg.get<Record<string, JsonValue>>("routeVariables", {});
  try {
    const res = tryCalculatePath(tree, from, to, cfg.get<string>("algorithm", "astar"), {
      variables: routeVariables(tree, overrides),
    });
    if (res.ok) return { ok: true, route: toRouteModel(res.path), path: res.path };
    const hint = tree.edges.some((e) => e.condition)
      ? " Edges with an if= condition only count when it is true. Set values in the routegraph.routeVariables setting."
      : "";
    return { ok: false, message: `${res.error.message}.${hint}` };
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  }
}

function writeRoute(route: RouteModel): void {
  output.clear();
  output.appendLine(`Route from ${route.from} to ${route.to}`);
  output.appendLine(
    route.steps.length === 0 ? "Already there." : `${route.steps.length} ${route.steps.length === 1 ? "step" : "steps"}, cost ${route.cost}`,
  );
  output.appendLine("");
  for (const st of route.steps) output.appendLine(`${st.n}. ${st.from} -> ${st.to}   ${st.summary}`);
}

function activeNavgraph(): vscode.TextDocument | undefined {
  const editor = vscode.window.activeTextEditor;
  if (editor && isNavgraph(editor.document)) return editor.document;
  const panel = PreviewPanel.current;
  if (panel) return vscode.workspace.textDocuments.find((d) => d.uri.toString() === panel.uri.toString());
  return vscode.workspace.textDocuments.find(isNavgraph);
}

async function cmdFindRoute(): Promise<RouteOutcome | undefined> {
  const doc = activeNavgraph();
  if (!doc) {
    void vscode.window.showInformationMessage("Open a .navgraph file to find a route.");
    return undefined;
  }
  await refresh(doc);
  const tree = states.get(doc.uri.toString())?.result.tree;
  if (!tree) {
    void vscode.window.showErrorMessage("Fix the syntax error in this file before finding a route.");
    return undefined;
  }
  const items = [...tree.screens.values()].map((s) => ({ label: s.name, description: s.id }));
  const from = await vscode.window.showQuickPick(items, {
    title: "Route start",
    placeHolder: "Where does the route begin?",
    matchOnDescription: true,
  });
  if (!from) return undefined;
  const to = await vscode.window.showQuickPick(
    items.filter((i) => i.description !== from.description),
    { title: "Route end", placeHolder: `Route from ${from.label}: where does it end?`, matchOnDescription: true },
  );
  if (!to) return undefined;

  const res = await computeRoute(doc, from.description, to.description);
  if (!res.ok) {
    void vscode.window.showWarningMessage(res.message);
    return res;
  }
  lastRoute = { uri: doc.uri.toString(), path: res.path };
  writeRoute(res.route);
  PreviewPanel.current?.showRoute(res.route);
  const choice = await vscode.window.showInformationMessage(
    `${res.route.steps.length} ${res.route.steps.length === 1 ? "step" : "steps"} from ${from.label} to ${to.label}, cost ${res.route.cost}.`,
    "Show in Preview",
    "Copy Instructions",
    "Show Steps",
  );
  if (choice === "Show in Preview") openPreview(doc).showRoute(res.route);
  else if (choice === "Copy Instructions") await copyInstructions();
  else if (choice === "Show Steps") output.show(true);
  return res;
}

async function copyInstructions(): Promise<void> {
  if (!lastRoute) {
    const res = await cmdFindRoute();
    if (!res?.ok || !lastRoute) return;
  }
  const route = lastRoute;
  if (!route) return;
  const { path: routePath } = route;
  const tree = routePath.tree;
  const supplied: Record<string, JsonValue> = {};
  const missing = requiredVariables(tree).filter((v) => !(v.name in routePath.variables));

  for (let attempt = 0; attempt <= missing.length; attempt++) {
    try {
      const instructions = buildInstructionsSync(routePath, { variables: { ...routePath.variables, ...supplied } });
      await vscode.env.clipboard.writeText(JSON.stringify(instructions, null, 2));
      void vscode.window.showInformationMessage(
        `Copied instructions for ${instructions.steps.length} ${instructions.steps.length === 1 ? "step" : "steps"} to the clipboard.`,
      );
      return;
    } catch (err) {
      if (!(err instanceof VariableError)) {
        void vscode.window.showErrorMessage(err instanceof Error ? err.message : String(err));
        return;
      }
      const next = missing.find((v) => !(v.name in supplied) && err.message.includes(v.name));
      if (!next) {
        void vscode.window.showErrorMessage(err.message);
        return;
      }
      const value = await vscode.window.showInputBox({
        title: `Value for ${next.name}`,
        prompt: `${next.name} is a ${next.type} with no default. The route needs a value to build instructions.`,
        ignoreFocusOut: true,
      });
      if (value === undefined) return;
      supplied[next.name] = parseVariableInput(value, next.type);
    }
  }
}

/* ---------- language features ---------- */

const ID_WORD = /[A-Za-z_][A-Za-z0-9_.:]*/;
const TEMPLATE_WORD = /\$\$?[A-Za-z_][A-Za-z0-9_]*\$\$?/;

function stateFor(doc: vscode.TextDocument): DocState | undefined {
  return states.get(doc.uri.toString());
}

/** The screen or variable name under the cursor, with the range to underline. */
function symbolAt(doc: vscode.TextDocument, pos: vscode.Position): { kind: "screen" | "variable"; name: string; range: vscode.Range } | undefined {
  const st = stateFor(doc);
  if (!st) return undefined;
  const text = doc.lineAt(pos.line).text;
  const where = lineState(text, pos.character);
  if (where === "comment") return undefined;

  if (where === "string") {
    const range = doc.getWordRangeAtPosition(pos, TEMPLATE_WORD);
    if (!range) return undefined;
    const word = doc.getText(range);
    if (word.startsWith("$$")) return undefined;
    return { kind: "variable", name: word.slice(1, -1), range };
  }
  const range = doc.getWordRangeAtPosition(pos, ID_WORD);
  if (!range) return undefined;
  const word = doc.getText(range);
  if (st.result.tree?.hasScreen(word)) return { kind: "screen", name: word, range };
  if (st.result.graph?.variables.some((v) => v.name === word)) return { kind: "variable", name: word, range };
  return undefined;
}

const hoverProvider: vscode.HoverProvider = {
  provideHover(doc, pos) {
    const sym = symbolAt(doc, pos);
    const st = stateFor(doc);
    if (!sym || !st) return undefined;
    const md =
      sym.kind === "screen"
        ? st.result.tree && describeScreen(st.result.tree, sym.name)
        : st.result.graph && describeVariable(st.result.graph, sym.name);
    return md ? new vscode.Hover(new vscode.MarkdownString(md), sym.range) : undefined;
  },
};

const definitionProvider: vscode.DefinitionProvider = {
  provideDefinition(doc, pos) {
    const sym = symbolAt(doc, pos);
    const decl = stateFor(doc)?.decl;
    if (!sym || !decl) return undefined;
    const at = (sym.kind === "screen" ? decl.screens : decl.variables).get(sym.name);
    return at ? new vscode.Location(doc.uri, new vscode.Range(at.line, at.start, at.line, at.end)) : undefined;
  },
};

const symbolProvider: vscode.DocumentSymbolProvider = {
  provideDocumentSymbols(doc) {
    const st = stateFor(doc);
    const graph = st?.result.graph;
    if (!st || !graph) return [];
    const lineRange = (line: number) => doc.lineAt(Math.min(Math.max(line, 0), doc.lineCount - 1)).range;
    const group = (name: string, kind: vscode.SymbolKind, children: vscode.DocumentSymbol[]) => {
      if (children.length === 0) return [];
      const first = children[0]!.range.start;
      const last = children[children.length - 1]!.range.end;
      const sym = new vscode.DocumentSymbol(name, `${children.length}`, kind, new vscode.Range(first, last), new vscode.Range(first, first));
      sym.children = children;
      return [sym];
    };

    const vars = graph.variables
      .filter((v) => v.line !== undefined)
      .map((v) => new vscode.DocumentSymbol(v.name, v.type, vscode.SymbolKind.Variable, lineRange(v.line! - 1), lineRange(v.line! - 1)));
    const screens = graph.screens.map(
      (s) => new vscode.DocumentSymbol(s.id, s.name, vscode.SymbolKind.Class, lineRange(s.line - 1), lineRange(s.line - 1)),
    );
    const edges = graph.edges.map(
      (e) => new vscode.DocumentSymbol(`${e.from} -> ${e.to}`, e.id ?? "", vscode.SymbolKind.Event, lineRange(e.line - 1), lineRange(e.line - 1)),
    );
    return [
      ...group("Variables", vscode.SymbolKind.Namespace, vars),
      ...group("Screens", vscode.SymbolKind.Namespace, screens),
      ...group("Edges", vscode.SymbolKind.Namespace, edges),
    ];
  },
};

const completionProvider: vscode.CompletionItemProvider = {
  provideCompletionItems(doc, pos) {
    const st = stateFor(doc);
    const line = doc.lineAt(pos.line).text;
    const prefix = line.slice(0, pos.character);
    const where = lineState(prefix, prefix.length);
    if (where === "comment") return undefined;
    const items: vscode.CompletionItem[] = [];
    const replace = (partial: string) => new vscode.Range(pos.line, pos.character - partial.length, pos.line, pos.character);

    if (where === "string") {
      const m = /(?<!\$)\$([A-Za-z_][A-Za-z0-9_]*)?$/.exec(prefix);
      if (!m || !st?.result.graph) return undefined;
      for (const v of st.result.graph.variables) {
        const item = new vscode.CompletionItem(`$${v.name}$`, vscode.CompletionItemKind.Variable);
        item.detail = v.type;
        item.insertText = `${v.name}$`;
        item.filterText = v.name;
        item.range = replace(m[1] ?? "");
        items.push(item);
      }
      return items;
    }

    const doMatch = /\bDO\s+([A-Za-z_][A-Za-z0-9_]*)?$/.exec(prefix);
    if (doMatch) {
      const schema = schemaOrDefault(st?.result) ?? getDefaultSchema();
      for (const [name, def] of Object.entries(schema.actions)) {
        const item = new vscode.CompletionItem(name, vscode.CompletionItemKind.Function);
        item.detail = def.description;
        item.insertText = new vscode.SnippetString(actionSnippet(name, schema));
        item.range = replace(doMatch[1] ?? "");
        items.push(item);
      }
      return items;
    }

    const typeMatch = /\bVAR\s+[A-Za-z_][A-Za-z0-9_]*\s*:\s*([A-Za-z]*)$/.exec(prefix);
    if (typeMatch) {
      for (const t of ["string", "number", "boolean", "null", "object", "array", "any"]) {
        const item = new vscode.CompletionItem(t, vscode.CompletionItemKind.TypeParameter);
        item.range = replace(typeMatch[1] ?? "");
        items.push(item);
      }
      return items;
    }

    const arrow = /->\s*([A-Za-z_][A-Za-z0-9_.:]*)?$/.exec(prefix);
    const screenItems = (partial: string) =>
      [...(st?.result.tree?.screens.values() ?? [])].map((s) => {
        const item = new vscode.CompletionItem(s.id, vscode.CompletionItemKind.Class);
        item.detail = s.name;
        item.range = replace(partial);
        return item;
      });
    if (arrow) return screenItems(arrow[1] ?? "");

    const start = /^\s*([A-Za-z_][A-Za-z0-9_.:]*)?$/.exec(prefix);
    if (start) {
      const partial = start[1] ?? "";
      const depth = bracketDepthAt(doc.getText(), doc.offsetAt(pos) - partial.length);
      const snippet = (label: string, text: string, detail: string) => {
        const item = new vscode.CompletionItem(label, vscode.CompletionItemKind.Keyword);
        item.insertText = new vscode.SnippetString(text);
        item.detail = detail;
        item.range = replace(partial);
        return item;
      };
      if (depth > 0) {
        items.push(snippet("DO", 'DO ${1|TAP,BACK,WAIT,TYPE,SWIPE,SCROLL,LONG_PRESS,SET_STATE,ASSERT|} {$2}', "Add an action"));
        return items;
      }
      items.push(
        snippet("SCREEN", 'SCREEN ${1:id} "${2:Name}"', "Declare a screen"),
        snippet("VAR", "VAR ${1:NAME} : ${2|string,number,boolean,null,object,array,any|}", "Declare a variable"),
        snippet("APP", 'APP "${1:Name}"', "Name the app"),
        snippet("END", "END", "End of the graph"),
        snippet("edge", '${1:from} -> ${2:to} {\n\tDO TAP { "target": "${3}" }\n}', "Add a transition"),
        ...screenItems(partial),
      );
      return items;
    }
    return undefined;
  },
};

/* ---------- activation ---------- */

export function activate(context: vscode.ExtensionContext): void {
  extensionUri = context.extensionUri;
  diagnostics = vscode.languages.createDiagnosticCollection("routegraph");
  output = vscode.window.createOutputChannel("RouteGraph");
  const selector: vscode.DocumentSelector = { language: LANGUAGE };

  context.subscriptions.push(
    diagnostics,
    output,
    vscode.languages.registerHoverProvider(selector, hoverProvider),
    vscode.languages.registerDefinitionProvider(selector, definitionProvider),
    vscode.languages.registerDocumentSymbolProvider(selector, symbolProvider),
    vscode.languages.registerCompletionItemProvider(selector, completionProvider, "$", ">", " "),

    vscode.commands.registerCommand("routegraph.showPreview", () => {
      const doc = activeNavgraph();
      if (!doc) {
        void vscode.window.showInformationMessage("Open a .navgraph file to see its graph.");
        return;
      }
      openPreview(doc);
    }),
    vscode.commands.registerCommand("routegraph.findRoute", () => cmdFindRoute()),
    vscode.commands.registerCommand("routegraph.copyInstructions", () => copyInstructions()),

    vscode.workspace.onDidOpenTextDocument((doc) => void refresh(doc)),
    vscode.workspace.onDidSaveTextDocument((doc) => void refresh(doc)),
    vscode.workspace.onDidChangeTextDocument((e) => {
      if (!isNavgraph(e.document)) return;
      if (vscode.workspace.getConfiguration("routegraph", e.document.uri).get<boolean>("validateOnType", true)) {
        schedule(e.document);
      }
    }),
    vscode.workspace.onDidCloseTextDocument((doc) => {
      const key = doc.uri.toString();
      clearTimeout(timers.get(key));
      timers.delete(key);
      states.delete(key);
      diagnostics.delete(doc.uri);
    }),
    vscode.window.onDidChangeActiveTextEditor((editor) => {
      const panel = PreviewPanel.current;
      if (!panel || !editor || !isNavgraph(editor.document)) return;
      if (panel.uri.toString() === editor.document.uri.toString()) return;
      panel.setDocument(editor.document.uri);
      panel.showRoute(null);
      pushPreview(editor.document);
    }),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("routegraph")) refreshAllOpen();
    }),
  );

  const watcher = vscode.workspace.createFileSystemWatcher("**/*.navschema");
  watcher.onDidChange(refreshAllOpen);
  watcher.onDidCreate(refreshAllOpen);
  watcher.onDidDelete(refreshAllOpen);
  context.subscriptions.push(watcher);

  refreshAllOpen();
}

export function deactivate(): void {
  for (const t of timers.values()) clearTimeout(t);
  timers.clear();
  states.clear();
}
