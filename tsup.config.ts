import { defineConfig } from "tsup";

// Bundles @feathq/feat-eval and @feathq/datafile-schema into the published
// output. They're not on npm yet (private workspace deps); once they are,
// move them to `external` and add as real dependencies.
export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm", "cjs"],
  dts: true,
  sourcemap: true,
  clean: true,
  target: "es2020",
  treeshake: true,
  splitting: false,
  minify: false,
});
