// SPDX-License-Identifier: AGPL-3.0-or-later
// © 2026 Michael Maurizi Jr.

// Jest transformer for cloud-topo's shipped ESM (.js) files.
//
// cloud-topo >= 0.2.0 spawns its worker via `new Worker(new URL(..., import.meta.url))`.
// ts-jest transpiles the module to CommonJS for Jest's CJS test runtime but, by
// design, leaves `import.meta` verbatim (it has no CJS equivalent), so the file
// then throws "Cannot use 'import.meta' outside a module" when the VM parses it.
//
// The worker-spawn path never runs under Jest — our tests only pull cloud-topo
// in transitively for types and pure functions — so we delegate to ts-jest and
// then rewrite the dead `import.meta` references to a benign CJS expression.
const tsJest = require("ts-jest").default;

const inner = tsJest.createTransformer({
  tsconfig: {
    allowJs: true,
    module: "commonjs",
    target: "es2022",
    esModuleInterop: true,
    isolatedModules: true
  }
});

function neutralize(code) {
  return code.replace(/import\.meta/g, "({ url: require('url').pathToFileURL(__filename).href })");
}

module.exports = {
  process(src, path, options) {
    const out = inner.process(src, path, options);
    return { ...out, code: neutralize(out.code) };
  },
  getCacheKey(src, path, options) {
    return inner.getCacheKey(src, path, options) + "-import-meta-v1";
  }
};
