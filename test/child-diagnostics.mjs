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
    GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: "/bin/false",
    AIDANOS_VAULT_GIT_TOKEN: "", GITHUB_TOKEN: "" };
  for (const [key, value] of Object.entries(extra)) {
    if (value != null && (fixtureKeys.has(key) || /^GIT_(?:DIR|COMMON_DIR|WORK_TREE|CONFIG_(?:COUNT|PARAMETERS|KEY_\d+|VALUE_\d+)|GLOB_PATHSPECS|LITERAL_PATHSPECS)$/.test(key))) env[key] = String(value);
  }
  env.AIDANOS_HOST = "127.0.0.1";
  return env;
}

// Same-length masks preserve incremental _log().slice(previousLength) callers.
// Reprocess COMPLETE per-stream buffers so tokens split/interleaved across chunks
// cannot bypass redaction, and never expose those raw buffers through the API.
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
    /\b(?:github_pat_[A-Za-z0-9_]+|gh[pousr]_[A-Za-z0-9]+)/g,
    /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)?/g,
    /-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?(?:-----END [^-]*PRIVATE KEY-----|$)/g,
    /(?:https?|wss?):\/\/[^\s/@]+:[^\s/@]+@/gi,
  ]) out = out.replace(pattern, mask);
  return out;
}

export function captureChildLog(child, { secrets = [] } = {}) {
  const streams = { stdout: "", stderr: "" }, events = [];
  for (const name of ["stdout", "stderr"]) child[name].on("data", (chunk) => {
    const text = String(chunk), offset = streams[name].length;
    streams[name] += text; events.push({ name, offset, length: text.length });
  });
  child._redact = (text) => redactChildLog(text, secrets);
  child._log = () => {
    const safe = Object.fromEntries(Object.entries(streams).map(([key, text]) => [key, child._redact(text)]));
    return child._redact(events.map(({ name, offset, length }) => safe[name].slice(offset, offset + length)).join(""));
  };
  return child;
}

export function spawnWithLog(command, args, options = {}) {
  const env = fixtureEnv(options.env);
  const secrets = Object.entries(env).filter(([name]) => /TOKEN|SECRET|PASSWORD/.test(name)).map(([, value]) => value);
  return captureChildLog(spawn(command, args, { ...options, env }), { secrets });
}

export function childStartupError(child, message) {
  const safe = child._redact || redactChildLog;
  const log = safe(child._log());
  return new Error(safe(message) + "\nchild stdout/stderr (secrets redacted):\n" + (log || "(no child output captured)"));
}
