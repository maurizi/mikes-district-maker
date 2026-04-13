import eslint from "@eslint/js";
import tseslint from "typescript-eslint";
import prettier from "eslint-config-prettier";
import functional from "eslint-plugin-functional";
import importPlugin from "eslint-plugin-import";
import jsdoc from "eslint-plugin-jsdoc";
import preferArrow from "eslint-plugin-prefer-arrow";
import react from "eslint-plugin-react";
import prettierPlugin from "eslint-plugin-prettier";

export default tseslint.config(
  eslint.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  functional.configs.externalVanillaRecommended,
  react.configs.flat.recommended,
  prettier,
  {
    files: ["src/**/*.{ts,tsx}"],
    ignores: ["src/server/**", "src/manage/**"],
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
      "functional/functional-parameters": "off",
      // "functional/no-conditional-statements": "off",
      // "functional/no-expression-statements": "off",
      // "functional/no-return-void": "off",
      // "@typescript-eslint/prefer-readonly-parameter-types": "off",
      "@typescript-eslint/no-unsafe-argument": "off",
      "prettier/prettier": "error"
    }
  }
);
