import React from "react";

/**
 * NavGraphWatcher (optional): wrap your app root. In development it records
 * screen transitions into a local extend graph. Persist it however your app
 * prefers (download, send to dev server) and merge with the CLI.
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