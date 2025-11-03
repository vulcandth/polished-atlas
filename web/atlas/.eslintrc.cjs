/* eslint-env node */
module.exports = {
  root: true,
  env: {
    browser: true,
    es2021: true,
    node: true,
  },
  parser: "@typescript-eslint/parser",
  parserOptions: {
    ecmaVersion: 2021,
    sourceType: "module",
    ecmaFeatures: { jsx: true },
  },
  plugins: ["@typescript-eslint", "react", "react-hooks"],
  extends: [
    "eslint:recommended",
    "plugin:@typescript-eslint/recommended",
    "plugin:react/recommended",
    "plugin:react-hooks/recommended",
    "prettier",
  ],
  settings: {
    react: {
      version: "detect",
    },
  },
  ignorePatterns: ["dist/", "node_modules/", "vite.config.ts"],
  rules: {
    // Keep TS strict but ergonomic
    "@typescript-eslint/ban-ts-comment": ["warn", { "ts-ignore": "allow-with-description" }],
    "@typescript-eslint/no-unused-vars": [
      "warn",
      { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
    ],
    // PIXI/react interop often uses any in event payloads
    "@typescript-eslint/no-explicit-any": "off",
    // Our codebase frequently uses non-null assertions for resources
    "@typescript-eslint/no-non-null-assertion": "off",
    // React
    "react/react-in-jsx-scope": "off",
  },
  overrides: [
    {
      files: ["**/*.ts", "**/*.tsx"],
      parser: "@typescript-eslint/parser",
      parserOptions: {
        ecmaVersion: 2021,
        sourceType: "module",
        ecmaFeatures: { jsx: true },
        // Don't require type-aware linting by default; keeps it fast and simple
      },
    },
  ],
};
