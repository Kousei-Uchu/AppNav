/* RouteGraph graph preview. Runs inside a VS Code webview, no dependencies. */
(function () {
  "use strict";

  const vscode = acquireVsCodeApi();
  const SVG_NS = "http://www.w3.org/2000/svg";

  const $ = (id) => document.getElementById(id);
  const svg = $("svg");
  const view = $("view");
  const stage = $("stage");

  const state = {
    model: { app: undefined, screens: [], edges: [] },
    route: null,
    layout: new Map(),
    reachable: new Set(),
    tf: { k: 1, x: 0, y: 0 },
    touched: false,
  };

  /* ---------- small DOM helpers (text only, never innerHTML) ---------- */

  function s(name, attrs, parent) {
    const node = document.createElementNS(SVG_NS, name);
    if (attrs) for (const key of Object.keys(attrs)) node.setAttribute(key, String(attrs[key]));
    if (parent) parent.appendChild(node);
    return node;
  }

  function h(tag, props, children) {
    const node = document.createElement(tag);
    if (props) {
      for (const key of Object.keys(props)) {
        if (key === "class") node.className = props[key];
        else if (key === "text") node.textContent = props[key];
        else node.setAttribute(key, String(props[key]));
      }
    }
    if (children) for (const c of children) node.appendChild(c);
    return node;
  }

  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const clip = (text, max) => (text.length > max ? text.slice(0, max - 1) + "\u2026" : text);

  /* ---------- layout ---------- */

  const NODE_H = 44;
  const GAP_X = 44;
  const GAP_Y = 92;

  function nodeWidth(screen) {
    const chars = Math.max(clip(screen.name, 26).length, clip(screen.id, 30).length * 0.9);
    return clamp(Math.round(chars * 7.4 + 30), 104, 232);
  }

  /**
   * Layers by breadth first search from the first declared screen, then stacks
   * any screens that search could not reach below it. Rows are ordered by
   * neighbour position to reduce crossings.
   */
  function computeLayout(model) {
    const ids = model.screens.map((x) => x.id);
    const known = new Set(ids);
    const out = new Map(ids.map((id) => [id, []]));
    const nbrs = new Map(ids.map((id) => [id, new Set()]));
    for (const e of model.edges) {
      if (!known.has(e.from) || !known.has(e.to)) continue;
      out.get(e.from).push(e.to);
      nbrs.get(e.from).add(e.to);
      nbrs.get(e.to).add(e.from);
    }

    const layer = new Map();
    const reachable = new Set();
    let base = 0;
    ids.forEach((root, index) => {
      if (layer.has(root)) return;
      let deepest = 0;
      layer.set(root, base);
      const queue = [root];
      while (queue.length) {
        const cur = queue.shift();
        if (index === 0) reachable.add(cur);
        for (const next of out.get(cur)) {
          if (layer.has(next)) continue;
          layer.set(next, layer.get(cur) + 1);
          deepest = Math.max(deepest, layer.get(next) - base);
          if (index === 0) reachable.add(next);
          queue.push(next);
        }
      }
      base += deepest + 1;
    });

    const rows = [];
    for (const id of ids) {
      const r = layer.get(id);
      (rows[r] = rows[r] || []).push(id);
    }
    const order = new Map();
    const reindex = () => rows.forEach((row) => row && row.forEach((id, i) => order.set(id, i)));
    reindex();

    const sweep = (r, neighbourRow) => {
      const row = rows[r];
      if (!row || row.length < 2) return;
      const key = new Map();
      for (const id of row) {
        const adj = [...nbrs.get(id)].filter((n) => layer.get(n) === neighbourRow);
        key.set(id, adj.length ? adj.reduce((sum, n) => sum + order.get(n), 0) / adj.length : order.get(id));
      }
      row.sort((a, b) => key.get(a) - key.get(b) || order.get(a) - order.get(b));
      row.forEach((id, i) => order.set(id, i));
    };
    for (let pass = 0; pass < 4; pass++) {
      for (let r = 1; r < rows.length; r++) sweep(r, r - 1);
      for (let r = rows.length - 2; r >= 0; r--) sweep(r, r + 1);
    }

    const byId = new Map(model.screens.map((x) => [x.id, x]));
    const placed = new Map();
    rows.forEach((row, r) => {
      if (!row) return;
      const widths = row.map((id) => nodeWidth(byId.get(id)));
      const total = widths.reduce((a, b) => a + b, 0) + GAP_X * (row.length - 1);
      let x = -total / 2;
      row.forEach((id, i) => {
        placed.set(id, { id, x: x + widths[i] / 2, y: r * GAP_Y, w: widths[i], h: NODE_H });
        x += widths[i] + GAP_X;
      });
    });
    return { placed, reachable };
  }

  /* ---------- geometry ---------- */

  function border(n, tx, ty) {
    const dx = tx - n.x;
    const dy = ty - n.y;
    if (dx === 0 && dy === 0) return { x: n.x, y: n.y };
    const sx = n.w / 2 / Math.max(Math.abs(dx), 1e-9);
    const sy = n.h / 2 / Math.max(Math.abs(dy), 1e-9);
    const t = Math.min(sx, sy);
    return { x: n.x + dx * t, y: n.y + dy * t };
  }

  /** `offset` bends the edge sideways so parallel and opposite edges stay visible. */
  function edgeGeometry(a, b, offset, canonicalFirst) {
    if (a === b) {
      const top = a.y - a.h / 2;
      const x1 = a.x - 16;
      const x2 = a.x + 16;
      return {
        d: `M ${x1} ${top} C ${x1 - 6} ${top - 44} ${x2 + 6} ${top - 44} ${x2} ${top}`,
        mid: { x: a.x, y: top - 34 },
      };
    }
    const p = canonicalFirst === a ? a : b;
    const q = canonicalFirst === a ? b : a;
    const dx = q.x - p.x;
    const dy = q.y - p.y;
    const len = Math.hypot(dx, dy) || 1;
    const cx = (a.x + b.x) / 2 + (-dy / len) * offset * 2;
    const cy = (a.y + b.y) / 2 + (dx / len) * offset * 2;
    const p0 = border(a, cx, cy);
    const p1 = border(b, cx, cy);
    return {
      d: `M ${p0.x} ${p0.y} Q ${cx} ${cy} ${p1.x} ${p1.y}`,
      mid: { x: 0.25 * p0.x + 0.5 * cx + 0.25 * p1.x, y: 0.25 * p0.y + 0.5 * cy + 0.25 * p1.y },
    };
  }

  /* ---------- rendering ---------- */

  let nodeEls = new Map();
  let edgeEls = new Map();

  function tagText(edge) {
    const parts = [];
    if (edge.label) parts.push(edge.label);
    if (edge.cost !== 1) parts.push("cost " + edge.cost);
    if (edge.condition) parts.push("if " + edge.condition);
    return parts.length ? clip(parts.join(", "), 30) : "";
  }

  function render() {
    const model = state.model;
    while (view.firstChild) view.removeChild(view.firstChild);
    nodeEls = new Map();
    edgeEls = new Map();

    const empty = model.screens.length === 0;
    $("empty").hidden = !empty;
    $("go").disabled = empty;
    if (empty) {
      state.layout = new Map();
      return;
    }

    const result = computeLayout(model);
    state.layout = result.placed;
    state.reachable = result.reachable;

    const pairs = new Map();
    for (const e of model.edges) {
      if (!state.layout.has(e.from) || !state.layout.has(e.to) || e.from === e.to) continue;
      const key = e.from < e.to ? e.from + "\u0000" + e.to : e.to + "\u0000" + e.from;
      (pairs.get(key) || pairs.set(key, []).get(key)).push(e);
    }

    const edgeLayer = s("g", { class: "edges" }, view);
    const nodeLayer = s("g", { class: "nodes" }, view);

    for (const e of model.edges) {
      const a = state.layout.get(e.from);
      const b = state.layout.get(e.to);
      if (!a || !b) continue;
      let offset = 0;
      let canonical = a;
      if (e.from !== e.to) {
        const key = e.from < e.to ? e.from + "\u0000" + e.to : e.to + "\u0000" + e.from;
        const group = pairs.get(key);
        const index = group.indexOf(e);
        offset = group.length === 1 ? 0 : (index - (group.length - 1) / 2) * 30;
        canonical = state.layout.get(e.from < e.to ? e.from : e.to);
      }
      const geo = edgeGeometry(a, b, offset, canonical);
      const g = s("g", { class: "edge" }, edgeLayer);
      const full = e.id + ": " + e.actions + (e.condition ? " (only if " + e.condition + ")" : "");
      s("title", {}, g).textContent = full;
      s("path", { class: "hit", d: geo.d }, g);
      s("path", { class: "line", d: geo.d, "marker-end": "url(#arrow)" }, g);

      const text = tagText(e);
      const tag = s("g", { class: "tag", transform: `translate(${geo.mid.x} ${geo.mid.y})` }, g);
      if (text) {
        const w = text.length * 6 + 12;
        s("rect", { x: -w / 2, y: -9, width: w, height: 18, rx: 4 }, tag);
        s("text", { y: 3.5 }, tag).textContent = text;
      }
      const badge = s("g", { class: "badge", transform: `translate(${geo.mid.x} ${geo.mid.y})` }, g);
      s("circle", { r: 10 }, badge);
      s("text", { y: 3.8 }, badge);

      g.addEventListener("click", () => {
        if (!dragged && e.line) vscode.postMessage({ type: "reveal", line: e.line });
      });
      g.addEventListener("pointerenter", () => focusEdge(e));
      g.addEventListener("pointerleave", unfocus);
      edgeEls.set(e.id, { g, edge: e, badge });
    }

    model.screens.forEach((sc, index) => {
      const n = state.layout.get(sc.id);
      const unreachable = !state.reachable.has(sc.id);
      const g = s(
        "g",
        {
          class: "node" + (unreachable ? " unreachable" : "") + (index === 0 ? " start" : ""),
          transform: `translate(${n.x} ${n.y})`,
          tabindex: 0,
          role: "button",
          "aria-label": `${sc.name}, screen ${sc.id}`,
        },
        nodeLayer,
      );
      const note = index === 0 ? "First screen, routes are measured from here" : unreachable ? "Not reachable from the first screen" : "";
      s("title", {}, g).textContent = sc.id + (note ? ": " + note : "");
      s("rect", { x: -n.w / 2, y: -n.h / 2, width: n.w, height: n.h, rx: 7 }, g);
      s("text", { class: "name", y: -2, "text-anchor": "middle" }, g).textContent = clip(sc.name, 26);
      s("text", { class: "sid", y: 14, "text-anchor": "middle" }, g).textContent = clip(sc.id, 30);

      const open = () => {
        if (!dragged) vscode.postMessage({ type: "reveal", line: sc.line });
      };
      g.addEventListener("click", open);
      g.addEventListener("keydown", (ev) => {
        if (ev.key === "Enter" || ev.key === " ") {
          ev.preventDefault();
          vscode.postMessage({ type: "reveal", line: sc.line });
        }
      });
      g.addEventListener("pointerenter", () => focusNode(sc.id));
      g.addEventListener("pointerleave", unfocus);
      g.addEventListener("focus", () => focusNode(sc.id));
      g.addEventListener("blur", unfocus);
      nodeEls.set(sc.id, g);
    });

    applyRoute();
    if (!state.touched) fit();
    else applyTransform();
  }

  function focusNode(id) {
    if (state.route) return;
    svg.classList.add("focusing");
    for (const { g, edge } of edgeEls.values()) {
      const hot = edge.from === id || edge.to === id;
      g.classList.toggle("hot", hot);
      if (hot) {
        nodeEls.get(edge.from)?.classList.add("hot");
        nodeEls.get(edge.to)?.classList.add("hot");
      }
    }
    nodeEls.get(id)?.classList.add("hot");
  }

  function focusEdge(edge) {
    if (state.route) return;
    svg.classList.add("focusing");
    edgeEls.get(edge.id)?.g.classList.add("hot");
    nodeEls.get(edge.from)?.classList.add("hot");
    nodeEls.get(edge.to)?.classList.add("hot");
  }

  function unfocus() {
    svg.classList.remove("focusing");
    for (const el of svg.querySelectorAll(".hot")) el.classList.remove("hot");
  }

  /* ---------- route ---------- */

  function applyRoute() {
    const route = state.route;
    svg.classList.toggle("routing", !!route);
    const edgeSet = new Set(route ? route.edges : []);
    const nodeSet = new Set(route ? route.screens : []);
    const stepOf = new Map();
    if (route) route.steps.forEach((st) => stepOf.set(st.edge, st.n));

    for (const [id, { g, badge }] of edgeEls) {
      const on = edgeSet.has(id);
      g.classList.toggle("route", on);
      const label = badge.querySelector("text");
      if (label) label.textContent = on ? String(stepOf.get(id)) : "";
    }
    for (const [id, g] of nodeEls) g.classList.toggle("route", nodeSet.has(id));

    $("clear").hidden = !route;
    const aside = $("steps");
    aside.hidden = !route;
    const list = $("stepList");
    while (list.firstChild) list.removeChild(list.firstChild);
    if (!route) return;

    const names = new Map(state.model.screens.map((x) => [x.id, x.name]));
    $("routeTitle").textContent = `${names.get(route.from) || route.from} to ${names.get(route.to) || route.to}`;
    $("routeMeta").textContent =
      route.steps.length === 0 ? "Already there" : `${route.steps.length} ${route.steps.length === 1 ? "step" : "steps"}, cost ${route.cost}`;
    for (const st of route.steps) {
      const btn = h(
        "button",
        { class: "step", type: "button" },
        [
          h("span", { class: "n", text: String(st.n) }),
          h("span", { class: "what" }, [
            h("span", { class: "hop", text: `${names.get(st.from) || st.from} to ${names.get(st.to) || st.to}` }),
            h("span", { class: "do", text: st.summary }),
          ]),
        ],
      );
      btn.addEventListener("click", () => st.line && vscode.postMessage({ type: "reveal", line: st.line }));
      list.appendChild(h("li", null, [btn]));
    }
  }

  /* ---------- toolbar ---------- */

  function fillSelects() {
    for (const id of ["from", "to"]) {
      const select = $(id);
      const previous = select.value;
      while (select.firstChild) select.removeChild(select.firstChild);
      for (const sc of state.model.screens) {
        select.appendChild(h("option", { value: sc.id, text: `${sc.name} (${sc.id})` }));
      }
      if (state.model.screens.some((x) => x.id === previous)) select.value = previous;
      else if (id === "to" && state.model.screens.length > 1) select.selectedIndex = state.model.screens.length - 1;
    }
  }

  function banner(kind, text) {
    const el = $("banner");
    el.hidden = !text;
    el.className = kind || "";
    el.textContent = text || "";
  }

  $("go").addEventListener("click", () => {
    const from = $("from").value;
    const to = $("to").value;
    if (!from || !to) return;
    if (from === to) {
      banner("error", "Pick two different screens to find a route.");
      return;
    }
    banner("", "");
    vscode.postMessage({ type: "findRoute", from, to });
  });
  $("clear").addEventListener("click", () => {
    state.route = null;
    banner("", "");
    applyRoute();
  });
  $("fit").addEventListener("click", () => {
    state.touched = false;
    fit();
  });

  /* ---------- pan and zoom ---------- */

  let dragged = false;

  function applyTransform() {
    const { k, x, y } = state.tf;
    view.setAttribute("transform", `translate(${x} ${y}) scale(${k})`);
  }

  function fit() {
    if (state.layout.size === 0) return;
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const n of state.layout.values()) {
      minX = Math.min(minX, n.x - n.w / 2);
      maxX = Math.max(maxX, n.x + n.w / 2);
      minY = Math.min(minY, n.y - n.h / 2 - 40);
      maxY = Math.max(maxY, n.y + n.h / 2);
    }
    const pad = 36;
    const bw = maxX - minX + pad * 2;
    const bh = maxY - minY + pad * 2;
    const rect = stage.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;
    const k = clamp(Math.min(rect.width / bw, rect.height / bh), 0.15, 1.2);
    state.tf = {
      k,
      x: rect.width / 2 - ((minX + maxX) / 2) * k,
      y: rect.height / 2 - ((minY + maxY) / 2) * k,
    };
    applyTransform();
  }

  svg.addEventListener(
    "wheel",
    (ev) => {
      ev.preventDefault();
      const rect = svg.getBoundingClientRect();
      const px = ev.clientX - rect.left;
      const py = ev.clientY - rect.top;
      const factor = Math.exp(-ev.deltaY * (ev.ctrlKey ? 0.01 : 0.0015));
      const k = clamp(state.tf.k * factor, 0.15, 3);
      const ratio = k / state.tf.k;
      state.tf = { k, x: px - (px - state.tf.x) * ratio, y: py - (py - state.tf.y) * ratio };
      state.touched = true;
      applyTransform();
    },
    { passive: false },
  );

  let drag = null;
  svg.addEventListener("pointerdown", (ev) => {
    if (ev.button !== 0) return;
    drag = { x: ev.clientX, y: ev.clientY, tx: state.tf.x, ty: state.tf.y, active: false, id: ev.pointerId };
    dragged = false;
  });
  svg.addEventListener("pointermove", (ev) => {
    if (!drag) return;
    const dx = ev.clientX - drag.x;
    const dy = ev.clientY - drag.y;
    if (!drag.active && Math.hypot(dx, dy) > 4) {
      drag.active = true;
      dragged = true;
      svg.setPointerCapture(drag.id);
      svg.classList.add("panning");
    }
    if (drag.active) {
      state.tf = { k: state.tf.k, x: drag.tx + dx, y: drag.ty + dy };
      state.touched = true;
      applyTransform();
    }
  });
  const endDrag = () => {
    drag = null;
    svg.classList.remove("panning");
    setTimeout(() => (dragged = false), 0);
  };
  svg.addEventListener("pointerup", endDrag);
  svg.addEventListener("pointercancel", endDrag);

  svg.addEventListener("keydown", (ev) => {
    if (ev.target !== svg) return;
    if (ev.key === "0") {
      state.touched = false;
      fit();
    }
  });

  new ResizeObserver(() => {
    if (!state.touched) fit();
  }).observe(stage);

  /* ---------- messages from the extension ---------- */

  window.addEventListener("message", (event) => {
    const msg = event.data;
    if (msg.type === "model") {
      state.model = msg.model;
      if (state.route) {
        const ids = new Set(msg.model.screens.map((x) => x.id));
        if (!ids.has(state.route.from) || !ids.has(state.route.to)) state.route = null;
      }
      $("app").textContent = msg.model.app || msg.title || "";
      fillSelects();
      render();
      banner(msg.stale ? "warn" : "", msg.stale || "");
    } else if (msg.type === "route") {
      state.route = msg.route;
      if (msg.route) {
        $("from").value = msg.route.from;
        $("to").value = msg.route.to;
      }
      banner("", "");
      applyRoute();
    } else if (msg.type === "routeError") {
      state.route = null;
      applyRoute();
      banner("error", msg.message);
    }
  });

  vscode.postMessage({ type: "ready" });
})();
