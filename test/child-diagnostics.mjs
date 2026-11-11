// sync-path-flake-ticket: complete safe diagnostics, never command-line metadata.
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

const home = mkdtempSync(path.join(os.tmpdir(), "aidanos-child-home-"));
const fixtureKeys = new Set([
  "PATH", "PORT", "TZ", "NODE_ENV", "K_SERVICE", "LANG", "LC_ALL",
  "AIDANOS_VAULT", "AIDANOS_VAULT_CLONE", "AIDANOS_VAULT_GIT_URL", "AIDANOS_VAULT_GIT_TOKEN", "GITHUB_TOKEN",
  "AIDANOS_VAULT_GIT_RETRY_MS", "AIDANOS_VAULT_GIT_SYNC_MS", "AIDANOS_VAULT_GIT_DEBOUNCE_MS",
  "AIDANOS_TEST_HOLD_RENAME", "AIDANOS_TEST_HOLD_WRITE",
]);
export function fixtureEnv(extra = {}, runtime = process.env) {
  // Inherit runtime locations only, NEVER tokens, private-key paths, proxy,
  // NODE_OPTIONS, credential helpers, or arbitrary ambient configuration.
  const env = { PATH: runtime.PATH || "/usr/bin:/bin", HOME: home, TMPDIR: os.tmpdir(),
    GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0",
    AIDANOS_VAULT_GIT_TOKEN: "", GITHUB_TOKEN: "" };
  for (const [key, value] of Object.entries(extra)) {
    if (value != null && (fixtureKeys.has(key) || /^GIT_(?:DIR|COMMON_DIR|WORK_TREE|CONFIG_(?:COUNT|PARAMETERS|KEY_\d+|VALUE_\d+)|GLOB_PATHSPECS|LITERAL_PATHSPECS)$/.test(key))) env[key] = String(value);
  }
  env.AIDANOS_HOST = "127.0.0.1";
  return env;
}

// Standalone best-effort masking for explicit synthetic inputs only. Capture does
// not rely on regexes: it omits bodies, including every unfinished token prefix.
export function redactChildLog(value, secrets = []) {
  let out = String(value);
  const mask = (text) => "*".repeat(text.length);
  for (const secret of secrets.filter((s) => typeof s === "string" && s.length > 0)) {
    for (const needle of new Set([secret, encodeURIComponent(secret)])) {
      out = out.split(needle).join(mask(needle));
      // Do not reveal even a partial known value when a caller reads mid-chunk.
      for (let n = Math.min(needle.length - 1, out.length); n > 0; n -= 1) {
        if (out.endsWith(needle.slice(0, n))) { out = out.slice(0, -n) + mask(out.slice(-n)); break; }
      }
    }
  }
  for (const pattern of [
    /\b(?:authorization|proxy-authorization)\s*[:=]\s*[^\r\n]*/gi,
    /\bBearer\s+[^\s]+/gi,
    /\b(?:github_pat_[A-Za-z0-9_]+|gh[a-z0-9]*_[A-Za-z0-9_-]+)/gi,
    /\bsk-[A-Za-z0-9_-]+/gi,
    /(?<![A-Za-z0-9])[A-Fa-f0-9]{32,}(?![A-Za-z0-9])/g,
    /(?<![A-Za-z0-9+/_=-])[A-Za-z0-9+/]{40,}={0,2}(?![A-Za-z0-9+/_=-])/g,
    /(?<![A-Za-z0-9_-])[A-Za-z0-9_-]{40,}(?![A-Za-z0-9_-])/g,
    /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)?/g,
    /-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?(?:-----END [^-]*PRIVATE KEY-----|$)/g,
    /(?:https?|wss?):\/\/[^\s/@]+:[^\s/@]+@/gi,
  ]) out = out.replace(pattern, mask);
  return out;
}

// Only these finite schemas may become diagnostics. Child bytes are NEVER stored.
const operations = ["write", "read", "rename", "git", "open", "stat", "unlink", "mkdir"];
const errorCodes = ["EACCES", "EPERM", "EISDIR", "ENOTDIR", "ENOENT", "EIO", "ELOOP", "ENOSPC", "EROFS", "PARENT", "ERROR"];
const warningKeys = ["credential.helper", "http.extraheader", "core.askpass", "core.fsmonitor", "core.hookspath", "core.sshcommand", "include.path"].sort();
function allowedDiagnostics(fields = {}) {
  const lines = [];
  const add = (summary, marker, fields = {}) => lines.push(Object.freeze({ summary, marker, ...fields }));
  for (const marker of ["stopped:", "sync paused:"]) for (const operation of operations) for (const code of errorCodes) {
    add(marker + " " + operation + " " + code, marker, { operation, code });
  }
  for (let bits = 1; bits < 2 ** warningKeys.length; bits += 1) {
    const keys = warningKeys.filter((_key, index) => bits & (1 << index));
    add("vault git config: " + keys.join(", "), "git-config-warning", { keys: Object.freeze(keys) });
  }
  add("Point AIDANOS_VAULT at the real folder.", "configured-vault-refused");
  // These values come from explicit public fixture inputs, NEVER child text.
  const configured = fields.configuredVault;
  if (typeof configured === "string" && configured.startsWith(os.tmpdir() + path.sep) && !/[\r\n]/.test(configured) && redactChildLog(configured) === configured) {
    add(configured, "configured-vault", { configuredVault: configured });
  }
  for (const relative of fields.symlinkPaths || []) {
    if (typeof relative !== "string" || !/^(?:(notes|log|aidanos)\/[A-Za-z0-9?._/-]+|extra)$/.test(relative) || relative.includes("..") || redactChildLog(relative) !== relative) throw new TypeError("Invalid public fixture path");
    add("skipped symlink: " + relative, "skipped-symlink", { relativePath: relative });
  }
  return lines;
}
export function captureChildLog(child, context = {}) {
  const schema = allowedDiagnostics(context?.fields), records = [];
  const symlinks = (context?.fields?.symlinkPaths || []).slice();
  const secrets = Array.isArray(context?.secrets) ? context.secrets.filter((value) => typeof value === "string" && value.length) : [];
  const clean = (value) => typeof value === "string" ? redactChildLog(value, secrets) : Array.isArray(value) ? value.map(clean) : value;
  const retain = (record) => records.push(Object.freeze(Object.fromEntries(Object.entries(record).map(([key, value]) => [key, clean(value)]))));
  for (const name of ["stdout", "stderr"]) {
    // The incremental matcher retains candidate IDs/position only, not a line,
    // prefix, chunk, or arbitrary child byte. No partial match is ever exposed.
    let matches = schema, position = 0, carriage = false;
    const prefix = "skipped symlink: ";
    let prefixAt = 0, pathAt = 0, pathMatches = symlinks, chosen = [], separator = false, rejected = false;
    const resetPaths = () => { prefixAt = 0; pathAt = 0; pathMatches = symlinks; chosen = []; separator = false; rejected = false; };
    const finishPath = () => pathMatches.find((value) => value.length === pathAt);
    child[name].on("data", (chunk) => {
      for (const char of String(chunk)) {
        if (char === "\n") {
          const record = matches?.find((entry) => entry.summary.length === position);
          if (record) retain({ stream: name, ...record });
          if (!record && !rejected && prefixAt === prefix.length && !separator) {
            const last = finishPath();
            if (last) { const paths = [...chosen, last]; retain({ stream: name, marker: "skipped-symlink", paths: Object.freeze(paths), summary: prefix + paths.join(", ") }); }
          }
          resetPaths(); matches = schema; position = 0; carriage = false;
        } else if (char === "\r" && !carriage) {
          carriage = true;
        } else {
          if (!rejected) {
            if (prefixAt < prefix.length) { if (char === prefix[prefixAt]) prefixAt += 1; else rejected = true; }
            else if (separator) { if (char === " ") { separator = false; pathAt = 0; pathMatches = symlinks; } else rejected = true; }
            else if (char === ",") { const matched = finishPath(); if (matched && chosen.length < 64) { chosen.push(matched); separator = true; } else rejected = true; }
            else { pathMatches = pathMatches.filter((value) => value[pathAt] === char); pathAt += 1; if (!pathMatches.length) rejected = true; }
          }
          matches = carriage ? null : matches?.filter((entry) => entry.summary[position] === char);
          if (!matches?.length) matches = null;
          position += 1;
        }
      }
    });
  }
  child._diagnostics = () => records.map((record) => ({ ...record }));
  child._redact = () => "[unstructured child text omitted]";
  child._log = () => {
    const lines = records.map((record) => record.summary);
    if (Number.isInteger(child.exitCode) && child.exitCode >= 0 && child.exitCode <= 255) lines.push("server exited " + child.exitCode);
    if (["SIGTERM", "SIGKILL", "SIGINT", "SIGABRT", "SIGHUP", "SIGSEGV"].includes(child.signalCode)) lines.push("child signal " + child.signalCode);
    return lines.length ? lines.join("\n") + "\n" : "";
  };
  return child;
}
export function spawnWithLog(command, args, options = {}) {
  const { fixtureSecrets = [], fixtureDiagnostics = {}, ...spawnOptions } = options;
  if (!Array.isArray(fixtureSecrets) || fixtureSecrets.some((value) => typeof value !== "string")) throw new TypeError("Invalid fixture secret registry");
  const env = fixtureEnv(spawnOptions.env);
  // Registry/fixtureOnly flags never enable bodies. Only typed public fields do.
  const fields = { ...fixtureDiagnostics, configuredVault: env.AIDANOS_VAULT || env.AIDANOS_VAULT_CLONE };
  allowedDiagnostics(fields); // Validate before spawning; never orphan a child.
  return captureChildLog(spawn(command, args, { ...spawnOptions, env }), { fields, secrets: fixtureSecrets });
}
export function childStartupError(child) {
  const log = typeof child._diagnostics === "function" ? child._log() : "";
  return new Error("child startup failed; structured diagnostics only:\n" + (log || "(no child output captured)"));
}
