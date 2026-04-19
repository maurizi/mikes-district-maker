// SPDX-License-Identifier: AGPL-3.0-or-later
// © 2026 Michael Maurizi Jr.

import eslint from "@eslint/js";
import tseslint from "typescript-eslint";
import prettier from "eslint-config-prettier";
import functional from "eslint-plugin-functional";
import importPlugin from "eslint-plugin-import";
import jsdoc from "eslint-plugin-jsdoc";
import preferArrow from "eslint-plugin-prefer-arrow";
import prettierPlugin from "eslint-plugin-prettier";
import localRules from "eslint-plugin-local-rules";
import headers from "eslint-plugin-headers";
import { readFileSync, existsSync } from "node:fs";
import { execSync } from "node:child_process";

// See eslint.config.mjs at repo root for the precompute rationale.
const forkTouched = (() => {
  const raw = existsSync("fork-touched-files.txt")
    ? readFileSync("fork-touched-files.txt", "utf8")
    : execSync(
        "{ git diff --name-only --diff-filter=d 1.19.2...HEAD; git diff --name-only --diff-filter=d HEAD; git ls-files --others --exclude-standard; }",
        { shell: "/bin/sh", encoding: "utf8" }
      );
  return [...new Set(raw.split("\n").filter(Boolean))].filter((f) =>
    /\.(ts|tsx|js|jsx|mjs|cjs)$/.test(f)
  );
})();

const forkFiles = forkTouched
  .filter((f) => f.startsWith("src/server/"))
  .map((f) => f.slice("src/server/".length));

const licenseHeaderConfig = {
  source: "string",
  style: "line",
  content:
    "SPDX-License-Identifier: AGPL-3.0-or-later\n(prefix)© (year) Michael Maurizi Jr.",
  patterns: {
    prefix: { pattern: "(Modifications )?", defaultValue: "" },
    year: { pattern: "\\d{4}(\\s*[-–]\\s*\\d{4})?", defaultValue: "2026" }
  },
  preservePragmas: true,
  trailingNewlines: 2
};

export default tseslint.config(
  eslint.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  functional.configs.externalVanillaRecommended,
  functional.configs.noMutations,
  prettier,
  {
    files: ["src/**/*.ts"],
    languageOptions: {
      parserOptions: {
        project: "tsconfig.json"
      }
    },
    plugins: {
      import: importPlugin,
      jsdoc,
      "prefer-arrow": preferArrow,
      functional,
      prettier: prettierPlugin,
      "local-rules": localRules
    },
    rules: {
      "no-unused-expressions": [
        "error",
        {
          allowShortCircuit: true,
          allowTernary: true
        }
      ],
      "no-console": ["error"],
      "no-restricted-imports": [
        "error",
        {
          patterns: ["src/*"]
        }
      ],
      "@typescript-eslint/ban-ts-comment": "off",
      "@typescript-eslint/explicit-function-return-type": "off",
      "@typescript-eslint/explicit-module-boundary-types": "off",
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unnecessary-type-assertion": "off",
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-call": "off",
      "@typescript-eslint/no-unsafe-member-access": "off",
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
      "@typescript-eslint/consistent-type-imports": [
        "error",
        { prefer: "type-imports", fixStyle: "inline-type-imports" }
      ],
      "@typescript-eslint/prefer-readonly-parameter-types": "off",
      "@typescript-eslint/restrict-template-expressions": "off",
      "@typescript-eslint/no-unsafe-argument": "off",
      "@typescript-eslint/no-unsafe-return": "off",
      "@typescript-eslint/prefer-promise-reject-errors": "off",
      "functional/type-declaration-immutability": "off",
      "functional/immutable-data": [
        "error",
        {
          ignoreIdentifierPattern: "^mutable"
        }
      ],
      "functional/prefer-readonly-type": "off",
      "functional/prefer-immutable-types": "off",
      "functional/no-let": "off",
      "functional/no-loop-statements": "error",
      "functional/no-conditional-statements": "off",
      "local-rules/no-providing-services-out-of-module": "error",
      "prettier/prettier": "error"
    }
  },
  {
    files: forkFiles,
    plugins: { headers },
    rules: { "headers/header-format": ["error", licenseHeaderConfig] }
  }
);
