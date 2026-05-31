import { defineConfig } from "tsup";

// Bundles the internal eval engine and schema packages into the published
// output (they're not on npm yet). Sourcemaps are disabled so consumers
// don't get back the original comments or internal package paths.
export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm", "cjs"],
  dts: true,
  sourcemap: false,
  clean: true,
  target: "es2020",
  treeshake: true,
  splitting: false,
  minify: false,
  noExternal: ["@feathq/datafile-schema", "@feathq/feat-eval"],
});
