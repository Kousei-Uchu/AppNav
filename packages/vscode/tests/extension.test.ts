import { beforeAll, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => {
  const registry: {
    hover?: any;
    definition?: any;
    symbols?: any;
    completion?: any;
    commands: Record<string, () => unknown>;
    diagnostics: Map<string, any[]>;
    docs: any[];
  } = { commands: {}, diagnostics: new Map(), docs: [] };
  return { registry };
});

vi.mock("vscode", () => {
  class Position {
    constructor(public line: number, public character: number) {}
  }
  class Range {
    start: Position;
    end: Position;
    constructor(a: any, b: any, c?: any, d?: any) {
      if (typeof a === "number") {
        this.start = new Position(a, b);
        this.end = new Position(c, d);
      } else {
        this.start = a;
        this.end = b;
      }
    }
  }
  class MarkdownString {
    constructor(public value: string) {}
  }
  class SnippetString {
    constructor(public value: string) {}
  }
  const noop = () => ({ dispose() {} });
  return {
    Position,
    Range,
    Selection: class extends Range {},
    Location: class {
      constructor(public uri: unknown, public range: unknown) {}
    },
    Hover: class {
      constructor(public contents: MarkdownString, public range: Range) {}
    },
    MarkdownString,
    SnippetString,
    Diagnostic: class {
      source?: string;
      code?: string;
      constructor(public range: Range, public message: string, public severity: number) {}
    },
    DiagnosticSeverity: { Error: 0, Warning: 1 },
    SymbolKind: { Namespace: 2, Class: 4, Variable: 12, Event: 23 },
    DocumentSymbol: class {
      children: unknown[] = [];
      constructor(public name: string, public detail: string, public kind: number, public range: Range, public selectionRange: Range) {}
    },
    CompletionItem: class {
      detail?: string;
      insertText?: unknown;
      filterText?: string;
      range?: Range;
      constructor(public label: string, public kind: number) {}
    },
    CompletionItemKind: { Variable: 5, Function: 2, Class: 6, Keyword: 13, TypeParameter: 24 },
    ViewColumn: { One: 1, Beside: -2 },
    TextEditorRevealType: { InCenterIfOutsideViewport: 2 },
    Uri: { joinPath: (base: unknown, ...p: string[]) => ({ base, p }) },
    languages: {
      createDiagnosticCollection: () => ({
        set: (uri: any, list: any[]) => h.registry.diagnostics.set(uri.toString(), list),
        delete: (uri: any) => h.registry.diagnostics.delete(uri.toString()),
        dispose() {},
      }),
      registerHoverProvider: (_s: unknown, p: unknown) => ((h.registry.hover = p), noop()),
      registerDefinitionProvider: (_s: unknown, p: unknown) => ((h.registry.definition = p), noop()),
      registerDocumentSymbolProvider: (_s: unknown, p: unknown) => ((h.registry.symbols = p), noop()),
      registerCompletionItemProvider: (_s: unknown, p: unknown) => ((h.registry.completion = p), noop()),
    },
    commands: {
      registerCommand: (name: string, fn: () => unknown) => ((h.registry.commands[name] = fn), noop()),
    },
    window: {
      createOutputChannel: () => ({ appendLine() {}, clear() {}, show() {}, dispose() {} }),
      onDidChangeActiveTextEditor: noop,
      visibleTextEditors: [],
      activeTextEditor: undefined,
      showInformationMessage: vi.fn(),
      showErrorMessage: vi.fn(),
      showWarningMessage: vi.fn(),
    },
    workspace: {
      get textDocuments() {
        return h.registry.docs;
      },
      getConfiguration: () => ({ get: (_k: string, d: unknown) => d }),
      getWorkspaceFolder: () => undefined,
      onDidOpenTextDocument: noop,
      onDidSaveTextDocument: noop,
      onDidChangeTextDocument: noop,
      onDidCloseTextDocument: noop,
      onDidChangeConfiguration: noop,
      createFileSystemWatcher: () => ({ onDidChange: noop, onDidCreate: noop, onDidDelete: noop, dispose() {} }),
    },
    env: { clipboard: { writeText: vi.fn() } },
  };
});

import * as vscode from "vscode";
import { activate } from "../src/extension";

const SOURCE = `NAVGRAPH/2
# a comment mentioning shop
VAR PRODUCT_ID : string
VAR SIGNED_IN : boolean = false
SCREEN home "Home"
SCREEN shop "Shop"
home -> shop { DO TAP { "target": "Shop", "match": { "id": "$PRODUCT_ID$" } } }
shop -> nowhere { DO BACK {} }
END
`;

function fakeDoc(text: string) {
  const lines = text.split("\n");
  const uri = { scheme: "untitled", fsPath: "/x/app.navgraph", path: "/x/app.navgraph", toString: () => "untitled:/x/app.navgraph" };
  return {
    uri,
    languageId: "navgraph",
    version: 1,
    lineCount: lines.length,
    getText: (r?: vscode.Range) => (r ? lines[r.start.line]!.slice(r.start.character, r.end.character) : text),
    lineAt: (n: number) => ({ text: lines[n]!, range: new vscode.Range(n, 0, n, lines[n]!.length) }),
    getWordRangeAtPosition(pos: vscode.Position, re: RegExp) {
      const g = new RegExp(re.source, "g");
      let m: RegExpExecArray | null;
      while ((m = g.exec(lines[pos.line]!))) {
        if (m.index <= pos.character && pos.character <= m.index + m[0].length) {
          return new vscode.Range(pos.line, m.index, pos.line, m.index + m[0].length);
        }
      }
      return undefined;
    },
    offsetAt: (pos: vscode.Position) => lines.slice(0, pos.line).reduce((a, l) => a + l.length + 1, 0) + pos.character,
    validateRange: (r: vscode.Range) => r,
  } as any;
}

const doc = fakeDoc(SOURCE);
const at = (line: number, needle: string, extra = 1) =>
  new vscode.Position(line, SOURCE.split("\n")[line]!.indexOf(needle) + extra);

beforeAll(async () => {
  h.registry.docs = [doc];
  activate({ extensionUri: {}, subscriptions: [] } as any);
  await new Promise((r) => setTimeout(r, 80));
});

describe("extension providers", () => {
  it("publishes a diagnostic that underlines the unknown screen", () => {
    const list = h.registry.diagnostics.get(doc.uri.toString())!;
    const unknown = list.find((d) => d.code === "UNKNOWN_SCREEN");
    expect(unknown).toBeDefined();
    expect(unknown.severity).toBe(0);
    const line = SOURCE.split("\n")[7]!;
    expect(unknown.range.start.line).toBe(7);
    expect(line.slice(unknown.range.start.character, unknown.range.end.character)).toBe("nowhere");
  });

  it("hovers a screen id with its exits", () => {
    const hover = h.registry.hover.provideHover(doc, at(6, "shop {"));
    expect(hover.contents.value).toContain("**Shop** `shop`");
  });

  it("hovers a template variable inside a string", () => {
    const hover = h.registry.hover.provideHover(doc, at(6, "$PRODUCT_ID$", 3));
    expect(hover.contents.value).toContain("VAR PRODUCT_ID : string");
    expect(hover.contents.value).toContain("Required");
  });

  it("does not hover words in comments or plain strings", () => {
    expect(h.registry.hover.provideHover(doc, at(1, "shop"))).toBeUndefined();
    expect(h.registry.hover.provideHover(doc, at(6, '"Shop"', 2))).toBeUndefined();
  });

  it("goes to the declaration of a screen and of a variable", () => {
    const screen = h.registry.definition.provideDefinition(doc, at(6, "shop {"));
    expect(screen.range.start.line).toBe(5);
    expect(screen.range.start.character).toBe(7);
    const variable = h.registry.definition.provideDefinition(doc, at(6, "$PRODUCT_ID$", 3));
    expect(variable.range.start.line).toBe(2);
  });

  it("builds an outline of variables, screens and edges", () => {
    const groups = h.registry.symbols.provideDocumentSymbols(doc);
    expect(groups.map((g: any) => g.name)).toEqual(["Variables", "Screens", "Edges"]);
    expect(groups[1].children.map((c: any) => c.name)).toEqual(["home", "shop"]);
    expect(groups[2].children[1].name).toBe("shop -> nowhere");
  });

  it("completes screen ids after an arrow", () => {
    const line = SOURCE.split("\n")[6]!;
    const pos = new vscode.Position(6, line.indexOf("shop") );
    const items = h.registry.completion.provideCompletionItems(doc, pos);
    expect(items.map((i: any) => i.label)).toEqual(["home", "shop"]);
    expect(items[1].detail).toBe("Shop");
  });

  it("completes actions with required properties after DO", async () => {
    const d = fakeDoc('NAVGRAPH/2\nSCREEN a "A"\nSCREEN b "B"\na -> b {\n  DO ');
    h.registry.docs = [doc, d];
    const items = h.registry.completion.provideCompletionItems(d, new vscode.Position(4, 5));
    const tap = items?.find((i: any) => i.label === "TAP");
    expect(tap?.insertText.value).toBe('TAP { "target": "${1}" }$0');
  });

  it("offers DO inside an edge block and top level keywords outside", () => {
    const inside = fakeDoc('NAVGRAPH/2\nSCREEN a "A"\na -> a {\n  ');
    const insideItems = h.registry.completion.provideCompletionItems(inside, new vscode.Position(3, 2));
    expect(insideItems.map((i: any) => i.label)).toEqual(["DO"]);
    const outside = fakeDoc("NAVGRAPH/2\n");
    const outsideItems = h.registry.completion.provideCompletionItems(outside, new vscode.Position(1, 0));
    expect(outsideItems.map((i: any) => i.label)).toEqual(expect.arrayContaining(["SCREEN", "VAR", "APP", "END", "edge"]));
  });

  it("registers the three commands", () => {
    expect(Object.keys(h.registry.commands).sort()).toEqual([
      "routegraph.copyInstructions",
      "routegraph.findRoute",
      "routegraph.showPreview",
    ]);
  });
});
