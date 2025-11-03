// Flat ESLint config for ESLint v9+
import js from "@eslint/js";
import globals from "globals";
import tseslint from "@typescript-eslint/eslint-plugin";
import tsparser from "@typescript-eslint/parser";
import react from "eslint-plugin-react";
import reactHooks from "eslint-plugin-react-hooks";
import prettier from "eslint-config-prettier";

export default [
  {
    ignores: [
      "dist/**",
      "node_modules/**",
      "coverage/**",
      "**/*.config.js",
      "**/*.config.cjs",
      "**/*.config.mjs",
      "**/*.config.ts",
      "vite.config.ts",
    ],
  },
  js.configs.recommended,
  {
    files: ["**/*.{ts,tsx}", "**/*.ts", "**/*.tsx"],
    languageOptions: {
      parser: tsparser,
      ecmaVersion: 2021,
      sourceType: "module",
      globals: {
        ...globals.browser,
        ...globals.node,
        __REPO_ROOT__: "readonly",
        __PUBLIC_BASE__: "readonly",
      },
    },
    plugins: {
      "@typescript-eslint": tseslint,
      react,
      "react-hooks": reactHooks,
    },
    rules: {
      ...react.configs.recommended.rules,
      ...tseslint.configs.recommended.rules,
      ...reactHooks.configs.recommended.rules,

      // Project-specific rules
      // TypeScript handles undefined names, and type-only names shouldn't trigger no-undef
      "no-undef": "off",
      "react/react-in-jsx-scope": "off",
      "@typescript-eslint/ban-ts-comment": ["warn", { "ts-ignore": "allow-with-description" }],
      "@typescript-eslint/no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-non-null-assertion": "off",
    },
    settings: {
      react: { version: "detect" },
    },
  },
  prettier,
];
