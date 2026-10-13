import * as vscode from "vscode";
import type { PreviewModel, RouteModel } from "./analysis";

export interface PreviewHandlers {
  reveal(uri: vscode.Uri, line: number): void;
  findRoute(uri: vscode.Uri, from: string, to: string): void;
  disposed(): void;
}

interface ModelMessage {
  type: "model";
  model: PreviewModel;
  title: string;
  stale?: string;
}

function nonce(): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let out = "";
  for (let i = 0; i < 32; i++) out += chars.charAt(Math.floor(Math.random() * chars.length));
  return out;
}

export class PreviewPanel {
  private static instance: PreviewPanel | undefined;

  private readonly panel: vscode.WebviewPanel;
  private ready = false;
  private lastModel: ModelMessage | undefined;
  private lastRoute: unknown;
  private documentUri: vscode.Uri;

  static get current(): PreviewPanel | undefined {
    return PreviewPanel.instance;
  }

  static show(extensionUri: vscode.Uri, uri: vscode.Uri, handlers: PreviewHandlers): PreviewPanel {
    if (PreviewPanel.instance) {
      PreviewPanel.instance.documentUri = uri;
      PreviewPanel.instance.panel.reveal(vscode.ViewColumn.Beside, true);
      return PreviewPanel.instance;
    }
    const panel = vscode.window.createWebviewPanel(
      "routegraph.preview",
      "RouteGraph",
      { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(extensionUri, "media")],
      },
    );
    PreviewPanel.instance = new PreviewPanel(panel, extensionUri, uri, handlers);
    return PreviewPanel.instance;
  }

  private constructor(
    panel: vscode.WebviewPanel,
    extensionUri: vscode.Uri,
    uri: vscode.Uri,
    handlers: PreviewHandlers,
  ) {
    this.panel = panel;
    this.documentUri = uri;
    panel.webview.html = this.html(panel.webview, extensionUri);

    panel.webview.onDidReceiveMessage((msg: { type: string; line?: number; from?: string; to?: string }) => {
      if (msg.type === "ready") {
        this.ready = true;
        if (this.lastModel) void panel.webview.postMessage(this.lastModel);
        if (this.lastRoute) void panel.webview.postMessage(this.lastRoute);
      } else if (msg.type === "reveal" && typeof msg.line === "number") {
        handlers.reveal(this.documentUri, msg.line);
      } else if (msg.type === "findRoute" && msg.from && msg.to) {
        handlers.findRoute(this.documentUri, msg.from, msg.to);
      }
    });

    panel.onDidDispose(() => {
      PreviewPanel.instance = undefined;
      handlers.disposed();
    });
  }

  get uri(): vscode.Uri {
    return this.documentUri;
  }

  setDocument(uri: vscode.Uri): void {
    this.documentUri = uri;
    this.panel.title = `Graph: ${uri.path.split("/").pop() ?? "RouteGraph"}`;
  }

  /** `stale` is shown as a banner when the model comes from an earlier, valid version of the file. */
  update(model: PreviewModel, stale?: string): void {
    const title = this.documentUri.path.split("/").pop() ?? "";
    this.lastModel = { type: "model", model, title, stale };
    if (this.ready) void this.panel.webview.postMessage(this.lastModel);
  }

  showRoute(route: RouteModel | null): void {
    this.lastRoute = { type: "route", route };
    if (this.ready) void this.panel.webview.postMessage(this.lastRoute);
  }

  routeError(message: string): void {
    this.lastRoute = undefined;
    if (this.ready) void this.panel.webview.postMessage({ type: "routeError", message });
  }

  private html(webview: vscode.Webview, extensionUri: vscode.Uri): string {
    const n = nonce();
    const script = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, "media", "preview.js"));
    const csp = [
      "default-src 'none'",
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `script-src 'nonce-${n}'`,
    ].join("; ");

    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>RouteGraph</title>
<style>
  :root {
    --edge: color-mix(in srgb, var(--vscode-foreground) 42%, transparent);
    --edge-dim: color-mix(in srgb, var(--vscode-foreground) 14%, transparent);
    --route: var(--vscode-textLink-foreground, #3794ff);
    --line: var(--vscode-editorWidget-border, var(--vscode-contrastBorder, #8888));
  }
  * { box-sizing: border-box; }
  html, body { height: 100%; }
  body {
    margin: 0; display: flex; flex-direction: column;
    color: var(--vscode-foreground); background: var(--vscode-editor-background);
    font: 13px var(--vscode-font-family);
  }
  header {
    display: flex; flex-wrap: wrap; align-items: center; gap: 8px;
    padding: 8px 12px; border-bottom: 1px solid var(--line);
  }
  .app { font-weight: 600; margin-right: auto; }
  .finder { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; }
  .finder .to { color: var(--vscode-descriptionForeground); }
  select {
    max-width: 210px; padding: 3px 6px; font: inherit;
    color: var(--vscode-dropdown-foreground); background: var(--vscode-dropdown-background);
    border: 1px solid var(--vscode-dropdown-border, var(--line)); border-radius: 3px;
  }
  button { font: inherit; cursor: pointer; }
  header button {
    padding: 4px 10px; border: 0; border-radius: 3px;
    color: var(--vscode-button-secondaryForeground); background: var(--vscode-button-secondaryBackground);
  }
  header button:hover { background: var(--vscode-button-secondaryHoverBackground); }
  header #go { color: var(--vscode-button-foreground); background: var(--vscode-button-background); }
  header #go:hover { background: var(--vscode-button-hoverBackground); }
  header button:disabled { opacity: .5; cursor: default; }
  button:focus-visible, select:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: 1px; }

  #banner { padding: 6px 12px; border-bottom: 1px solid var(--line); }
  #banner.warn {
    background: var(--vscode-inputValidation-warningBackground);
    border-color: var(--vscode-inputValidation-warningBorder);
  }
  #banner.error {
    background: var(--vscode-inputValidation-errorBackground);
    border-color: var(--vscode-inputValidation-errorBorder);
  }

  .body { flex: 1; display: flex; min-height: 0; }
  #stage { flex: 1; position: relative; min-width: 0; }
  #empty {
    position: absolute; inset: 0; display: flex; align-items: center; justify-content: center;
    padding: 24px; text-align: center; color: var(--vscode-descriptionForeground);
  }
  #empty p { max-width: 38ch; margin: 0; line-height: 1.5; }
  #empty[hidden], #banner[hidden], #steps[hidden], header [hidden] { display: none; }

  #svg { width: 100%; height: 100%; display: block; cursor: grab; outline: none; touch-action: none; }
  #svg.panning { cursor: grabbing; }

  .arrow-normal { fill: var(--edge); }
  .arrow-dim { fill: var(--edge-dim); }
  .arrow-hot { fill: var(--vscode-focusBorder); }
  .arrow-route { fill: var(--route); }

  .edge .hit { fill: none; stroke: transparent; stroke-width: 14; cursor: pointer; pointer-events: stroke; }
  .edge .line { fill: none; stroke: var(--edge); stroke-width: 1.4; pointer-events: none; marker-end: url(#arrow-normal); }
  .edge .tag { pointer-events: none; }
  .edge .tag rect { fill: var(--vscode-editor-background); stroke: var(--line); stroke-width: 1; }
  .edge .tag text {
    fill: var(--vscode-descriptionForeground); text-anchor: middle;
    font: 10.5px var(--vscode-editor-font-family, monospace);
  }
  .edge .badge { display: none; pointer-events: none; }
  .edge .badge circle { fill: var(--route); }
  .edge .badge text { fill: var(--vscode-editor-background); text-anchor: middle; font: 600 11px var(--vscode-font-family); }

  .node { cursor: pointer; outline: none; }
  .node rect { fill: var(--vscode-editorWidget-background, var(--vscode-editor-background)); stroke: var(--line); stroke-width: 1; }
  .node.start rect { stroke: var(--vscode-foreground); stroke-width: 1.5; }
  .node.unreachable rect { stroke-dasharray: 4 3; }
  .node .name { fill: var(--vscode-foreground); font: 500 12.5px var(--vscode-font-family); }
  .node .sid { fill: var(--vscode-descriptionForeground); font: 10.5px var(--vscode-editor-font-family, monospace); }
  .node:focus-visible rect { stroke: var(--vscode-focusBorder); stroke-width: 2; }

  .focusing .node:not(.hot), .routing .node:not(.route) { opacity: .38; }
  .focusing .edge:not(.hot) .line, .routing .edge:not(.route) .line { stroke: var(--edge-dim); marker-end: url(#arrow-dim); }
  .focusing .edge:not(.hot) .tag, .routing .edge:not(.route) .tag { opacity: .35; }
  .edge.hot .line { stroke: var(--vscode-focusBorder); stroke-width: 1.8; marker-end: url(#arrow-hot); }
  .node.hot rect { stroke: var(--vscode-focusBorder); }
  .edge.route .line { stroke: var(--route); stroke-width: 2.4; marker-end: url(#arrow-route); }
  .node.route rect { stroke: var(--route); stroke-width: 2; }
  .routing .edge.route .tag { display: none; }
  .routing .edge.route .badge { display: block; }

  @media (prefers-reduced-motion: no-preference) {
    .node, .edge .line, .edge .tag { transition: opacity .12s; }
  }

  #steps { width: 272px; overflow: auto; padding: 12px 0; border-left: 1px solid var(--line); }
  #steps h2 { margin: 0 14px 2px; font-size: 13px; font-weight: 600; }
  #steps .meta { margin: 0 14px 10px; color: var(--vscode-descriptionForeground); }
  #stepList { list-style: none; margin: 0; padding: 0; }
  .step {
    display: flex; gap: 10px; width: 100%; padding: 7px 14px; text-align: left;
    color: inherit; background: none; border: 0;
  }
  .step:hover { background: var(--vscode-list-hoverBackground); }
  .step .n {
    flex: none; width: 20px; height: 20px; border-radius: 50%; display: grid; place-items: center;
    color: var(--vscode-editor-background); background: var(--route); font: 600 11px var(--vscode-font-family);
  }
  .step .what { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
  .step .do { color: var(--vscode-descriptionForeground); font: 11px var(--vscode-editor-font-family, monospace); overflow-wrap: anywhere; }

  @media (max-width: 720px) {
    .body { flex-direction: column; }
    #steps { width: auto; max-height: 40%; border-left: 0; border-top: 1px solid var(--line); }
  }
</style>
</head>
<body>
  <header>
    <span class="app" id="app"></span>
    <div class="finder">
      <select id="from" aria-label="Route start"></select>
      <span class="to">to</span>
      <select id="to" aria-label="Route end"></select>
      <button id="go" type="button">Find route</button>
      <button id="clear" type="button" hidden>Clear route</button>
    </div>
    <button id="fit" type="button" title="Fit the graph to the window">Fit</button>
  </header>
  <div id="banner" hidden></div>
  <div class="body">
    <div id="stage">
      <svg id="svg" tabindex="0" role="group" aria-label="Navigation graph">
        <defs>
          <marker id="arrow-normal" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path class="arrow-normal" d="M0 0 L10 5 L0 10 z"/></marker>
          <marker id="arrow-dim" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path class="arrow-dim" d="M0 0 L10 5 L0 10 z"/></marker>
          <marker id="arrow-hot" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path class="arrow-hot" d="M0 0 L10 5 L0 10 z"/></marker>
          <marker id="arrow-route" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto"><path class="arrow-route" d="M0 0 L10 5 L0 10 z"/></marker>
        </defs>
        <g id="view"></g>
      </svg>
      <div id="empty" hidden><p>No screens yet. Declare one with SCREEN id "Name" and it will appear here.</p></div>
    </div>
    <aside id="steps" hidden aria-label="Route steps">
      <h2 id="routeTitle"></h2>
      <p class="meta" id="routeMeta"></p>
      <ol id="stepList"></ol>
    </aside>
  </div>
  <script nonce="${n}" src="${script}"></script>
</body>
</html>`;
  }
}
