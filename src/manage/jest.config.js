// SPDX-License-Identifier: AGPL-3.0-or-later
// Modifications © 2026 Michael Maurizi Jr.

module.exports = {
  preset: "ts-jest",
  testEnvironment: "node",
  // Only look in specific source directory relative to this one where tests live.
  // This prevents finding the same tests in src/manage/lib/ where they are repeated.
  // See also: https://github.com/facebook/jest/issues/8226#issuecomment-578187397
  rootDir: process.env.PWD + "/src",
  // src/shared/*.ts imports cloud-topo but lives outside the manage package, so
  // Node's resolver can't find it. Mirror the tsconfig "paths" entry here.
  moduleNameMapper: {
    "^cloud-topo$": "<rootDir>/../node_modules/cloud-topo/dist/index.js",
    "^cloud-topo/encode$": "<rootDir>/../node_modules/cloud-topo/dist/encode.js"
  },
  transform: {
    "^.+\\.tsx?$": "ts-jest",
    // cloud-topo ships as ESM and (>= 0.2.0) references `import.meta`; this
    // transpiles its .js to CommonJS and neutralizes the leftover import.meta
    // so ts-jest's CJS test runtime can require() it. See the transformer file.
    "cloud-topo/.+\\.js$": require.resolve("./cloud-topo-jest-transform.js")
  },
  transformIgnorePatterns: ["/node_modules/(?!cloud-topo/)"]
};
