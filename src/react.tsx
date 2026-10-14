import * as React from "react";
import { calculatePath, tryCalculatePath, buildInstructionsSync, type NavigationTree, type Path, type Instructions } from "./index";

export interface NavGraphPreviewProps {
  tree: NavigationTree;
  style?: React.CSSProperties;
}

export function NavGraphPreview({ tree, style }: NavGraphPreviewProps): React.ReactElement {
  const screens = [...tree.screens.values()];
  const edges = [...tree.edges];
  return (
    <div style={{ ...style, display: "grid", gap: 8, fontFamily: "monospace", fontSize: 12 }}>
      <strong>NavGraphPreview ({screens.length} screens, {edges.length} edges)</strong>
      <ul style={{ margin: 0, paddingLeft: 16 }}>
        {screens.map((s) => (
          <li key={s.id}>{s.id} — {s.name}</li>
        ))}
      </ul>
      <ul style={{ margin: 0, paddingLeft: 16 }}>
        {edges.map((e) => (
          <li key={e.id}>{e.from} → {e.to} ({e.cost}) {e.id}</li>
        ))}
      </ul>
    </div>
  );
}

export interface NavGraphPlaygroundProps {
  tree: NavigationTree;
  initialFrom?: string;
  initialTo?: string;
}

export function NavGraphPlayground({ tree, initialFrom, initialTo }: NavGraphPlaygroundProps): React.ReactElement {
  const screens = [...tree.screens.values()];
  const [from, setFrom] = React.useState(initialFrom ?? screens[0]?.id ?? "");
  const [to, setTo] = React.useState(initialTo ?? screens[1]?.id ?? "");
  const [route, setRoute] = React.useState<Path | undefined>();
  const [instructions, setInstructions] = React.useState<Instructions | undefined>();
  const [error, setError] = React.useState<string | undefined>();

  const run = React.useCallback(() => {
    setError(undefined);
    const res = tryCalculatePath(tree, from, to);
    if (!res.ok) {
      setRoute(undefined);
      setInstructions(undefined);
      setError(res.error.message);
      return;
    }
    setRoute(res.path);
    try {
      setInstructions(buildInstructionsSync(res.path));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [tree, from, to]);

  const selectStyle: React.CSSProperties = { minWidth: 160 };

  return (
    <div style={{ display: "grid", gap: 8, fontFamily: "system-ui", fontSize: 13 }}>
      <strong>NavGraphPlayground</strong>
      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        <select value={from} onChange={(e) => setFrom((e.target as HTMLSelectElement).value)} style={selectStyle}>
          {screens.map((s) => <option key={s.id} value={s.id}>{s.id}</option>)}
        </select>
        <span>to</span>
        <select value={to} onChange={(e) => setTo((e.target as HTMLSelectElement).value)} style={selectStyle}>
          {screens.map((s) => <option key={s.id} value={s.id}>{s.id}</option>)}
        </select>
        <button type="button" onClick={run}>Find route</button>
      </div>
      {error && <div style={{ color: "#c00" }}>{error}</div>}
      {route && (
        <div>
          <div>Screens: {route.screens.join(" → ")}</div>
          <div>Cost: {route.cost} | Steps: {route.edges.length}</div>
        </div>
      )}
      {instructions && (
        <pre style={{ whiteSpace: "pre-wrap", background: "#f6f6f6", padding: 8, borderRadius: 4, margin: 0 }}>
          {JSON.stringify(instructions, null, 2)}
        </pre>
      )}
      <NavGraphPreview tree={tree} style={{ background: "#fafafa", padding: 8, borderRadius: 4 }} />
    </div>
  );
}
