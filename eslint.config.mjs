// SPDX-License-Identifier: AGPL-3.0-or-later
// © 2026 Michael Maurizi Jr.

import eslint from "@eslint/js";
import tseslint from "typescript-eslint";
import prettier from "eslint-config-prettier";
import functional from "eslint-plugin-functional";
import importPlugin from "eslint-plugin-import";
import jsdoc from "eslint-plugin-jsdoc";
import preferArrow from "eslint-plugin-prefer-arrow";
import react from "eslint-plugin-react";
import prettierPlugin from "eslint-plugin-prettier";
import headers from "eslint-plugin-headers";
import { readFileSync, existsSync } from "node:fs";
import { execSync } from "node:child_process";

// Fork-touched files: read a precomputed snapshot (scripts/precompute-fork-files
// writes one into each package dir so Docker containers don't need git), or
// fall back to running git directly when on a host with the repo checked out.
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

const forkFiles = forkTouched.filter(
  (f) => !f.startsWith("src/server/") && !f.startsWith("src/manage/")
);

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
  {
    files: ["src/**/*.{ts,tsx}"],
    ignores: ["src/server/**", "src/manage/**"],
    extends: [
      eslint.configs.recommended,
      ...tseslint.configs.recommendedTypeChecked,
      functional.configs.externalVanillaRecommended,
      react.configs.flat.recommended,
      prettier
    ],
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
      react,
      prettier: prettierPlugin
    },
    settings: {
      react: {
        version: "detect"
      }
    },
    rules: {
      "no-unused-expressions": "off",
      "@typescript-eslint/no-unused-expressions": [
        "error",
        {
          allowShortCircuit: true,
          allowTernary: true
        }
      ],
      "no-console": ["error"],
      "react/display-name": "off",
      "react/react-in-jsx-scope": "off",
      "react/no-unknown-property": ["error", { ignore: ["sx", "css"] }],
      "@typescript-eslint/ban-ts-comment": "off",
      // "@typescript-eslint/explicit-function-return-type": "off",
      // "@typescript-eslint/explicit-module-boundary-types": "off",
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-call": "off",
      "@typescript-eslint/no-unsafe-member-access": "off",
      "@typescript-eslint/no-unsafe-enum-comparison": "off",
      "@typescript-eslint/no-empty-object-type": "off",
      "@typescript-eslint/no-misused-promises": "off",
      "@typescript-eslint/prefer-promise-reject-errors": "off",
      "@typescript-eslint/restrict-template-expressions": "off",
      "@typescript-eslint/no-floating-promises": "off",
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
      "@typescript-eslint/consistent-type-imports": [
        "error",
        { prefer: "type-imports", fixStyle: "inline-type-imports" }
      ],
      "functional/functional-parameters": "off",
      // "functional/no-conditional-statements": "off",
      // "functional/no-expression-statements": "off",
      // "functional/no-return-void": "off",
      // "@typescript-eslint/prefer-readonly-parameter-types": "off",
      "@typescript-eslint/no-unsafe-argument": "off",
      "prettier/prettier": "error"
    }
  },
  {
    // Stragglers: TS files outside src/ need the TS parser, but no
    // type-aware rules (they're not in tsconfig.json).
    files: ["*.ts", "data-import/**/*.ts"],
    languageOptions: {
      parser: tseslint.parser
    }
  },
  {
    files: forkFiles,
    ignores: ["src/shared/password-validator/difflib.ts"],
    plugins: { headers },
    rules: { "headers/header-format": ["error", licenseHeaderConfig] }
  }
);
