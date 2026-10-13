// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const script = readFileSync(join(__dirname, "../media/preview.js"), "utf8");

const SKELETON = `
<header><span id="app"></span><select id="from"></select><select id="to"></select>
<button id="go"></button><button id="clear" hidden></button><button id="fit"></button></header>
<div id="banner" hidden></div>
<div id="stage"><svg id="svg"><g id="view"></g></svg><div id="empty" hidden></div></div>
<aside id="steps" hidden><h2 id="routeTitle"></h2><p id="routeMeta"></p><ol id="stepList"></ol></aside>`;

const model = {
  app: "Shop",
  screens: [
    { id: "home", name: "Home", line: 5 },
    { id: "shop", name: "Shop", line: 6 },
    { id: "cart", name: "Cart", line: 7 },
    { id: "island", name: "Island", line: 8 },
  ],
  edges: [
    { id: "home->shop", from: "home", to: "shop", cost: 1, actions: 'TAP "Shop"', line: 10 },
    { id: "shop->home", from: "shop", to: "home", cost: 1, actions: "BACK", line: 11 },
    { id: "shop->cart", from: "shop", to: "cart", cost: 2, condition: "SIGNED_IN", actions: 'TAP "Cart"', line: 12 },
    { id: "cart->cart", from: "cart", to: "cart", cost: 1, actions: "no actions", line: 13 },
  ],
};

let posted: any[];

function send(data: unknown) {
  window.dispatchEvent(new MessageEvent("message", { data }));
}

beforeEach(() => {
  document.body.innerHTML = SKELETON;
  posted = [];
  (globalThis as any).acquireVsCodeApi = () => ({ postMessage: (m: unknown) => posted.push(m) });
  (globalThis as any).ResizeObserver = class {
    observe() {}
    disconnect() {}
  };
  (window as any).eval(script);
});

describe("preview webview", () => {
  it("announces readiness and renders a model", () => {
    expect(posted[0]).toEqual({ type: "ready" });
    send({ type: "model", model, title: "app.navgraph" });
    expect(document.querySelectorAll(".node")).toHaveLength(4);
    expect(document.querySelectorAll(".edge")).toHaveLength(4);
    expect(document.getElementById("app")!.textContent).toBe("Shop");
    expect(document.querySelectorAll("#from option")).toHaveLength(4);
  });

  it("marks the first screen and screens the search cannot reach", () => {
    send({ type: "model", model, title: "" });
    const nodes = [...document.querySelectorAll(".node")];
    expect(nodes[0]!.classList.contains("start")).toBe(true);
    expect(nodes[3]!.classList.contains("unreachable")).toBe(true);
    expect(nodes[1]!.classList.contains("unreachable")).toBe(false);
  });

  it("puts a screen on a lower row than the one that links to it", () => {
    send({ type: "model", model, title: "" });
    const y = (i: number) => document.querySelectorAll(".node")[i]!.getAttribute("transform");
    expect(y(0)).toMatch(/ 0\)/);
    expect(y(1)).not.toBe(y(0));
  });

  it("jumps to the source line when a node is clicked", () => {
    send({ type: "model", model, title: "" });
    (document.querySelectorAll(".node")[1] as SVGElement).dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(posted.at(-1)).toEqual({ type: "reveal", line: 6 });
  });

  it("asks for a route and highlights the answer with numbered steps", () => {
    send({ type: "model", model, title: "" });
    (document.getElementById("from") as HTMLSelectElement).value = "home";
    (document.getElementById("to") as HTMLSelectElement).value = "cart";
    document.getElementById("go")!.dispatchEvent(new MouseEvent("click"));
    expect(posted.at(-1)).toEqual({ type: "findRoute", from: "home", to: "cart" });

    send({
      type: "route",
      route: {
        from: "home",
        to: "cart",
        cost: 3,
        screens: ["home", "shop", "cart"],
        edges: ["home->shop", "shop->cart"],
        steps: [
          { n: 1, edge: "home->shop", from: "home", to: "shop", summary: 'TAP "Shop"', line: 10 },
          { n: 2, edge: "shop->cart", from: "shop", to: "cart", summary: 'TAP "Cart"', line: 12 },
        ],
      },
    });
    expect(document.querySelectorAll(".edge.route")).toHaveLength(2);
    expect(document.querySelectorAll(".node.route")).toHaveLength(3);
    expect(document.getElementById("svg")!.classList.contains("routing")).toBe(true);
    expect(document.querySelectorAll("#stepList .step")).toHaveLength(2);
    expect(document.getElementById("routeMeta")!.textContent).toBe("2 steps, cost 3");
    expect(document.querySelector(".edge.route .badge text")!.textContent).toBe("1");

    document.getElementById("clear")!.dispatchEvent(new MouseEvent("click"));
    expect(document.querySelectorAll(".edge.route")).toHaveLength(0);
    expect(document.getElementById("steps")!.hidden).toBe(true);
  });

  it("refuses to route from a screen to itself", () => {
    send({ type: "model", model, title: "" });
    (document.getElementById("from") as HTMLSelectElement).value = "home";
    (document.getElementById("to") as HTMLSelectElement).value = "home";
    document.getElementById("go")!.dispatchEvent(new MouseEvent("click"));
    expect(posted.filter((m) => m.type === "findRoute")).toHaveLength(0);
    expect(document.getElementById("banner")!.textContent).toContain("two different screens");
  });

  it("shows route errors and the stale notice, and an empty state", () => {
    send({ type: "model", model, title: "", stale: "Showing the last valid version." });
    expect(document.getElementById("banner")!.className).toBe("warn");
    send({ type: "routeError", message: "No path." });
    expect(document.getElementById("banner")!.textContent).toBe("No path.");
    send({ type: "model", model: { screens: [], edges: [] }, title: "x" });
    expect(document.getElementById("empty")!.hidden).toBe(false);
    expect((document.getElementById("go") as HTMLButtonElement).disabled).toBe(true);
  });

  it("never injects markup from screen names", () => {
    const evil = { screens: [{ id: "a", name: "<img src=x onerror=alert(1)>", line: 1 }], edges: [] };
    send({ type: "model", model: evil, title: "" });
    expect(document.querySelector("img")).toBeNull();
    expect(document.querySelector(".node .name")!.textContent).toContain("<img");
  });
});
