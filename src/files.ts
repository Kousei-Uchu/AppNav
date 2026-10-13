import { FileLoadError } from "./errors";
import type { ReadFile } from "./types";

/** The slice of `node:fs/promises` this module needs. */
interface FsPromises {
  readFile(path: string, encoding: string): Promise<string>;
}

interface NodeProcessLike {
  versions?: { node?: string };
  getBuiltinModule?: (id: string) => unknown;
}

/** Only the dynamic import is cached. The environment checks run on every call, so they always reflect reality. */
let importedFs: Promise<FsPromises | undefined> | undefined;

async function importFs(): Promise<FsPromises | undefined> {
  try {
    const dynamicImport = new Function("id", "return import(id)") as (id: string) => Promise<unknown>;
    const mod = (await dynamicImport("node:fs/promises")) as FsPromises & { default?: FsPromises };
    return typeof mod.readFile === "function" ? mod : mod.default;
  } catch (error) {
    if (typeof process !== "undefined" && (process as { env?: Record<string, string | undefined> }).env?.APPNAV_DEBUG) {
      console.error("routegraph: dynamic import of node:fs/promises failed", error);
    }
    return undefined;
  }
}

/**
 * Locate Node's fs without a static import, so bundlers (Metro, webpack, Vite)
 * never see a reference to a Node built in and React Native builds keep working.
 *
 * 1. Not Node (React Native, browsers): there is no filesystem, return undefined.
 * 2. `process.getBuiltinModule` (Node 20.16+, 22.3+): synchronous and simplest.
 * 3. A module-scoped `require` (the CommonJS build, Jest, vitest): works on every
 *    Node version, including 18. It is called through an alias, so bundlers do not
 *    treat it as a static dependency.
 * 4. A dynamic `import()` created through the Function constructor, for the ESM
 *    build on Node 18 and early 20, where neither of the above exists. Bundlers
 *    cannot analyse it.
 */
async function loadNodeFs(): Promise<FsPromises | undefined> {
  const proc = (globalThis as { process?: NodeProcessLike }).process;
  if (typeof proc?.versions?.node !== "string") return undefined;

  if (typeof proc.getBuiltinModule === "function") {
    const builtin = proc.getBuiltinModule("node:fs/promises") as FsPromises | undefined;
    if (builtin) return builtin;
  }

  if (typeof require === "function") {
    try {
      const nodeRequire: (id: string) => unknown = require;
      const viaRequire = nodeRequire("node:fs/promises") as FsPromises | undefined;
      if (viaRequire) return viaRequire;
    } catch {
      // fall through to the dynamic import
    }
  }

  importedFs ??= importFs();
  const loaded = await importedFs;
  if (!loaded) importedFs = undefined;
  return loaded;
}

/**
 * Default file reader. Uses Node's built in fs when it is available and
 * otherwise explains how to supply a reader. React Native has no filesystem
 * access by default, so pass `readFile` (for example from expo-file-system or
 * react-native-fs) or use the in-memory APIs such as `indexTreeFromText`.
 */
export const defaultReadFile: ReadFile = async (path) => {
  const fs = await loadNodeFs();
  if (!fs) {
    throw new FileLoadError(
      `Cannot read "${path}": no filesystem is available in this runtime. ` +
        `Pass a "readFile" option, or load the text yourself and call indexTreeFromText().`,
      path,
    );
  }
  try {
    return await fs.readFile(path, "utf8");
  } catch (e) {
    throw new FileLoadError(`Cannot read "${path}": ${e instanceof Error ? e.message : String(e)}`, path, e);
  }
};