import js from "@eslint/js";
import globals from "globals";
import n from "eslint-plugin-n";

export default [
  // ── Base: all JS rules (strictest possible) ──────────────────────────────
  {
    ...js.configs.all,
    files: ["**/*.mjs", "**/*.js"],
  },

  // ── Node.js plugin (flat/all = every node rule on) ───────────────────────
  {
    ...n.configs["flat/all"],
    files: ["**/*.mjs", "**/*.js"],
  },

  // ── Project-wide settings + rule overrides ────────────────────────────────
  {
    files: ["**/*.mjs", "**/*.js"],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: "module",
      globals: {
        ...globals.node,
      },
    },
    settings: {
      node: { version: ">=18" },
    },
    rules: {
      // ── Category A: disabled — wrong for this project ─────────────────────

      // Cosmetic / stylistic — not bugs
      "sort-keys": "off",
      "curly": "off",
      "one-var": "off",
      "sort-imports": "off",
      "sort-vars": "off",
      "no-ternary": "off",
      "no-nested-ternary": "off",
      "multiline-comment-style": "off",
      "capitalized-comments": "off",
      "line-comment-position": "off",
      "func-style": "off",
      "no-inline-comments": "off",
      "id-length": "off",
      "max-lines": "off",
      "max-lines-per-function": "off",
      "max-statements": "off",
      "max-params": "off",
      "max-depth": "off",
      "complexity": "off",
      "no-magic-numbers": "off",
      "prefer-named-capture-group": "off",
      "no-continue": "off",
      "no-plusplus": "off",
      "no-negated-condition": "off",
      "no-bitwise": "off",
      "no-underscore-dangle": "off",

      // Conflicts with ESM / project patterns
      "no-undefined": "off",
      "no-void": "off",
      "init-declarations": "off",
      "no-await-in-loop": "off",
      "no-promise-executor-return": "off",

      // n plugin — wrong for this project
      "n/no-sync": "off",             // CLI tool: sync I/O is intentional
      "n/no-process-env": "off",      // normal for Node CLI tools
      "n/no-process-exit": "off",     // CLI tool: process.exit is intentional
      "n/no-top-level-await": "off",  // intentional in some scripts
      "n/prefer-global/process": "off",
      "n/prefer-global/url": "off",
      "n/no-missing-import": "off",   // local .mjs imports resolve at runtime
      "n/no-unpublished-import": "off",
      "n/no-unsupported-features/es-syntax": "off",
      "n/no-unsupported-features/node-builtins": "off", // targeting node >=18

      // eq-null is fully covered by eqeqeq
      "no-eq-null": "off",
      "require-unicode-regexp": "off",  // overly pedantic for non-i18n code

      // ── Errors → warnings: intentional use throughout CLI ─────────────────
      "no-console": "warn",

      // ── Rules the codebase must satisfy ──────────────────────────────────
      "no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
      "no-undef": "error",
      "eqeqeq": ["error", "always", { "null": "ignore" }],  // allow == null / != null (checks undefined too)
      "prefer-const": "error",
      "no-var": "error",
      "no-duplicate-imports": "error",
      "camelcase": ["error", { properties: "never" }],  // allow snake_case as object property keys (external protocol)
      "no-shadow": "error",
      "no-use-before-define": ["error", { functions: false, classes: true, variables: true }],
      "prefer-template": "error",
      // Require object destructuring in declarations; skip array (arr[0] patterns are fine)
      "prefer-destructuring": ["error", {
        VariableDeclarator: { array: false, object: true },
        AssignmentExpression: { array: false, object: false },
      }],
      "object-shorthand": "error",
      "no-param-reassign": "error",
      "no-implicit-coercion": "error",
      "no-lonely-if": "error",
      "no-else-return": "error",
      "consistent-return": "error",
      "default-case": "error",
      "guard-for-in": "error",
      "no-eval": "error",
      "no-implied-eval": "error",
      "no-new-func": "error",
      "no-return-assign": "error",
      "no-self-compare": "error",
      "no-sequences": "error",
      "no-throw-literal": "error",
      "no-useless-concat": "error",
      "no-useless-return": "error",
      "require-await": "error",
      "yoda": "error",
      "prefer-rest-params": "error",
      "prefer-spread": "error",
      "symbol-description": "error",
      "no-useless-assignment": "error",
      "preserve-caught-error": "error",
      "require-atomic-updates": "error",
      "logical-assignment-operators": "error",

      "n/prefer-node-protocol": "error",
    },
  },

  // ── Test files: relax rules that clash with test patterns ─────────────────
  {
    files: ["tests/**/*.mjs"],
    rules: {
      "no-console": "off",
      "max-nested-callbacks": "off",
      "no-loop-func": "off",
    },
  },

  // ── Ignore node_modules ───────────────────────────────────────────────────
  {
    ignores: ["node_modules/**"],
  },
];
