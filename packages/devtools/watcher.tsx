import React from "react";

/**
 * NavGraphWatcher (optional): wrap your app root. In development it logs a
 * `.navgraph` edge line to the console for every click on an element with a
 * `data-screen` attribute. It writes nothing to disk. Copy the lines you want
 * into your graph by hand.
 */
export function NavGraphWatcher({ children }: { children: React.ReactNode }) {
  React.useEffect(() => {
    let current = "unknown";
    const log = (next: string) => {
      const line = `${current} -> ${next} { DO TAP { "target": "auto" } }\n`;
      // eslint-disable-next-line no-console
      console.info("[routegraph]", line);
      current = next;
    };
    const handler = (event: Event) => {
      const target = event.target as HTMLElement | null;
      const screen = target?.getAttribute?.("data-screen");
      if (screen) log(screen);
    };
    document.addEventListener("click", handler, true);
    return () => document.removeEventListener("click", handler, true);
  }, []);
  return <>{children}</>;
}