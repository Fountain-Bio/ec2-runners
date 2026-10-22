// Vite+ configuration for the Lambda code: `vp pack` bundles it, `vp test`
// runs the tests, and `vp check` formats, lints, and type-checks.
import { defineConfig } from "vite-plus";

export default defineConfig({
  // Bundles src/index.ts, which exports all three handlers, into one ESM file
  // that template.yaml uses as the code for every function. The Lambda runtime
  // has no node_modules, so every dependency, including the AWS SDK clients,
  // goes into the bundle.
  pack: {
    entry: { index: "src/index.ts" },
    platform: "node",
    format: "esm",
    outDir: ".build/lambda",
    fixedExtension: true,
    dts: false,
    // Keeps identifier names, so stack traces in the Lambda logs stay readable.
    minify: { compress: true, mangle: false, codegen: { removeWhitespace: true } },
    deps: { alwaysBundle: [/.*/], onlyBundle: false },
  },
  // Oxfmt settings. The width keeps the long lines the code already used.
  // Markdown keeps its hand-written layout, since Oxfmt pads tables to the
  // widest cell.
  fmt: { printWidth: 150, ignorePatterns: ["**/*.md"] },
  // Type-checks with tsconfig.json as part of `vp check`.
  lint: {
    ignorePatterns: [".build/**"],
    options: { typeAware: true, typeCheck: true },
  },
  test: {
    // The integration tests start DynamoDB Local in Docker, so `vp test` skips
    // them. `bun run test:integration` sets INTEGRATION to run only them.
    include: process.env.INTEGRATION ? ["test/integration/*.integration.ts"] : ["test/*.test.ts"],
  },
});
