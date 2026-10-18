import { createRequire } from "node:module";

// ESLint and the transitive `globals` package live in the npx cache.
// Resolve them from the ESLint binary so CI can run
// `npx --yes eslint@9.39.5` without devDependencies or a lockfile.
const require = createRequire(process.argv[1]);
const js = require("@eslint/js");
const globals = require("globals");

export default [
  {
    ignores: ["node_modules/**", "public/fonts/**"],
  },
  js.configs.recommended,
  {
    files: ["app.js", "sw.js", "design-system/**/*.js", "design-system/**/*.mjs"],
    languageOptions: {
      ecmaVersion: "latest",
      globals: globals.browser,
    },
  },
  {
    files: ["server.mjs", "*-test.mjs", "eslint.config.js", ".github/**/*.mjs"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: globals.node,
    },
  },
  {
    files: ["**/*.js", "**/*.mjs"],
    rules: {
      // Empty catches are how this code swallows expected failures
      // (storage, abort, fetch retry, git kill, unlink). Other empty
      // blocks still fail.
      "no-empty": ["error", { allowEmptyCatch: true }],
      // Catch bindings are often unused because the catch only swallows.
      // The five names are top-level helpers left in app.js on purpose:
      // readPaper is the slice boundary in paper-task-source-test.mjs
      // (grabFn("serializeLine", "readPaper")), and the other four are
      // unused helpers kept so app.js is not refactored.
      "no-unused-vars": [
        "error",
        {
          caughtErrors: "none",
          varsIgnorePattern:
            "^(energyLabel|readPaper|syncDumpFromPaper|askKicker|pointInSelection)$",
        },
      ],
      // paper-task-source-test.mjs embeds a raw U+200B in two regexes,
      // next to the \u200b escape, to match the zero-width caret host.
      "no-irregular-whitespace": ["error", { skipRegExps: true }],
    },
  },
];
