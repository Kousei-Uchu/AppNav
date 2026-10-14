#!/usr/bin/env node
/**
 * Scans application source and proposes navigation edges/screens.
 * Usage: node scan-app.js <source-dir> [--out proposed.extend.navgraph]
 */
const fs = require("node:fs");
const path = require("node:path");

const args = process.argv.slice(2);
const srcDir = args.find((a) => !a.startsWith("--")) || "src";
const outArg = argValue("--out", "proposed.extend.navgraph");

function argValue(name, fallback) {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
}

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (["node_modules", "dist", ".git"].includes(entry.name)) continue;
      walk(full, out);
    } else if (/\.(tsx?|jsx?)$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

const files = walk(srcDir);
const screens = new Set();
const edges = [];
const pushSeen = new Set();

function addEdge(from, to, actions) {
  const key = from + "->" + to + "::" + actions.join("|");
  if (pushSeen.has(key)) return;
  pushSeen.add(key);
  edges.push({ from, to, actions });
}

for (const file of files) {
  const text = fs.readFileSync(file, "utf8");
  // React Navigation
  for (const m of text.matchAll(/navigation\.navigate\(\s*["'`]([^"'`]+)["'`]/g)) {
    screens.add(m[1]);
  }
  for (const m of text.matchAll(/router\.push\(\s*["'`]\/?([^"'`]+)["'`]/g)) {
    screens.add(m[1]);
  }
  // screen registration names often like <Stack.Screen name="Home" />
  for (const m of text.matchAll(/<\w+\.Screen\s+name=["']([^"']+)["']/g)) {
    screens.add(m[1]);
  }
}

// Emit a minimal navgraph patch. Edge `from` defaults to a virtual "unknown" when not inferable.
let out = "NAVGRAPH/2\n# Proposed additions from scan (review before applying)\n";
for (const s of [...screens].sort()) {
  out += `SCREEN ${sanitize(s)} "${s}"\n`;
}
out += "\n";
for (const e of edges) {
  out += `${sanitize(e.from)} -> ${sanitize(e.to)} {\n  DO TAP { "target": "Open" }\n}\n`;
}
if (edges.length === 0) {
  out += "# No explicit edges inferred. Review the SCREEN list and wire transitions manually.\n";
}

fs.writeFileSync(outArg, out);
console.log(`Scanned ${files.length} files. Proposed ${screens.size} screens, ${edges.length} edges.`);
console.log(`Wrote ${outArg}`);

function sanitize(s) {
  return String(s).replace(/[^A-Za-z0-9_.:-]/g, "_");
}
