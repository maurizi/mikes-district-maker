import eslint from "@eslint/js";
import tseslint from "typescript-eslint";
import prettier from "eslint-config-prettier";
import functional from "eslint-plugin-functional";
import importPlugin from "eslint-plugin-import";
import jsdoc from "eslint-plugin-jsdoc";
import preferArrow from "eslint-plugin-prefer-arrow";
import prettierPlugin from "eslint-plugin-prettier";
import localRules from "eslint-plugin-local-rules";

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
  }
);
