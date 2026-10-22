import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// ESLint and the transitive `globals` package live in the npx cache, not in
// this repo. Walk up from this file and from the running CLI until both
// packages are found, so `npx --yes eslint@9.39.5` works without
// devDependencies or a lockfile.
function requireEslintPackages() {
  const seeds = [fileURLToPath(import.meta.url)];
  for (const arg of process.argv) {
    if (typeof arg === "string" && arg.length > 0) seeds.push(arg);
  }
  const seen = new Set();
  for (const seed of seeds) {
    let dir = dirname(seed);
    while (!seen.has(dir)) {
      seen.add(dir);
      const eslintPkg = join(dir, "node_modules", "@eslint", "js", "package.json");
      const globalsPkg = join(dir, "node_modules", "globals", "package.json");
      if (existsSync(eslintPkg) && existsSync(globalsPkg)) {
        return createRequire(eslintPkg);
      }
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  throw new Error(
    "Could not resolve @eslint/js and globals. Run npx --yes eslint@9.39.5.",
  );
}

const require = requireEslintPackages();
const js = require("@eslint/js");
const globals = require("globals");

export default [
  {
    ignores: ["node_modules/**", "public/fonts/**", "native/.cache/**", "relay/node_modules/**"],
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
    files: ["server.mjs", "*-test.mjs", "eslint.config.js", ".github/**/*.mjs", "relay/**/*.mjs"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: { ...globals.node, WebSocket: "readonly" },
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
