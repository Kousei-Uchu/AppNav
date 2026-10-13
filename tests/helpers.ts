import { readFileSync } from "node:fs";
import { resolve } from "node:path";

export const examplePath = (name: string) => resolve(__dirname, "..", "examples", name);
export const exampleText = (name: string) => readFileSync(examplePath(name), "utf8");
