import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts", "src/react.tsx"],
  format: ["cjs", "esm"],
  dts: true,
  clean: true,
  sourcemap: true,
  target: "es2020",
  treeshake: true,
  splitting: false,
  outExtension({ format }) {
    return { js: format === "esm" ? ".mjs" : ".js" };
  },
});
