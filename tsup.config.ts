import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts", "src/cli.ts"],
  format: ["esm"],
  platform: "node",
  target: "node22",
  clean: true,
  sourcemap: true,
  splitting: true,
  removeNodeProtocol: false,
  external: ["node:sqlite"],
  esbuildOptions(options) {
    options.supported = {
      ...options.supported,
      "node-colon-prefix-import": true,
      "node-colon-prefix-require": true,
    };
  },
  banner: { js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);" },
});
