import { defineConfig } from "vite-plus";

export default defineConfig({
  pack: {
    entry: ["src/cli/main.ts"],
    outDir: "dist",
    format: "esm",
    outExtensions: () => ({ js: ".mjs" }),
    deps: {
      alwaysBundle: [/.*/],
      onlyBundle: [
        "ansi-regex",
        "cli-table3",
        "commander",
        "emoji-regex",
        "get-east-asian-width",
        "is-fullwidth-code-point",
        "picocolors",
        "string-width",
        "strip-ansi",
        "yaml",
      ],
      onlyImport: [],
    },
  },
  lint: {
    options: { typeAware: true, typeCheck: true },
  },
  test: {
    include: ["test/**/*.test.ts"],
    // These tests exercise fsync/rename and child processes.
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
  fmt: {
    printWidth: 120,
    sortImports: {
      groups: [["builtin", "external"], "internal", ["parent", "sibling", "index"], "unknown"],
    },
  },
});
