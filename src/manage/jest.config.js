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
    // cloud-topo ships as ESM; transpile its .js to CommonJS so ts-jest's CJS
    // test runtime can require() it.
    "cloud-topo/.+\\.js$": [
      "ts-jest",
      {
        tsconfig: {
          allowJs: true,
          module: "commonjs",
          target: "es2022",
          esModuleInterop: true,
          isolatedModules: true
        }
      }
    ]
  },
  transformIgnorePatterns: ["/node_modules/(?!cloud-topo/)"]
};
