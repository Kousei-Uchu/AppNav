import { FileLoadError } from "./errors";
import type { ReadFile } from "./types";

/**
 * Default file reader. Uses Node's built in fs when it is available and
 * otherwise explains how to supply a reader. React Native has no filesystem
 * access by default, so pass `readFile` (for example from expo-file-system or
 * react-native-fs) or use the in-memory APIs such as `indexTreeFromText`.
 */
export const defaultReadFile: ReadFile = async (path) => {
  const proc = (globalThis as { process?: { getBuiltinModule?: (id: string) => unknown } }).process;
  const fs =
    typeof proc?.getBuiltinModule === "function"
      ? (proc.getBuiltinModule("node:fs/promises") as { readFile(p: string, enc: string): Promise<string> } | undefined)
      : undefined;
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
