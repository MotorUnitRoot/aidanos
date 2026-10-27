#!/usr/bin/env node
/**
 * AidanOS — local by default (127.0.0.1). Set AIDANOS_HOST=0.0.0.0 for LAN/phone.
 * Vault: AIDANOS_VAULT, or sibling vault/ beside this server.
 * Optional git: AIDANOS_VAULT_GIT_URL (+ AIDANOS_VAULT_GIT_TOKEN or GITHUB_TOKEN).
 * With a remote, fast-forward before each push and about once a minute.
 * Never rebase, never force-push, and never combine two copies of a file.
 * Same-file divergence keeps both copies until an explicit Keep mine,
 * Take theirs, or Edit. An ordinary save does not resolve that conflict.
 * A choice applies only to the remote blob it was made against. A later
 * edit of that note drops the choice and reopens the conflict.
 * Sync stages only the note paths this app wrote. Those paths stay pending
 * until the push that contains them succeeds, including across a restart.
 * Histories that diverge
 * with no shared file wait for an explicit join. That join re-checks there
 * is still no overlap, then makes a normal merge commit and pushes.
 * If clone/pull cannot populate the checkout, seed the bundled sample vault/
 * (Plan + maps) so the demo still serves. Keep retrying git when possible.
 * On the Mac the vault is the parent (~/Grok/motorunit).
 * Never copy this folder's vault/ over that one.
 */
import http from "node:http";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import os from "node:os";
import { createHash, randomBytes } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { noteSaveStyle, reportRecoveryFiles, writeNoteText } from "./editor/note-save.mjs";
import { ancestorFault, groupWritableHelperMessage, installFaultText } from "./editor/dirfd.mjs";
import { ensureRecoverExcluded, isRecoverPath } from "./editor/vault-exclude.mjs";
import { maskGitHubTokens } from "./relay/src/github-tokens.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const GIT_URL = String(process.env.AIDANOS_VAULT_GIT_URL || "").trim();
const GIT_TOKEN = String(process.env.AIDANOS_VAULT_GIT_TOKEN || process.env.GITHUB_TOKEN || "").trim();
const GIT_DEBOUNCE_MS = (() => {
  const n = Number(process.env.AIDANOS_VAULT_GIT_DEBOUNCE_MS);
  return Number.isFinite(n) && n >= 50 ? Math.min(n, 10_000) : 1500;
})();
const GIT_SYNC_MS = (() => {
  if (!GIT_URL) return 0;
  const raw = process.env.AIDANOS_VAULT_GIT_SYNC_MS;
  if (raw == null || String(raw).trim() === "") return 60_000;
  if (String(raw).trim() === "0") return 0;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 200 ? Math.min(n, 300_000) : 60_000;
})();
function resolveVaultPath() {
  if (process.env.AIDANOS_VAULT) return path.resolve(process.env.AIDANOS_VAULT);
  if (GIT_URL) {
    const clone = String(process.env.AIDANOS_VAULT_CLONE || "").trim();
    return path.resolve(clone || path.join(os.tmpdir(), "aidanos-vault"));
  }
  return path.join(__dirname, "vault");
}
let VAULT = resolveVaultPath();
const BUNDLED_VAULT = path.join(__dirname, "vault");
const GIT_RETRY_MS = (() => {
  const n = Number(process.env.AIDANOS_VAULT_GIT_RETRY_MS);
  if (process.env.AIDANOS_VAULT_GIT_RETRY_MS === "0") return 0;
  return Number.isFinite(n) && n >= 200 ? Math.min(n, 300_000) : 45_000;
})();
const PUBLIC = __dirname;
const PORT_RAW = Number(process.env.PORT);
const PORT = process.env.PORT === "0"
  ? 0
  : Number.isInteger(PORT_RAW) && PORT_RAW > 0 && PORT_RAW < 65536
    ? PORT_RAW
    : 3847;
const HOST = process.env.AIDANOS_HOST || "127.0.0.1";
const DAY_FILE_RE = /^\d{4}-\d{2}-\d{2}\.md$/;
const MTIME_SKEW_MS = 1;
const MAX_BODY = 1_000_000;
const MAX_SSE = 32;
const PUBLIC_FILES = new Set([
  "index.html",
  "app.js",
  "day.css",
  "styles.css",
  "manifest.webmanifest",
  "sw.js",
  "icon-180.png",
  "icon-192.png",
  "apple-touch-icon.png",
  "editor/live-note.mjs",
]);
const lastSelfWrites = new Map();
const pendingSelfWrites = new Set();
const sseClients = new Set();
const vaultGit = {
  enabled: Boolean(GIT_URL),
  ready: false,
  error: "",
  fetchFailed: false,
  lastPushAt: 0,
  pending: new Set(),
  timer: null,
  syncTimer: null,
  syncPaused: false,
  chain: Promise.resolve(),
  conflicts: new Map(),
  notice: "",
  suppressWatch: 0,
  join: false,
  resolvePending: new Set(),
  hold: new Set(),
  choiceAgainst: new Map(),
  left: "",
};

export function authenticatedGitUrl(url, token) {
  const rawUrl = String(url || "").trim();
  const rawToken = String(token || "").trim();
  if (!rawUrl || !rawToken) return rawUrl;
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return rawUrl;
  }
  // Never put the PAT on http:// (or file:/ssh:/path) remotes.
  if (parsed.protocol !== "https:") return rawUrl;
  parsed.username = "x-access-token";
  parsed.password = rawToken;
  return parsed.href;
}

function gitRemoteUrl() {
  return authenticatedGitUrl(GIT_URL, GIT_TOKEN);
}

function tokensToRedact(secrets) {
  const out = new Set();
  const add = (value) => {
    const token = String(value || "").trim();
    if (token) out.add(token);
  };
  add(secrets && secrets.token);
  add(GIT_TOKEN);
  add(process.env.AIDANOS_VAULT_GIT_TOKEN);
  add(process.env.GITHUB_TOKEN);
  return [...out];
}

export function redactSecrets(msg, secrets) {
  const vault = secrets && secrets.vault != null ? String(secrets.vault) : VAULT;
  const url = secrets && secrets.url != null ? String(secrets.url) : GIT_URL;
  const tokens = tokensToRedact(secrets);
  let s = String(msg || "");
  for (const token of tokens) {
    s = s.split(token).join("***");
    const encoded = encodeURIComponent(token);
    if (encoded !== token) s = s.split(encoded).join("***");
  }
  if (vault) s = s.split(vault).join("[vault]");
  if (url) s = s.split(url).join("[url]");
  for (const token of tokens) {
    const auth = authenticatedGitUrl(url, token);
    if (auth && auth !== url) s = s.split(auth).join("[url]");
  }
  s = s.replace(/x-access-token:[^@\s]+/gi, "x-access-token:***");
  s = maskGitHubTokens(s);
  s = s.replace(/https?:\/\/[^\s]+/gi, "[url]");
  s = s.replace(/file:\/\/[^\s]+/gi, "[url]");
  return s;
}

export function sanitizeGitError(msg, secrets) {
  return redactSecrets(msg, secrets).replace(/\s+/g, " ").trim().slice(0, 180) || "git failed";
}

function logSafe(...parts) {
  const text = parts.map((part) => {
    if (part instanceof Error) return redactSecrets(part.stack || part.message || "error");
    return redactSecrets(part);
  }).join(" ");
  console.error(text);
}

function notesStayLocalSentence() {
  const cloud = Boolean(String(process.env.K_SERVICE || "").trim());
  const ownClone = !String(process.env.AIDANOS_VAULT || "").trim() && Boolean(GIT_URL);
  if (cloud || ownClone) {
    return "Sync is paused. Notes are saved on this server only and may be lost if it restarts.";
  }
  return "Sync is paused. Notes are saved on this computer only.";
}

function gitHint() {
  if (!vaultGit.enabled) return { enabled: false };
  const open = [...vaultGit.conflicts.values()].filter((item) => !item.resolved);
  const hint = { enabled: true, ok: !vaultGit.error && !vaultGit.syncPaused && open.length === 0 };
  if (vaultGit.syncPaused) {
    hint.paused = true;
    hint.error = "sync paused";
    hint.localOnly = notesStayLocalSentence();
  } else if (vaultGit.error) hint.error = vaultGit.error;
  if (vaultGit.lastPushAt) hint.pushed = true;
  if (open.length) hint.conflicts = open.map((item) => item.path);
  return hint;
}

export function gitEnv() {
  const env = { ...process.env };
  // Drop every inherited GIT_* name first. A short list misses
  // GIT_CONFIG_PARAMETERS, GIT_COMMON_DIR, and GIT_GLOB_PATHSPECS, and git
  // reads all three. The settings below are applied after that scrub.
  for (const key of Object.keys(env)) {
    if (key.startsWith("GIT_")) delete env[key];
  }
  env.GIT_EDITOR = "true";
  env.GIT_MERGE_AUTOEDIT = "no";
  env.GIT_TERMINAL_PROMPT = "0";
  // Pathspecs stay literal after "--". Otherwise `Q?.md` also matches QA.md.
  env.GIT_LITERAL_PATHSPECS = "1";
  // Repo identity stays in the vault config. Ignore the home and system files.
  env.GIT_CONFIG_GLOBAL = "/dev/null";
  env.GIT_CONFIG_NOSYSTEM = "1";
  return env;
}

function runGit(args, { cwd, timeoutMs = 20000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn("git", [...gitSafetyPrefix(), ...args], {
      cwd: cwd || undefined,
      env: gitEnv(),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (buf) => { out += String(buf); });
    child.stderr.on("data", (buf) => { err += String(buf); });
    const timer = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch {}
      reject(new Error("git timeout"));
    }, timeoutMs);
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      rememberUnlinkLock(err);
      if (code === 0) resolve({ out, err });
      else reject(new Error((err || out || ("git " + args[0] + " failed")).trim()));
    });
  });
}

function gitRemoteKind(url) {
  const u = String(url || "").trim();
  if (!u) return "none";
  if (/^https?:\/\//i.test(u)) return "https";
  if (/^ssh:\/\//i.test(u) || /^[^/\s]+@[^/\s:]+:/.test(u)) return "ssh";
  return "file";
}

function gitSafetyConfigs(cwd) {
  const hooks = path.join(cwd, ".git", "aidanos-no-hooks");
  const pairs = [
    ["core.symlinks", "false"],
    ["core.hooksPath", hooks],
    ["core.fsmonitor", "false"],
    ["protocol.allow", "never"],
    ["protocol.https.allow", "always"],
    // An empty credential helper keeps a helper from replacing the token in the remote URL.
    // ssh stays the plain client. An empty include.path is rejected by git itself, so it is not set.
    ["credential.helper", ""],
    ["core.sshCommand", "ssh"],
  ];
  const kind = gitRemoteKind(GIT_URL);
  if (kind === "ssh") pairs.push(["protocol.ssh.allow", "always"]);
  if (kind === "file") pairs.push(["protocol.file.allow", "always"]);
  return pairs;
}

function gitSafetyPrefix() {
  const args = [];
  for (const [key, value] of gitSafetyConfigs(VAULT)) args.push("-c", key + "=" + value);
  return args;
}

async function ensureGitIdentity(cwd) {
  const name = process.env.AIDANOS_VAULT_GIT_NAME || "AidanOS";
  const email = process.env.AIDANOS_VAULT_GIT_EMAIL || "aidanos@local";
  await runGit(["-C", cwd, "config", "user.name", name], { timeoutMs: 4000 });
  await runGit(["-C", cwd, "config", "user.email", email], { timeoutMs: 4000 });
}

async function localGitValue(cwd, key) {
  try {
    const { out } = await runGit(["-C", cwd, "config", "--local", "--get", key], { timeoutMs: 4000 });
    return String(out || "").trim();
  } catch {
    return "";
  }
}

function sameConfigPath(cwd, value, expected) {
  if (!value) return false;
  const want = path.resolve(expected);
  return path.resolve(value) === want || path.resolve(cwd, value) === want;
}

// Drop the safety keys an older build wrote into the vault config.
// That build is the only one that set core.hooksPath to .git/aidanos-no-hooks.
// Any other hooks path means the remaining keys are the operator's.
async function unsetOldGitSafety(cwd) {
  const hooks = path.join(cwd, ".git", "aidanos-no-hooks");
  const exact = [
    ["core.symlinks", "false"],
    ["core.fsmonitor", "false"],
    ["protocol.allow", "never"],
    ["protocol.https.allow", "always"],
    ["protocol.ssh.allow", "always"],
    ["protocol.file.allow", "always"],
  ];
  try {
    const hooksPath = await localGitValue(cwd, "core.hooksPath");
    if (sameConfigPath(cwd, hooksPath, hooks)) {
      for (const [key, value] of exact) {
        if ((await localGitValue(cwd, key)) !== value) continue;
        await runGit(["-C", cwd, "config", "--local", "--unset", key], { timeoutMs: 4000 }).catch(() => {});
      }
      await runGit(["-C", cwd, "config", "--local", "--unset", "core.hooksPath"], { timeoutMs: 4000 }).catch(() => {});
    }
  } catch {
    // The command-line -c flags still override whatever is left in the file.
  }
  await warnRiskyGitConfig(cwd);
}

function riskyGitKeyLabel(key) {
  const words = [
    ["includeif", "includeIf"],
    ["include", "include"],
    ["credential", "credential"],
    ["sshcommand", "sshCommand"],
    ["askpass", "askpass"],
    ["insteadof", "insteadOf"],
    ["extraheader", "extraheader"],
    ["pager", "pager"],
    ["proxy", "proxy"],
  ];
  const lower = String(key || "").toLowerCase();
  for (const [word, label] of words) {
    if (!lower.includes(word)) continue;
    return /^[A-Za-z0-9_.-]+$/.test(key) ? key : label;
  }
  return "";
}

async function warnRiskyGitConfig(cwd) {
  let text = "";
  try {
    const { out } = await runGit(
      ["-C", cwd, "config", "--local", "--name-only", "--list"],
      { timeoutMs: 4000 },
    );
    text = out || "";
  } catch {
    return;
  }
  const names = [];
  for (const line of text.split("\n")) {
    const label = riskyGitKeyLabel(line.trim());
    if (label && !names.includes(label)) names.push(label);
  }
  if (!names.length) return;
  names.sort();
  console.error("vault git config: " + names.join(", "));
}

async function ensureOrigin(cwd) {
  const remote = gitRemoteUrl();
  try {
    await runGit(["-C", cwd, "remote", "set-url", "origin", remote], { timeoutMs: 4000 });
  } catch {
    await runGit(["-C", cwd, "remote", "add", "origin", remote], { timeoutMs: 4000 });
  }
}

async function isGitRepo(dir) {
  try {
    const st = await fs.stat(path.join(dir, ".git"));
    return st.isDirectory() || st.isFile();
  } catch {
    return false;
  }
}

async function pathExists(p) {
  try {
    await fs.stat(p);
    return true;
  } catch {
    return false;
  }
}

function bundledVaultDir() {
  return BUNDLED_VAULT;
}

async function vaultHasDemo(dir) {
  const plan = path.join(dir, "aidanos", "active-horse.md");
  const map = path.join(dir, "maps", "reply-to-a-letter.md");
  return (await pathExists(plan)) && (await pathExists(map));
}

// A planted link in the destination must not receive the sample files.
// lstat each part under the seed root. A symlink, including a broken one,
// stops that branch. COPYFILE_EXCL then refuses to replace a real file.
async function linkedDestination(root, abs) {
  const base = path.resolve(root);
  const target = path.resolve(abs);
  if (target === base) return false;
  const rel = path.relative(base, target);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return true;
  let cursor = base;
  for (const part of rel.split(path.sep)) {
    cursor = path.join(cursor, part);
    let st;
    try {
      st = await fs.lstat(cursor);
    } catch (e) {
      if (e.code === "ENOENT") return false;
      throw e;
    }
    if (st.isSymbolicLink()) return true;
  }
  return false;
}

async function copyBundledTree(src, dest, root) {
  const top = root || dest;
  if (await linkedDestination(top, dest)) return;
  let destStat = null;
  try {
    destStat = await fs.lstat(dest);
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
  }
  if (destStat && destStat.isSymbolicLink()) return;
  if (destStat && !destStat.isDirectory()) return;
  if (!destStat) await fs.mkdir(dest, { recursive: true });
  let entries = [];
  try {
    entries = await fs.readdir(src, { withFileTypes: true });
  } catch {
    return;
  }
  for (const ent of entries) {
    if (ent.name === ".git") continue;
    const from = path.join(src, ent.name);
    const to = path.join(dest, ent.name);
    if (await linkedDestination(top, to)) continue;
    if (ent.isDirectory()) {
      await copyBundledTree(from, to, top);
      continue;
    }
    if (!ent.isFile()) continue;
    try {
      await fs.copyFile(from, to, fsSync.constants.COPYFILE_EXCL);
    } catch (e) {
      if (e.code === "EEXIST") continue;
      throw e;
    }
  }
}

export async function seedBundledVault(dest, src) {
  const from = src || bundledVaultDir();
  const to = dest || VAULT;
  if (!from || !to) return false;
  if (path.resolve(from) === path.resolve(to)) return false;
  if (!(await pathExists(from))) return false;
  if (await vaultHasDemo(to)) return false;
  await copyBundledTree(from, to);
  return true;
}

async function seedBundledVaultIfNeeded(reason) {
  try {
    const seeded = await seedBundledVault(VAULT, bundledVaultDir());
    if (seeded) console.error("vault seed: bundled sample after " + String(reason || "git miss"));
    return seeded;
  } catch (e) {
    console.error("vault seed:", sanitizeGitError(e && e.message || "seed failed"));
    return false;
  }
}

function scheduleVaultGitRetry() {
  if (!GIT_URL || !GIT_RETRY_MS || vaultGit.syncPaused) return;
  setTimeout(() => {
    enqueueVaultGit(() => retryVaultGit()).catch((e) => {
      vaultGit.error = sanitizeGitError(e && e.message || "retry failed");
      console.error("vault git retry:", vaultGit.error);
    });
  }, GIT_RETRY_MS).unref();
}

async function retryVaultGit() {
  if (!GIT_URL) return;
  try {
    await runGit(["--version"], { timeoutMs: 4000 });
  } catch {
    return;
  }
  try {
    if (await isGitRepo(VAULT)) {
      await ensureGitIdentity(VAULT);
      await unsetOldGitSafety(VAULT);
      await ensureOrigin(VAULT);
      vaultGit.ready = true;
      loadPending();
      await syncVault(null);
      if (vaultGit.fetchFailed) await seedBundledVaultIfNeeded("git retry");
      return;
    }
    await fs.mkdir(VAULT, { recursive: true });
    const names = await fs.readdir(VAULT);
    const nonempty = names.filter((n) => n !== "." && n !== "..");
    if (nonempty.length === 0) {
      await runGit(["clone", "--depth", "1", gitRemoteUrl(), VAULT], { timeoutMs: 25000 });
      vaultGit.error = "";
      await ensureGitIdentity(VAULT);
      await unsetOldGitSafety(VAULT);
      vaultGit.ready = await isGitRepo(VAULT);
    }
  } catch (e) {
    vaultGit.error = sanitizeGitError(e && e.message || "retry failed");
    await seedBundledVaultIfNeeded("git retry");
  }
}

async function initVaultGit() {
  if (!GIT_URL) return;
  try {
    await runGit(["--version"], { timeoutMs: 4000 });
  } catch {
    vaultGit.error = "git not available";
    console.error("vault git:", vaultGit.error);
    await seedBundledVaultIfNeeded("git missing");
    return;
  }
  try {
    await fs.mkdir(VAULT, { recursive: true });
    if (await isGitRepo(VAULT)) {
      await ensureGitIdentity(VAULT);
      await unsetOldGitSafety(VAULT);
      await ensureOrigin(VAULT);
      vaultGit.ready = true;
      loadPending();
      await syncVault(null);
      if (vaultGit.fetchFailed) {
        await seedBundledVaultIfNeeded("pull failed");
        scheduleVaultGitRetry();
      }
      return;
    }
    const names = await fs.readdir(VAULT);
    const nonempty = names.filter((n) => n !== "." && n !== "..");
    if (nonempty.length === 0) {
      try {
        await runGit(["clone", "--depth", "1", gitRemoteUrl(), VAULT], { timeoutMs: 25000 });
        vaultGit.error = "";
      } catch (e) {
        vaultGit.error = sanitizeGitError(e && e.message || "clone failed");
        console.error("vault git clone:", vaultGit.error);
        await seedBundledVaultIfNeeded("clone failed");
        try {
          await runGit(["-C", VAULT, "init", "-b", "main"], { timeoutMs: 8000 });
          await ensureOrigin(VAULT);
        } catch (initErr) {
          console.error("vault git init:", sanitizeGitError(initErr && initErr.message));
        }
        scheduleVaultGitRetry();
      }
      await ensureGitIdentity(VAULT);
      await unsetOldGitSafety(VAULT);
      vaultGit.ready = await isGitRepo(VAULT);
      if (vaultGit.ready) {
        loadPending();
        await syncVault(null);
      }
      return;
    }
    vaultGit.error = "vault path is not a git checkout";
    console.error("vault git:", vaultGit.error);
  } catch (e) {
    if (e && e.code) {
      pauseBackgroundSync(tagStop(e, "git"));
    } else {
      vaultGit.error = sanitizeGitError(e && e.message || "vault git failed");
      console.error("vault git:", vaultGit.error);
    }
    await seedBundledVaultIfNeeded("vault git failed");
    if (!vaultGit.syncPaused) scheduleVaultGitRetry();
  }
}

function isSafeRel(rel) {
  const s = String(rel || "").replace(/\\/g, "/");
  if (!s || s.startsWith("/") || s.includes("..") || s.includes("\0")) return false;
  if (s.length > 400) return false;
  const parts = s.split("/");
  for (const part of parts) {
    if (part.length > 200 || Buffer.byteLength(part) > 200) return false;
  }
  return true;
}

function dayFromRel(rel) {
  const match = /^log\/(\d{4}-\d{2}-\d{2})\.md$/.exec(String(rel || "").replace(/\\/g, "/"));
  return match ? match[1] : "";
}

function setGitError(msg) {
  const next = msg ? sanitizeGitError(msg) : "";
  if (next === vaultGit.error) return;
  vaultGit.error = next;
  if (next) console.error("vault git:", next);
}

let vaultWork = Promise.resolve();

function enqueueVaultWork(fn) {
  const run = vaultWork.then(fn, fn);
  vaultWork = run.then(() => {}, () => {});
  return run;
}

// Only this file, inside the vault's real .git. No other lock name is removed.
const GIT_INDEX_LOCK = "index.lock";
// Printed once per vault when index.lock is still there and we will not
// remove it. No path. An old lock this relay did not record stays, and is
// logged with this line.
export const GIT_LOCK_KEPT_LINE = "git index lock kept";
const GIT_DIR_GROUP_WRITE = 0o022;
const GIT_DIR_STICKY = 0o1000;
// vault path -> identity of the index.lock our own git failed to unlink.
// dev, ino, size, ctime, and birthtime when the platform reports one.
// The matching fd stays open until that decision, so the inode cannot be
// reused by a same-bytes recreate in the same tick.
const staleGitLocks = new Map();
const staleGitLockFds = new Map();
const gitLockKeptLogged = new Set();
// Vaults whose index.lock we left in place. Sync status reports this so
// the editor does not say Saved while git is stuck.
const gitLockBlocked = new Set();
let gitLockBeforeUnlinkForTest = null;
let gitLockBeforeMoveForTest = null;

function lockIdentity(st, hash) {
  const birth = st.birthtimeMs;
  return {
    dev: st.dev,
    ino: st.ino,
    size: st.size,
    ctimeMs: st.ctimeMs,
    birthtimeMs: typeof birth === "number" && birth > 0 ? birth : null,
    hash: typeof hash === "string" ? hash : "",
  };
}

function sameLock(recorded, live) {
  if (!recorded || !live) return false;
  if (recorded.dev !== live.dev || recorded.ino !== live.ino) return false;
  if (recorded.size !== live.size || recorded.ctimeMs !== live.ctimeMs) return false;
  if (recorded.birthtimeMs != null && live.birthtimeMs != null && recorded.birthtimeMs !== live.birthtimeMs) return false;
  if (!recorded.hash || !live.hash || recorded.hash !== live.hash) return false;
  return true;
}

// rename(2) keeps the inode and the bytes, and it updates ctime. The check
// after the quarantine rename still requires the same device, inode, size,
// birthtime when both sides have one, and content hash. ctime may move
// forward. A ctime that goes backwards is not the file we just renamed.
function sameMovedLock(recorded, live) {
  if (!recorded || !live) return false;
  if (recorded.dev !== live.dev || recorded.ino !== live.ino) return false;
  if (recorded.size !== live.size) return false;
  if (recorded.birthtimeMs != null && live.birthtimeMs != null && recorded.birthtimeMs !== live.birthtimeMs) return false;
  if (!recorded.hash || !live.hash || recorded.hash !== live.hash) return false;
  if (typeof live.ctimeMs !== "number" || live.ctimeMs < recorded.ctimeMs) return false;
  return true;
}

// m4. An index.lock bigger than this is not hashed and is never recorded.
// Release then sees an empty hash, leaves the file in place, and pauses
// sync. Fail closed: a lock we cannot identify is not deleted.
const LOCK_HASH_MAX = 1024 * 1024;
const QUARANTINE_NAME = /^\.aidanos-lock-[0-9a-f]{16}$/;

function closeFd(fd) {
  if (typeof fd !== "number" || fd < 0) return;
  try { fsSync.closeSync(fd); } catch { /* the caller still decides */ }
}

function hashOpenLock(fd, size) {
  const hash = createHash("sha256");
  if (size === 0) return hash.digest("hex");
  const buf = Buffer.alloc(Math.min(64 * 1024, size));
  let left = size;
  let pos = 0;
  while (left > 0) {
    const n = fsSync.readSync(fd, buf, 0, Math.min(buf.length, left), pos);
    if (n <= 0) return "";
    hash.update(buf.subarray(0, n));
    left -= n;
    pos += n;
  }
  return hash.digest("hex");
}

// The fd stays open. The caller closes it. O_NOFOLLOW refuses a symlink.
function openLockFd(lockPath) {
  let fd = -1;
  try {
    fd = fsSync.openSync(lockPath, fsSync.constants.O_RDONLY | fsSync.constants.O_NOFOLLOW);
    const st = fsSync.fstatSync(fd);
    if (!st.isFile()) {
      closeFd(fd);
      return null;
    }
    if (st.size > LOCK_HASH_MAX) return { fd, st, hash: "" };
    const hash = hashOpenLock(fd, st.size);
    if (!hash && st.size > 0) {
      closeFd(fd);
      return null;
    }
    return { fd, st, hash };
  } catch {
    closeFd(fd);
    return null;
  }
}

function readLockFile(lockPath) {
  const opened = openLockFd(lockPath);
  if (!opened) return null;
  closeFd(opened.fd);
  return { st: opened.st, hash: opened.hash };
}

function rememberLockFd(key, fd) {
  const prev = staleGitLockFds.get(key);
  if (prev != null && prev !== fd) closeFd(prev);
  staleGitLockFds.set(key, fd);
}

function forgetRecordedLock(key) {
  staleGitLocks.delete(key);
  const fd = staleGitLockFds.get(key);
  if (fd == null) return;
  staleGitLockFds.delete(key);
  closeFd(fd);
}

// The holder check can take the whole lsof wait. A test uses this to swap
// index.lock in that window. Off unless this process is a test.
export function setGitLockBeforeUnlinkForTest(fn) {
  if (process.env.NODE_ENV !== "test") return;
  gitLockBeforeUnlinkForTest = typeof fn === "function" ? fn : null;
}

// Fires after the recorded fd still matches index.lock and before the
// quarantine name is created. Off unless this process is a test.
export function setGitLockBeforeMoveForTest(fn) {
  if (process.env.NODE_ENV !== "test") return;
  gitLockBeforeMoveForTest = typeof fn === "function" ? fn : null;
}

// Tests that prove an unlink need a finished holder scan. Production never
// sets this. Off unless this process is a test.
let gitLockHoldersForTest = null;
export function setGitLockHoldersForTest(fn) {
  if (process.env.NODE_ENV !== "test") return;
  gitLockHoldersForTest = typeof fn === "function" ? fn : null;
}

function reportGitLockKept(key) {
  if (gitLockKeptLogged.has(key)) return;
  gitLockKeptLogged.add(key);
  console.error(GIT_LOCK_KEPT_LINE);
}

function clearGitLockKept(key) {
  gitLockKeptLogged.delete(key);
  gitLockBlocked.delete(key);
}

function markGitLockBlocked(key) {
  gitLockBlocked.add(key);
}

export function gitLockBlocksVault(vault = VAULT) {
  return gitLockBlocked.has(vaultKey(vault));
}

function vaultKey(vault) {
  return path.resolve(String(vault || ""));
}

// Walk vault/.git. Every symlink is refused, including one owned by root.
function resolveGitDir(vault) {
  const uid = typeof process.getuid === "function" ? process.getuid() : null;
  if (typeof uid !== "number") return null;
  return walkGitDir(path.resolve(vault, ".git"), uid);
}

function walkGitDir(abs, uid) {
  const chain = [];
  let cursor = abs;
  for (;;) {
    chain.push(cursor);
    const parent = path.dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  chain.reverse();
  let stat = null;
  for (const dir of chain) {
    let st;
    try {
      st = fsSync.lstatSync(dir);
    } catch {
      return null;
    }
    if (st.isSymbolicLink()) return null;
    if (!st.isDirectory()) return null;
    const writable = (st.mode & GIT_DIR_GROUP_WRITE) !== 0;
    const stickyRoot = (st.mode & GIT_DIR_STICKY) !== 0 && st.uid === 0;
    if (writable && !stickyRoot) return null;
    if (st.uid !== 0 && st.uid !== uid) return null;
    stat = st;
  }
  if (!stat) return null;
  return { dir: abs, dev: stat.dev, ino: stat.ino };
}

function namedIndexLock(named, vault) {
  const text = String(named || "");
  if (!text || text.includes("\0")) return null;
  const abs = path.isAbsolute(text) ? path.resolve(text) : path.resolve(vault, text);
  if (path.basename(abs) !== GIT_INDEX_LOCK) return null;
  const gitParent = path.dirname(abs);
  if (path.basename(gitParent) !== ".git") return null;
  const namedGit = resolveGitDir(path.dirname(gitParent));
  const ownGit = resolveGitDir(vault);
  if (!namedGit || !ownGit) return null;
  if (namedGit.dev !== ownGit.dev || namedGit.ino !== ownGit.ino || namedGit.dir !== ownGit.dir) return null;
  return ownGit;
}

async function processHoldsLock(file, dev, ino) {
  if (process.env.NODE_ENV === "test" && gitLockHoldersForTest) {
    const forced = gitLockHoldersForTest(file, dev, ino);
    if (forced === "unknown") return "unknown";
    return forced ? "held" : "free";
  }
  if (process.platform === "linux") return linuxProcessHolds(dev, ino);
  return lsofHolds(file);
}

function procGone(error) {
  return Boolean(error && (error.code === "ENOENT" || error.code === "ESRCH"));
}

function procDenied(error) {
  return Boolean(error && (error.code === "EACCES" || error.code === "EPERM"));
}

// "held", "free", or "unknown". Reads are async so the scan does not sit
// on the event loop. A holder has to be able to write the vault, so a
// process owned by another uid is skipped. pid 1 is root. Its descriptor
// directory is not a failed read of a process we own.
// m6. EACCES or EPERM while reading a same-uid process is unknown, and
// the lock is kept. On Linux that is a non-dumpable process (dumpable 0):
// its descriptor directory is unreadable even when it does not hold the
// lock. Fail closed. It is not "no holder". A recorded lock is deleted
// only when every same-uid process was inspected and none has the inode open.
// The recorded identity includes a sha256 of the bytes. The fd from that
// record stays open, so a same-bytes recreate in the same tick gets a new
// inode and is kept. Removal links the lock to a unique quarantine name
// created exclusively, then compares fstat of the recorded fd with stat
// of that name. ctime may move forward. A failed re-check links the
// quarantine back only when index.lock is absent. EEXIST keeps the
// quarantine and reports the pause.
// Same-account gap: an unreadable same-uid process keeps the lock even
// when it does not hold it.
async function linuxProcessHolds(dev, ino) {
  try {
    return await scanLinuxHolders(dev, ino);
  } catch {
    return "unknown";
  }
}

async function scanLinuxHolders(dev, ino) {
  const uid = typeof process.getuid === "function" ? process.getuid() : null;
  if (typeof uid !== "number") return "unknown";
  let pids;
  try {
    pids = await fs.readdir("/proc");
  } catch {
    return "unknown";
  }
  for (const pid of pids) {
    if (!/^\d+$/.test(pid) || Number(pid) === process.pid) continue;
    const procDir = "/proc/" + pid;
    let owner;
    try {
      owner = (await fs.stat(procDir)).uid;
    } catch (error) {
      if (procGone(error)) continue;
      return "unknown";
    }
    if (owner !== uid) continue;
    const found = await descriptorsHold(procDir + "/fd", dev, ino);
    if (found === "held" || found === "unknown") return found;
  }
  return "free";
}

async function descriptorsHold(fdDir, dev, ino) {
  try {
    await fs.stat(fdDir);
  } catch (error) {
    if (procGone(error)) return "skip";
    return "unknown";
  }
  let fds;
  try {
    fds = await fs.readdir(fdDir);
  } catch (error) {
    if (procGone(error)) return "skip";
    return "unknown";
  }
  for (const fd of fds) {
    const held = await descriptorHolds(fdDir + "/" + fd, dev, ino);
    if (held === "unknown") return "unknown";
    if (held === true) return "held";
  }
  return "skip";
}

async function descriptorHolds(fdPath, dev, ino) {
  try {
    const st = await fs.stat(fdPath);
    if (st.dev === dev && st.ino === ino) return true;
    return false;
  } catch (error) {
    if (procGone(error)) return false;
    if (procDenied(error)) return "unknown";
    return false;
  }
}

function lsofHolds(file) {
  return new Promise((resolve) => {
    let out = "";
    let settled = false;
    let timer;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const child = spawn("lsof", ["-t", "--", file], { stdio: ["ignore", "pipe", "ignore"] });
    timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish("unknown");
    }, 2000);
    child.stdout.on("data", (chunk) => { out += chunk; });
    child.on("error", () => finish("unknown"));
    child.on("close", (code) => {
      if (settled) return;
      if (code == null || (code !== 0 && code !== 1)) {
        finish("unknown");
        return;
      }
      const held = String(out).split(/\s+/).some((pid) => pid && Number(pid) !== process.pid);
      finish(held ? "held" : "free");
    });
  });
}

// link fails with EEXIST when index.lock is already there. The quarantine
// name stays, and the caller pauses. A successful link drops the extra name.
function restoreQuarantine(quarantine, lockPath) {
  try {
    fsSync.linkSync(quarantine, lockPath);
  } catch {
    return false;
  }
  try {
    fsSync.unlinkSync(quarantine);
  } catch {
    return false;
  }
  return true;
}

function linkExclusiveQuarantine(lockPath, dir) {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const quarantine = path.join(dir, ".aidanos-lock-" + randomBytes(8).toString("hex"));
    try {
      fsSync.linkSync(lockPath, quarantine);
      return quarantine;
    } catch (error) {
      if (error && error.code === "EEXIST") continue;
      return "";
    }
  }
  return "";
}

function sameDevice(fd, file) {
  let held;
  let link;
  let named;
  try {
    held = fsSync.fstatSync(fd);
    link = fsSync.lstatSync(file);
    named = fsSync.statSync(file);
  } catch {
    return false;
  }
  if (link.isSymbolicLink() || !named.isFile()) return false;
  return held.dev === named.dev && held.ino === named.ino;
}

// True when this call removed the recorded lock. False leaves a lock in place.
// The recorded fd stays open. The quarantine name is a hard link, so an
// existing name is left alone. fstat of that fd must match stat of the
// quarantine file. A failed re-check links it back only when index.lock
// is absent. Neither path prints the file name.
async function quarantineRecordedLock(vault, identity) {
  if (process.env.NODE_ENV === "test" && gitLockBeforeUnlinkForTest) {
    const fn = gitLockBeforeUnlinkForTest;
    gitLockBeforeUnlinkForTest = null;
    fn();
  }
  const git = resolveGitDir(vault);
  if (!git) return false;
  const lockPath = path.join(git.dir, GIT_INDEX_LOCK);
  let parent;
  try {
    parent = fsSync.lstatSync(git.dir);
  } catch {
    return false;
  }
  if (parent.isSymbolicLink() || !parent.isDirectory() || parent.dev !== git.dev || parent.ino !== git.ino) return false;
  const key = vaultKey(vault);
  const recordedFd = staleGitLockFds.get(key);
  if (typeof recordedFd !== "number" || !sameDevice(recordedFd, lockPath)) return false;
  let held;
  try {
    held = fsSync.fstatSync(recordedFd);
  } catch {
    return false;
  }
  if (held.dev !== identity.dev || held.ino !== identity.ino) return false;
  const opened = readLockFile(lockPath);
  if (!opened || !sameLock(identity, lockIdentity(opened.st, opened.hash))) return false;
  const againGit = resolveGitDir(vault);
  if (!againGit || againGit.dev !== git.dev || againGit.ino !== git.ino || againGit.dir !== git.dir) return false;
  if (process.env.NODE_ENV === "test" && gitLockBeforeMoveForTest) {
    const fn = gitLockBeforeMoveForTest;
    gitLockBeforeMoveForTest = null;
    fn();
  }
  const quarantine = linkExclusiveQuarantine(lockPath, againGit.dir);
  if (!quarantine) return false;
  if (!sameDevice(recordedFd, quarantine)) {
    try { fsSync.unlinkSync(quarantine); } catch { /* the new lock keeps its own name */ }
    return false;
  }
  try {
    const dirEnt = fsSync.lstatSync(lockPath);
    if (!dirEnt.isSymbolicLink() && dirEnt.isFile() && dirEnt.dev === held.dev && dirEnt.ino === held.ino) {
      fsSync.unlinkSync(lockPath);
    }
  } catch {
    /* index.lock is already gone, or it is a new file */
  }
  const moved = readLockFile(quarantine);
  const movedIdentity = moved ? lockIdentity(moved.st, moved.hash) : null;
  const stillSame = Boolean(movedIdentity && sameMovedLock(identity, movedIdentity) && sameDevice(recordedFd, quarantine));
  const holders = stillSame ? await processHoldsLock(quarantine, moved.st.dev, moved.st.ino) : "unknown";
  if (stillSame && holders === "free") {
    try {
      fsSync.unlinkSync(quarantine);
      return true;
    } catch {
      restoreQuarantine(quarantine, lockPath);
      return false;
    }
  }
  restoreQuarantine(quarantine, lockPath);
  return false;
}

// Git's "unable to unlink" text is not a path we may delete. The only
// accepted file is <walked real .git>/index.lock, and only when that walk
// refused every symlink, including one owned by root.
export function rememberUnlinkLock(errText, vault = VAULT) {
  const key = vaultKey(vault);
  const re = /unable to unlink '([^']+)'/g;
  let match;
  let recorded = null;
  let recordedFd = -1;
  while ((match = re.exec(String(errText || "")))) {
    const git = namedIndexLock(match[1], vault);
    if (!git) continue;
    const lockPath = path.join(git.dir, GIT_INDEX_LOCK);
    let st;
    try {
      st = fsSync.lstatSync(lockPath);
    } catch {
      continue;
    }
    if (st.isSymbolicLink() || !st.isFile()) continue;
    let parent;
    try {
      parent = fsSync.lstatSync(git.dir);
    } catch {
      continue;
    }
    if (parent.isSymbolicLink() || !parent.isDirectory() || parent.dev !== git.dev || parent.ino !== git.ino) continue;
    // m4. Over 1 MB the hash is empty, so this lock is never recorded.
    const opened = openLockFd(lockPath);
    if (!opened || !opened.hash) continue;
    if (recordedFd >= 0) closeFd(recordedFd);
    recorded = lockIdentity(opened.st, opened.hash);
    recordedFd = opened.fd;
  }
  if (recorded && recordedFd >= 0) {
    staleGitLocks.set(key, recorded);
    rememberLockFd(key, recordedFd);
  } else {
    closeFd(recordedFd);
  }
}

// Drop index.lock only when it is still the file our failed git recorded
// (device, inode, size, ctime, birthtime where both sides have one, and
// the sha256 of the bytes) and no live process has it open. The fd from
// that record stays open through the quarantine link. fstat of that fd
// must match stat of the quarantine file, and ctime may only move
// forward, before unlink. A lock this relay did
// not record stays, however old it is. A symlink on the way to .git, a
// lock outside .git, and a lock a live git still holds stay put. A lock
// we leave in place is logged once per vault with no path.
export async function releaseRememberedGitLock(vault = VAULT) {
  const key = vaultKey(vault);
  const recorded = staleGitLocks.get(key) || null;
  const git = resolveGitDir(vault);
  if (!git) {
    forgetRecordedLock(key);
    clearGitLockKept(key);
    return;
  }
  const lockPath = path.join(git.dir, GIT_INDEX_LOCK);
  let st;
  try {
    st = fsSync.lstatSync(lockPath);
  } catch {
    forgetRecordedLock(key);
    clearGitLockKept(key);
    return;
  }
  if (st.isSymbolicLink() || !st.isFile()) {
    forgetRecordedLock(key);
    clearGitLockKept(key);
    return;
  }
  let parent;
  try {
    parent = fsSync.lstatSync(git.dir);
  } catch {
    forgetRecordedLock(key);
    clearGitLockKept(key);
    return;
  }
  if (parent.isSymbolicLink() || !parent.isDirectory() || parent.dev !== git.dev || parent.ino !== git.ino) {
    forgetRecordedLock(key);
    clearGitLockKept(key);
    return;
  }
  // m4. No hash means the lock was over 1 MB or could not be read.
  // It was never recorded. Leave it and pause sync. Fail closed.
  const opened = readLockFile(lockPath);
  if (!opened || !opened.hash) {
    markGitLockBlocked(key);
    reportGitLockKept(key);
    return;
  }
  const current = lockIdentity(opened.st, opened.hash);
  const same = sameLock(recorded, current);
  const holders = await processHoldsLock(lockPath, opened.st.dev, opened.st.ino);
  if (holders === "unknown") {
    markGitLockBlocked(key);
    reportGitLockKept(key);
    return;
  }
  if (holders === "held") {
    markGitLockBlocked(key);
    if (!same) reportGitLockKept(key);
    return;
  }
  if (!same) {
    forgetRecordedLock(key);
    markGitLockBlocked(key);
    reportGitLockKept(key);
    return;
  }
  staleGitLocks.delete(key);
  let removed = false;
  try {
    removed = await quarantineRecordedLock(vault, current);
  } finally {
    forgetRecordedLock(key);
  }
  if (!removed) {
    markGitLockBlocked(key);
    reportGitLockKept(key);
    return;
  }
  clearGitLockKept(key);
}

// A crash can leave .aidanos-lock-* behind. At start, delete one only when
// it is still the regular file we opened, fstat matches stat, and no
// same-uid process holds it. A holder, or a file that changes, stays.
export async function sweepAbandonedGitLocks(vault = VAULT) {
  const git = resolveGitDir(vault);
  if (!git) return;
  const key = vaultKey(vault);
  let names;
  try {
    names = fsSync.readdirSync(git.dir);
  } catch {
    return;
  }
  for (const name of names) {
    if (!QUARANTINE_NAME.test(name)) continue;
    const file = path.join(git.dir, name);
    let parent;
    try {
      parent = fsSync.lstatSync(git.dir);
    } catch {
      return;
    }
    if (parent.isSymbolicLink() || !parent.isDirectory() || parent.dev !== git.dev || parent.ino !== git.ino) return;
    const opened = openLockFd(file);
    if (!opened || !opened.hash) {
      closeFd(opened && opened.fd);
      markGitLockBlocked(key);
      reportGitLockKept(key);
      continue;
    }
    try {
      const identity = lockIdentity(opened.st, opened.hash);
      const holders = await processHoldsLock(file, opened.st.dev, opened.st.ino);
      if (holders !== "free" || !sameDevice(opened.fd, file)) {
        markGitLockBlocked(key);
        reportGitLockKept(key);
        continue;
      }
      const againHash = hashOpenLock(opened.fd, opened.st.size);
      let named;
      try {
        named = fsSync.fstatSync(opened.fd);
      } catch {
        markGitLockBlocked(key);
        reportGitLockKept(key);
        continue;
      }
      if (!againHash || againHash !== identity.hash || named.dev !== identity.dev || named.ino !== identity.ino) {
        markGitLockBlocked(key);
        reportGitLockKept(key);
        continue;
      }
      if (!sameDevice(opened.fd, file)) {
        markGitLockBlocked(key);
        reportGitLockKept(key);
        continue;
      }
      try {
        fsSync.unlinkSync(file);
      } catch {
        markGitLockBlocked(key);
        reportGitLockKept(key);
      }
    } finally {
      closeFd(opened.fd);
    }
  }
}

// Tests set AIDANOS_TEST_GIT_TURN to a file outside the vault. Git work holds
// it for the whole job, so a test can close the vault only while no git is
// inside it. Off unless this process is a test, and unset it is a no-op.
export async function acquireGitTurn() {
  if (process.env.NODE_ENV !== "test") return "";
  const file = String(process.env.AIDANOS_TEST_GIT_TURN || "");
  if (!file) return "";
  for (;;) {
    try {
      const fd = fsSync.openSync(file, fsSync.constants.O_CREAT | fsSync.constants.O_EXCL | fsSync.constants.O_WRONLY, 0o600);
      fsSync.closeSync(fd);
      return file;
    } catch (error) {
      if (!error || error.code !== "EEXIST") throw error;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }
}

export function releaseGitTurn(file) {
  if (!file) return;
  try { fsSync.unlinkSync(file); } catch { /* the holder already released it */ }
}

function enqueueVaultGit(work) {
  const run = enqueueVaultWork(async () => {
    const turn = await acquireGitTurn();
    try {
      return await work();
    } finally {
      releaseGitTurn(turn);
    }
  });
  vaultGit.chain = run.then(() => {}, () => {});
  return run;
}

function pendingFilePath() {
  return path.join(VAULT, ".git", "aidanos-pending");
}

function persistPending() {
  if (!vaultGit.ready) return;
  try {
    const file = pendingFilePath();
    const body = JSON.stringify({
      paths: [...vaultGit.pending],
      resolve: [...vaultGit.resolvePending],
      hold: [...vaultGit.hold],
      against: Object.fromEntries(vaultGit.choiceAgainst),
    });
    fsSync.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = file + ".tmp";
    fsSync.writeFileSync(tmp, body, { encoding: "utf8", flag: "w" });
    fsSync.renameSync(tmp, file);
  } catch (e) {
    console.error("vault pending:", sanitizeGitError(e && e.message || "save failed"));
  }
}

function loadPending() {
  let raw = "";
  try {
    raw = fsSync.readFileSync(pendingFilePath(), "utf8");
  } catch {
    return;
  }
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    return;
  }
  vaultGit.pending.clear();
  vaultGit.resolvePending.clear();
  vaultGit.hold.clear();
  vaultGit.choiceAgainst.clear();
  const paths = data && Array.isArray(data.paths) ? data.paths : [];
  const resolving = data && Array.isArray(data.resolve) ? data.resolve : [];
  const held = data && Array.isArray(data.hold) ? data.hold : [];
  const against = data && data.against && typeof data.against === "object" ? data.against : {};
  for (const rel of paths) {
    if (isAppNotePath(rel)) vaultGit.pending.add(rel);
  }
  for (const rel of resolving) {
    if (isAppNotePath(rel) && vaultGit.pending.has(rel)) vaultGit.resolvePending.add(rel);
  }
  for (const rel of held) {
    if (isAppNotePath(rel)) vaultGit.hold.add(rel);
  }
  for (const [rel, blob] of Object.entries(against)) {
    if (!isAppNotePath(rel) || typeof blob !== "string" || !blob) continue;
    vaultGit.choiceAgainst.set(rel, blob);
  }
}

function refreshHold() {
  const next = new Set();
  for (const [rel, item] of vaultGit.conflicts) {
    if (!item.resolved) next.add(rel);
  }
  let changed = next.size !== vaultGit.hold.size;
  if (!changed) {
    for (const rel of next) {
      if (!vaultGit.hold.has(rel)) changed = true;
    }
  }
  vaultGit.hold = next;
  if (changed) persistPending();
}

function scheduleVaultSync(relPath, resolve) {
  if (!vaultGit.enabled || !vaultGit.ready) return;
  const rel = String(relPath || "").replace(/\\/g, "/");
  if (!isAppNotePath(rel)) return;
  vaultGit.pending.add(rel);
  if (resolve) vaultGit.resolvePending.add(rel);
  persistPending();
  if (vaultGit.syncPaused) return;
  if (vaultGit.timer) clearTimeout(vaultGit.timer);
  const started = new Set(vaultGit.pending);
  vaultGit.timer = setTimeout(() => {
    vaultGit.timer = null;
    enqueueVaultGit(() => syncVault(null)).catch((e) => {
      if (e && e.aidanosStop) {
        pauseBackgroundSync(e);
        return;
      }
      setGitError(e && e.message || "git failed");
    }).finally(() => {
      for (const extra of vaultGit.pending) {
        if (started.has(extra)) continue;
        scheduleVaultSync(extra, vaultGit.resolvePending.has(extra));
        return;
      }
    });
  }, GIT_DEBOUNCE_MS);
}

function startVaultSyncLoop() {
  if (!GIT_URL || !GIT_SYNC_MS) return;
  const arm = () => {
    if (vaultGit.syncPaused) return;
    vaultGit.syncTimer = setTimeout(() => {
      vaultGit.syncTimer = null;
      if (vaultGit.syncPaused) return;
      enqueueVaultGit(() => syncVault(null)).catch((e) => {
        if (e && e.aidanosStop) {
          pauseBackgroundSync(e);
          return;
        }
        setGitError(e && e.message || "git failed");
      }).finally(() => {
        if (!vaultGit.syncPaused) arm();
      });
    }, GIT_SYNC_MS);
    if (vaultGit.syncTimer && typeof vaultGit.syncTimer.unref === "function") {
      vaultGit.syncTimer.unref();
    }
  };
  arm();
}

function pushWatchSilence() {
  vaultGit.suppressWatch += 1;
}

function popWatchSilence() {
  vaultGit.suppressWatch = Math.max(0, vaultGit.suppressWatch - 1);
}

function sendWatch(obj) {
  const payload = `data: ${JSON.stringify(obj)}\n\n`;
  for (const client of sseClients) {
    try { client.write(payload); } catch {}
  }
}

function publicConflicts() {
  const out = [];
  for (const item of vaultGit.conflicts.values()) {
    if (item.resolved) continue;
    out.push({
      path: item.path,
      date: dayFromRel(item.path),
      mine: item.mine,
      theirs: item.theirs,
      mtime: item.mtime,
    });
  }
  return out;
}

function syncStatus() {
  const lockKept = gitLockBlocksVault();
  if (!vaultGit.enabled) {
    return { enabled: false, ok: true, error: "", conflicts: [], join: false, left: "", lockKept: false };
  }
  const conflicts = publicConflicts();
  const join = Boolean(vaultGit.join) && conflicts.length === 0;
  const error = vaultGit.error || "";
  return {
    enabled: true,
    ok: !error && conflicts.length === 0 && !join,
    error,
    conflicts,
    join,
    left: vaultGit.left || "",
    lockKept,
  };
}

function finishGitNotice() {
  const status = syncStatus();
  const notice = JSON.stringify({
    error: status.error,
    conflicts: status.conflicts,
    join: status.join,
    left: status.left,
    lockKept: status.lockKept,
  });
  if (notice === vaultGit.notice) return;
  vaultGit.notice = notice;
  if (!status.enabled) return;
  sendWatch({
    type: "git",
    enabled: true,
    error: status.error,
    conflicts: status.conflicts,
    join: status.join,
    left: status.left,
    lockKept: Boolean(status.lockKept),
  });
}

function hasUnresolved() {
  for (const item of vaultGit.conflicts.values()) {
    if (!item.resolved) return true;
  }
  return false;
}

function resolvedChoices() {
  const out = new Map();
  for (const item of vaultGit.conflicts.values()) {
    if (!item.resolved) continue;
    out.set(item.path, item.choice != null ? item.choice : item.mine);
  }
  return out;
}

// APFS and Windows fold `.GIT` onto `.git`. Linux does not, so the name
// check stays exact there and the inode check does the real work.
const FOLD_GIT_NAME = process.platform === "darwin" || process.platform === "win32";

const gitDirCache = new Map();

function resolveGitDirPointer(rootReal) {
  const child = spawnSync("git", [...gitSafetyPrefix(), "-C", rootReal, "rev-parse", "--git-dir"], {
    encoding: "utf8",
    timeout: 4000,
    env: gitEnv(),
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (!child || child.status !== 0) return null;
  const text = String(child.stdout || "").trim();
  if (!text || text.includes("\0") || text.includes("\n")) return null;
  return path.resolve(rootReal, text);
}

// `.git` may be a directory, or a pointer file in a linked worktree.
// The pointer's own inode is not the real git dir, so resolve that with
// git and check it too. A normal directory does not spawn git.
function gitDirIds(rootReal) {
  const gitPath = path.join(rootReal, ".git");
  let listed;
  try {
    listed = fsSync.lstatSync(gitPath);
  } catch {
    return [];
  }
  let followed;
  try {
    followed = fsSync.statSync(gitPath);
  } catch {
    return [];
  }
  const ids = [{ dev: followed.dev, ino: followed.ino }];
  if (!listed.isFile() && !followed.isFile()) return ids;
  const cached = gitDirCache.get(rootReal);
  if (cached && cached.fileDev === listed.dev && cached.fileIno === listed.ino) {
    try {
      const gst = fsSync.statSync(cached.resolved);
      if (gst.dev === cached.dirDev && gst.ino === cached.dirIno) return cached.ids;
    } catch {
      // The resolved directory moved. Look it up again.
    }
  }
  const resolved = resolveGitDirPointer(rootReal);
  if (!resolved) return ids;
  try {
    const gst = fsSync.statSync(resolved);
    if (gst.dev !== followed.dev || gst.ino !== followed.ino) {
      ids.push({ dev: gst.dev, ino: gst.ino });
    }
    gitDirCache.set(rootReal, {
      fileDev: listed.dev,
      fileIno: listed.ino,
      resolved,
      dirDev: gst.dev,
      dirIno: gst.ino,
      ids,
    });
  } catch {
    return ids;
  }
  return ids;
}

// `real` is a resolved path. Refuse it when it is the vault .git directory,
// sits inside that directory, or has a .git part at any depth (a nested
// repo). Match the directory by device and inode, not by the spelling of
// the path: a link can resolve to a folder `.git` merely points at.
function realPathInGit(real, rootReal) {
  const resolved = path.resolve(real);
  const root = path.resolve(rootReal);
  const rel = path.relative(root, resolved);
  const outside = !rel || rel.startsWith("..") || path.isAbsolute(rel);
  const parts = (outside ? resolved : rel).split(path.sep);
  for (const part of parts) {
    if (part === ".git") return true;
    if (FOLD_GIT_NAME && part.toLowerCase() === ".git") return true;
  }
  const ids = gitDirIds(root);
  if (!ids.length) return false;
  let cursor = resolved;
  for (;;) {
    let st;
    try {
      st = fsSync.statSync(cursor);
    } catch {
      return true;
    }
    if (ids.some((id) => st.dev === id.dev && st.ino === id.ino)) return true;
    if (cursor === root) break;
    const parent = path.dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  return false;
}

export function vaultRel(abs, root = VAULT) {
  const rel = path.relative(path.resolve(root), path.resolve(abs));
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) throw new Error("bad path");
  return rel.split(path.sep).join("/");
}

// Stable signature: worktreePath(rel, root = VAULT) -> absolute path.
// rel is vault-relative. Callers pass one or two arguments and no more.
// Every symlink is refused, including one that stays inside the vault.
// The error names that vault-relative path ("symlink: notes/alias.md").
// A missing tail is still the logical path, so a new note can be created.
// The vault root is lstat'd and refused when it is a symlink. It is not
// realpath'd into acceptance. Parents above the root are not checked.
function symlinkError(rel) {
  const named = String(rel || ".").replace(/\\/g, "/").replace(/\/+$/, "") || ".";
  return new Error("symlink: " + named);
}

async function lstatOrMissing(abs) {
  try {
    return await fs.lstat(abs);
  } catch (e) {
    if (e.code === "ENOENT") return null;
    throw new Error("bad path");
  }
}

export async function worktreePath(rel, root = VAULT) {
  if (!isSafeRel(rel)) throw new Error("bad path");
  const logicalRoot = path.resolve(root);
  const rootSt = await lstatOrMissing(logicalRoot);
  if (rootSt && rootSt.isSymbolicLink()) throw symlinkError(".");
  if (rootSt && !rootSt.isDirectory()) throw new Error("bad path");
  const abs = safeJoin(root, rel);
  const logical = path.resolve(abs);
  const relPath = path.relative(logicalRoot, logical);
  if (!relPath || relPath.startsWith("..") || path.isAbsolute(relPath)) {
    throw new Error("bad path");
  }
  const parts = relPath.split(path.sep);
  let cursor = logicalRoot;
  for (let i = 0; i < parts.length; i++) {
    cursor = path.join(cursor, parts[i]);
    const relSoFar = parts.slice(0, i + 1).join("/");
    const st = await lstatOrMissing(cursor);
    if (!st) return abs;
    if (st.isSymbolicLink()) throw symlinkError(relSoFar);
    // A directory can be the git dir without the name ".git" (a mount, or a
    // pointer file). Symlinks are already refused above, so this does not
    // follow one, and the root itself is not realpath'd.
    if (realPathInGit(cursor, logicalRoot)) throw new Error("bad path");
    if (i < parts.length - 1 && !st.isDirectory()) throw new Error("bad path");
  }
  return abs;
}

// Listing has no leaf file, so check the folder by asking about a child.
// worktreePath's signature stays (rel, root).
async function worktreeDir(rel, root = VAULT) {
  const cleaned = String(rel || "").replace(/\\/g, "/").replace(/\/+$/, "");
  if (!cleaned || cleaned === ".") {
    const resolved = path.resolve(root);
    const st = await lstatOrMissing(resolved);
    if (st && st.isSymbolicLink()) throw symlinkError(".");
    return resolved;
  }
  await worktreePath(cleaned + "/note.md", root);
  return safeJoin(root, cleaned);
}

function rememberSkip(skipped, rel) {
  if (!skipped) return;
  const named = String(rel || "").replace(/\\/g, "/").replace(/\/+$/, "");
  if (!named || named.startsWith("/") || named.includes("..") || named.includes("\0")) return;
  if (path.isAbsolute(named) || skipped.includes(named)) return;
  skipped.push(named);
}

function oneLine(text) {
  let out = "";
  const s = String(text || "");
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i);
    out += code <= 31 || code === 127 ? "?" : s[i];
  }
  return out;
}

function logSkips(skipped) {
  if (!skipped || !skipped.length) return;
  console.error("skipped symlink: " + skipped.map(oneLine).join(", "));
}

async function readVaultRel(rel, skipped, gitLinks) {
  const cleaned = String(rel || "").replace(/\\/g, "/");
  if (gitLinks && gitLinks.has(cleaned)) {
    if (skipped) {
      rememberSkip(skipped, cleaned);
      return null;
    }
    throw symlinkError(cleaned);
  }
  try {
    return await readFileSafe(await worktreePath(rel));
  } catch (e) {
    const msg = String(e && e.message || "");
    if (skipped && msg.startsWith("symlink: ")) {
      rememberSkip(skipped, msg.slice("symlink: ".length));
      return null;
    }
    throw e;
  }
}

async function readLogNames(skipped, gitLinks) {
  await assertRealVaultRoot();
  const logDir = path.join(VAULT, "log");
  let st;
  try {
    st = await fs.lstat(logDir);
  } catch (e) {
    if (e.code === "ENOENT") return [];
    throw e;
  }
  if (st.isSymbolicLink() || (gitLinks && gitLinks.has("log"))) {
    if (skipped) {
      rememberSkip(skipped, "log");
      return [];
    }
    throw symlinkError("log");
  }
  if (!st.isDirectory()) return [];
  const entries = await fs.readdir(logDir, { withFileTypes: true });
  const names = [];
  for (const ent of entries) {
    if (ent.name.startsWith(".")) continue;
    const rel = "log/" + ent.name;
    if (ent.isSymbolicLink() || (gitLinks && gitLinks.has(rel))) {
      if (skipped) rememberSkip(skipped, rel);
      else throw symlinkError(rel);
      continue;
    }
    if (!ent.isFile()) continue;
    names.push(ent.name);
  }
  return names;
}

// Last path part on read. A symlink is refused and named. It is not followed,
// even when the target is another note inside the vault.
async function readableTarget(abs, root) {
  let st;
  try {
    st = await fs.lstat(abs);
  } catch (e) {
    if (e.code === "ENOENT") return null;
    throw new Error("bad path");
  }
  if (st.isSymbolicLink()) {
    let rel = path.basename(abs);
    try { rel = vaultRel(abs, root); } catch { /* keep the leaf name */ }
    throw symlinkError(rel);
  }
  return abs;
}

// A fifo, socket, or device can block the read. A second directory entry
// can be .git/config. Notes are not hard-linked, so every extra link is
// refused: walking .git to prove the other name is safe can miss one.
function refuseServedFile(st) {
  if (!st.isFile() || st.nlink > 1) throw new Error("bad path");
}

const VAULT_READ_FLAGS = fsSync.constants.O_RDONLY
  | (fsSync.constants.O_NOFOLLOW || 0)
  | (fsSync.constants.O_NONBLOCK || 0);

async function readRegularText(abs) {
  let fh;
  try {
    fh = await fs.open(abs, VAULT_READ_FLAGS);
  } catch (e) {
    if (e.code === "ENOENT") return null;
    // Permission and I/O failures are unexpected. Path refusals stay "bad path".
    if (e.code === "EACCES" || e.code === "EPERM" || e.code === "EIO" || e.code === "ENOSPC") throw e;
    throw new Error("bad path");
  }
  try {
    const st = await fh.stat();
    refuseServedFile(st);
    return await fh.readFile({ encoding: "utf8" });
  } finally {
    await fh.close();
  }
}

export async function readWorktree(rel, root = VAULT) {
  if (!isSafeRel(rel)) throw new Error("bad path");
  const abs = await worktreePath(rel, root);
  const target = await readableTarget(abs, root);
  if (target == null) return null;
  return await readRegularText(target);
}

async function readRel(rel) {
  if (!isSafeRel(rel)) return "";
  const text = await readWorktree(rel);
  return text == null ? "" : text;
}

export async function writeVaultText(rel, text) {
  const abs = await worktreePath(rel);
  const parent = path.dirname(abs);
  let seen = null;
  await atomicWriteFile(abs, text, async () => {
    await worktreePath(rel);
    const st = await fs.lstat(parent);
    if (st.isSymbolicLink() || !st.isDirectory()) throw parentChanged();
    seen = { dev: st.dev, ino: st.ino };
  });
  let after;
  try {
    after = await fs.lstat(parent);
  } catch {
    throw parentChanged();
  }
  if (!seen || after.isSymbolicLink() || !after.isDirectory() || after.dev !== seen.dev || after.ino !== seen.ino) {
    throw parentChanged();
  }
}

async function gitShow(rev, rel) {
  try {
    const shown = await runGit(["-C", VAULT, "show", rev + ":" + rel], { timeoutMs: 8000 });
    return shown.out;
  } catch {
    return "";
  }
}

async function gitBlob(rev, rel) {
  if (!rev || !isSafeRel(rel)) return "missing";
  try {
    const shown = await runGit(
      ["-C", VAULT, "rev-parse", "--verify", "--end-of-options", rev + ":" + rel],
      { timeoutMs: 8000 },
    );
    const oid = String(shown.out || "").trim();
    return /^[0-9a-f]{7,64}$/i.test(oid) ? oid : "missing";
  } catch {
    return "missing";
  }
}

function bindChoice(rel, item) {
  const blob = item && item.theirsBlob ? String(item.theirsBlob) : "";
  if (blob) vaultGit.choiceAgainst.set(rel, blob);
  else vaultGit.choiceAgainst.delete(rel);
}

function forgetChoice(rel) {
  const pending = vaultGit.resolvePending.delete(rel);
  const bound = vaultGit.choiceAgainst.delete(rel);
  return pending || bound;
}

async function listDiff(from, to) {
  const { out } = await runGit(
    ["-C", VAULT, "diff", "--name-only", "-z", from, to],
    { timeoutMs: 8000 },
  );
  return out.split("\0").map((item) => item.replace(/\\/g, "/")).filter((item) => isSafeRel(item));
}

async function dirtySet() {
  await ensureRecoverExcluded(VAULT);
  const { out } = await runGit(
    ["-C", VAULT, "status", "--porcelain", "-z", "-uall"],
    { timeoutMs: 8000 },
  );
  const set = new Set();
  const parts = out.split("\0");
  for (let i = 0; i < parts.length; i++) {
    const rec = parts[i];
    if (!rec || rec.length < 4) continue;
    const xy = rec.slice(0, 2);
    const file = rec.slice(3).replace(/\\/g, "/");
    if (xy[0] === "R" || xy[0] === "C" || xy[1] === "R" || xy[1] === "C") {
      const dest = String(parts[i + 1] || "").replace(/\\/g, "/");
      i += 1;
      if (isSafeRel(file) && !isRecoverPath(file)) set.add(file);
      if (isSafeRel(dest) && !isRecoverPath(dest)) set.add(dest);
      continue;
    }
    if (isSafeRel(file) && !isRecoverPath(file)) set.add(file);
  }
  return set;
}

async function unmergedFiles() {
  const { out } = await runGit(
    ["-C", VAULT, "diff", "--name-only", "-z", "--diff-filter=U"],
    { timeoutMs: 8000 },
  );
  return out.split("\0").map((item) => item.replace(/\\/g, "/")).filter((item) => isSafeRel(item));
}

async function isMerging() {
  try {
    await fs.access(path.join(VAULT, ".git", "MERGE_HEAD"));
    return true;
  } catch {
    return false;
  }
}

async function revParse(ref) {
  const { out } = await runGit(["-C", VAULT, "rev-parse", "--verify", ref], { timeoutMs: 4000 });
  return out.trim();
}

async function fetchOrigin() {
  await runGit(["-C", VAULT, "fetch", "origin"], { timeoutMs: 25000 });
  vaultGit.fetchFailed = false;
}

async function pushHead() {
  await runGit(["-C", VAULT, "push", "-u", "origin", "HEAD"], { timeoutMs: 25000 });
}

async function compareToRemote() {
  let head = "";
  try {
    head = await revParse("HEAD");
  } catch {
    return { kind: "none" };
  }
  const branch = (await runGit(
    ["-C", VAULT, "rev-parse", "--abbrev-ref", "HEAD"],
    { timeoutMs: 4000 },
  )).out.trim();
  const candidates = [];
  if (branch && branch !== "HEAD") candidates.push("origin/" + branch);
  candidates.push("origin/HEAD", "origin/main", "origin/master");
  let remote = null;
  for (const ref of candidates) {
    try {
      remote = { ref, rev: await revParse(ref) };
      break;
    } catch {}
  }
  if (!remote) return { kind: "none", head };
  if (head === remote.rev) return { kind: "equal", head, ...remote };
  let base = "";
  try {
    base = (await runGit(["-C", VAULT, "merge-base", head, remote.rev], { timeoutMs: 8000 })).out.trim();
  } catch {
    try {
      await runGit(["-C", VAULT, "fetch", "--deepen=200", "origin"], { timeoutMs: 25000 });
      remote.rev = await revParse(remote.ref);
      base = (await runGit(["-C", VAULT, "merge-base", head, remote.rev], { timeoutMs: 8000 })).out.trim();
    } catch {
      return { kind: "unknown", head, ...remote };
    }
  }
  if (!base) return { kind: "unknown", head, ...remote };
  if (base === head) return { kind: "behind", head, base, ...remote };
  if (base === remote.rev) return { kind: "ahead", head, base, ...remote };
  return { kind: "diverged", head, base, ...remote };
}

async function detachFile(rel) {
  if (!isSafeRel(rel)) return;
  const abs = await worktreePath(rel);
  const gitPath = vaultRel(abs);
  const seen = await snapshotParents(abs);
  let tracked = true;
  try {
    await runGit(["-C", VAULT, "ls-files", "--error-unmatch", "--", gitPath], { timeoutMs: 4000 });
  } catch {
    tracked = false;
  }
  await assertParents(seen);
  if (tracked) {
    await runGit(["-C", VAULT, "checkout", "HEAD", "--", gitPath], { timeoutMs: 8000 });
    return;
  }
  await fs.unlink(abs);
}

async function fastForward(rev, parkList) {
  const parked = new Map();
  pushWatchSilence();
  try {
    for (const rel of parkList || []) {
      if (!isSafeRel(rel) || parked.has(rel)) continue;
      parked.set(rel, await readRel(rel));
      await detachFile(rel);
    }
    await runGit(["-C", VAULT, "merge", "--ff-only", rev], { timeoutMs: 25000 });
    for (const [rel, text] of parked) await writeVaultText(rel, text);
  } catch (e) {
    for (const [rel, text] of parked) {
      try { await writeVaultText(rel, text); } catch {}
    }
    throw e;
  } finally {
    popWatchSilence();
  }
}

async function announcePaths(rels) {
  const seen = new Set();
  for (const rel of rels) {
    if (!isSafeRel(rel) || seen.has(rel)) continue;
    seen.add(rel);
    let abs;
    try { abs = await worktreePath(rel); } catch { continue; }
    let mtime = 0;
    try { mtime = await fileMtimeMs(abs); } catch { mtime = 0; }
    const date = dayFromRel(rel);
    if (date) sendDayWatch(date, mtime);
    else if (rel.endsWith(".md")) sendWatch({ path: rel, mtime });
  }
}

async function recordConflicts(rels, rev) {
  let forgot = false;
  for (const rel of rels) {
    if (!isSafeRel(rel) || !rel.endsWith(".md")) continue;
    const mine = await readRel(rel);
    const theirs = await gitShow(rev, rel);
    const blob = await gitBlob(rev, rel);
    if (mine === theirs) {
      if (forgetChoice(rel)) forgot = true;
      vaultGit.conflicts.delete(rel);
      continue;
    }
    const prev = vaultGit.conflicts.get(rel);
    if (prev && prev.resolved && prev.against && prev.against === blob) {
      prev.theirsBlob = blob;
      continue;
    }
    if (prev && prev.resolved) {
      forgetChoice(rel);
      forgot = true;
    }
    let mtime = 0;
    try { mtime = await fileMtimeMs(await worktreePath(rel)); } catch { mtime = 0; }
    vaultGit.conflicts.set(rel, {
      path: rel,
      mine,
      theirs,
      mtime,
      resolved: false,
      choice: null,
      theirsBlob: blob,
      against: "",
    });
  }
  if (forgot) persistPending();
}

function explicitResolve(body) {
  if (!body || typeof body !== "object") return "";
  const kind = String(body.resolve || "");
  if (kind === "keep" || kind === "theirs" || kind === "edit") return kind;
  return "";
}

function isAppNotePath(rel) {
  const s = String(rel || "").replace(/\\/g, "/");
  if (!isSafeRel(s)) return false;
  if (s.split("/").some((part) => !part || part === "." || part === ".." || part.startsWith("."))) return false;
  let abs;
  try { abs = safeJoin(VAULT, s); } catch { return false; }
  if (!contained(abs, VAULT)) return false;
  if (/^log\/\d{4}-\d{2}-\d{2}\.md$/.test(s)) return true;
  if (s === "aidanos/active-horse.md") return true;
  if (familyRoomPngPath(s)) return true;
  if (!s.endsWith(".md")) return false;
  if (kernelRel(s)) return false;
  return true;
}

function openConflict(rel) {
  const item = vaultGit.conflicts.get(String(rel || "").replace(/\\/g, "/"));
  if (!item || item.resolved) return null;
  return item;
}

async function noteChoices(paths) {
  let changed = false;
  for (const rel of paths || []) {
    if (!isAppNotePath(rel)) continue;
    const item = vaultGit.conflicts.get(rel);
    if (!item || item.resolved) continue;
    const bound = vaultGit.choiceAgainst.get(rel) || "";
    if (bound && item.theirsBlob && bound !== item.theirsBlob) {
      forgetChoice(rel);
      changed = true;
      continue;
    }
    const text = await readRel(rel);
    item.choice = text;
    item.mine = text;
    try { item.mtime = await fileMtimeMs(await worktreePath(rel)); } catch { item.mtime = 0; }
    item.against = bound || item.theirsBlob || "";
    if (item.against) vaultGit.choiceAgainst.set(rel, item.against);
    item.theirsBlob = item.theirsBlob || item.against;
    item.resolved = true;
    changed = true;
  }
  if (changed) persistPending();
}

async function dropStaleChoices(rev) {
  if (!rev) return [];
  const reopened = [];
  let changed = false;
  for (const item of [...vaultGit.conflicts.values()]) {
    if (!item || !item.resolved) continue;
    const current = await gitBlob(rev, item.path);
    const bound = item.against || vaultGit.choiceAgainst.get(item.path) || "";
    if (bound && bound === current) {
      item.against = bound;
      item.theirsBlob = current;
      continue;
    }
    const theirs = await gitShow(rev, item.path);
    const mine = await readRel(item.path);
    if (forgetChoice(item.path)) changed = true;
    if (mine === theirs) {
      vaultGit.conflicts.delete(item.path);
      changed = true;
      continue;
    }
    let mtime = 0;
    try { mtime = await fileMtimeMs(await worktreePath(item.path)); } catch { mtime = 0; }
    vaultGit.conflicts.set(item.path, {
      path: item.path,
      mine,
      theirs,
      mtime,
      resolved: false,
      choice: null,
      theirsBlob: current,
      against: "",
    });
    reopened.push(item.path);
    changed = true;
  }
  if (changed) persistPending();
  return reopened;
}

async function noteDivergence(rel) {
  const localChanged = rel.base ? await listDiff(rel.base, rel.head) : [];
  const remoteChanged = rel.base ? await listDiff(rel.base, rel.rev) : await listDiff(rel.head, rel.rev);
  const dirty = await dirtySet();
  const overlap = [];
  const seen = new Set();
  for (const file of localChanged) {
    if (!remoteChanged.includes(file) || seen.has(file)) continue;
    seen.add(file);
    overlap.push(file);
  }
  for (const file of remoteChanged) {
    if (!dirty.has(file) || seen.has(file)) continue;
    seen.add(file);
    overlap.push(file);
  }
  await recordConflicts(overlap.filter((file) => String(file).endsWith(".md")), rel.rev);
  const open = overlap.filter((file) => {
    const item = vaultGit.conflicts.get(file);
    if (item) return !item.resolved;
    return !String(file).endsWith(".md");
  });
  return { overlap: open, blocking: open };
}

async function stageAndCommit(paths) {
  await assertRealVaultRoot();
  const safe = [];
  for (const rel of paths || []) {
    if (!isAppNotePath(rel) || safe.includes(rel)) continue;
    safe.push(rel);
  }
  if (!safe.length) return false;
  const gitPaths = [];
  let stagedAny = false;
  for (const rel of safe) {
    const abs = await worktreePath(rel);
    const gitPath = vaultRel(abs);
    if (!gitPaths.includes(gitPath)) gitPaths.push(gitPath);
    if (await pathExists(abs)) {
      await runGit(["-C", VAULT, "add", "--", gitPath], { timeoutMs: 8000 });
      stagedAny = true;
    } else {
      try {
        await runGit(["-C", VAULT, "rm", "--", gitPath], { timeoutMs: 8000 });
        stagedAny = true;
      } catch {
        // This one path was never tracked.
      }
    }
  }
  if (!stagedAny) return false;
  const staged = await runGit(
    ["-C", VAULT, "diff", "--cached", "--name-only", "--", ...gitPaths],
    { timeoutMs: 8000 },
  );
  if (!String(staged.out || "").trim()) return false;
  await runGit(
    ["-C", VAULT, "commit", "-m", "vault: " + gitPaths.join(", "), "--", ...gitPaths],
    { timeoutMs: 8000 },
  );
  return true;
}

async function commitAppPaths(paths, blocked) {
  const list = [];
  for (const rel of paths || []) {
    if (!isAppNotePath(rel) || list.includes(rel)) continue;
    if (blocked && blocked.has(rel)) continue;
    if (vaultGit.conflicts.has(rel)) continue;
    list.push(rel);
  }
  if (!list.length) return false;
  return stageAndCommit(list);
}

function pendingList() {
  return [...vaultGit.pending].filter((rel) => isAppNotePath(rel));
}

function committablePending() {
  const list = [];
  for (const rel of pendingList()) {
    if (vaultGit.hold.has(rel)) continue;
    const item = vaultGit.conflicts.get(rel);
    if (item && !item.resolved) continue;
    list.push(rel);
  }
  return list;
}

async function commitPendingNotes(blocked) {
  return commitAppPaths(pendingList(), blocked);
}

async function releaseCleanPending() {
  let dirty;
  try {
    dirty = await dirtySet();
  } catch {
    return;
  }
  let changed = false;
  for (const rel of [...vaultGit.pending]) {
    if (dirty.has(rel)) continue;
    const item = vaultGit.conflicts.get(rel);
    if (item && !item.resolved) continue;
    vaultGit.pending.delete(rel);
    vaultGit.resolvePending.delete(rel);
    if (vaultGit.choiceAgainst.delete(rel)) changed = true;
    changed = true;
  }
  if (changed) persistPending();
}

async function noteUnrelated() {
  if (!vaultGit.enabled || !vaultGit.ready) return;
  vaultGit.left = "";
}

async function publishPush() {
  await pushHead();
  setGitError("");
  vaultGit.lastPushAt = Date.now();
  vaultGit.join = false;
  await releaseCleanPending();
}

async function publishDiverged(rel) {
  let useRel = rel;
  try {
    await fetchOrigin();
    const again = await compareToRemote();
    if (again && again.rev) {
      useRel = again;
      await dropStaleChoices(again.rev);
    }
  } catch (e) {
    throwIfStop(e); setGitError(e && e.message || "fetch failed");
    vaultGit.join = false;
    return;
  }
  if (hasUnresolved()) {
    vaultGit.join = false;
    if (!vaultGit.error) setGitError("push refused");
    return;
  }
  if (!useRel || useRel.kind === "none" || useRel.kind === "equal") {
    vaultGit.join = false;
    setGitError("");
    return;
  }
  if (useRel.kind === "ahead") {
    try { await publishPush(); } catch (e) { throwIfStop(e); setGitError(e && e.message || "push failed"); }
    return;
  }
  if (useRel.kind !== "diverged") {
    vaultGit.join = false;
    if (!vaultGit.error) setGitError("push refused");
    return;
  }
  const live = resolvedChoices();
  if (!live.size) {
    vaultGit.join = true;
    if (!vaultGit.error) setGitError("push refused");
    return;
  }
  const snapshot = new Map(live);
  pushWatchSilence();
  try {
    for (const relPath of snapshot.keys()) await detachFile(relPath);
    try {
      await runGit(
        ["-C", VAULT, "merge", "--no-ff", "--no-commit", useRel.rev],
        { timeoutMs: 25000 },
      );
    } catch (e) {
      if (!(await isMerging())) throw e;
    }
    const unmerged = await unmergedFiles();
    for (const file of unmerged) {
      if (!snapshot.has(file)) throw new Error("unexpected merge conflict");
    }
    for (const [file, text] of snapshot) {
      if (!isAppNotePath(file)) continue;
      await writeVaultText(file, text);
      await runGit(["-C", VAULT, "add", "--", file], { timeoutMs: 8000 });
    }
    if ((await unmergedFiles()).length) throw new Error("unresolved files remain");
    if (await isMerging()) {
      await runGit(
        ["-C", VAULT, "commit", "-m", "vault: " + [...snapshot.keys()].join(", ")],
        { timeoutMs: 8000 },
      );
    }
    await publishPush();
    vaultGit.conflicts.clear();
    vaultGit.choiceAgainst.clear();
    persistPending();
    let brought = [];
    try {
      brought = await listDiff(await revParse("HEAD^1"), await revParse("HEAD"));
    } catch {}
    await announcePaths([...snapshot.keys(), ...brought]);
  } catch (e) {
    if (await isMerging()) await runGit(["-C", VAULT, "merge", "--abort"], { timeoutMs: 8000 }).catch(() => {});
    for (const [file, text] of snapshot) {
      try { await writeVaultText(file, text); } catch {}
    }
    for (const item of vaultGit.conflicts.values()) item.resolved = false;
    throwIfStop(e); setGitError(e && e.message || "push refused");
  } finally {
    popWatchSilence();
  }
}

async function refuseJoin(rel) {
  vaultGit.join = false;
  if (rel && rel.rev) {
    await dropStaleChoices(rel.rev);
    const noted = await noteDivergence(rel);
    if (noted.blocking.length) await recordConflicts(noted.blocking, rel.rev);
  }
  if (!vaultGit.error) setGitError("push refused");
  return { status: 409, body: syncStatus() };
}

async function joinVault() {
  await assertVaultOpen();
  await fetchOrigin();
  let rel = await compareToRemote();
  if (rel && rel.rev) await dropStaleChoices(rel.rev);
  if (!rel || rel.kind === "none" || rel.kind === "equal") {
    vaultGit.join = false;
    setGitError("");
    return { status: 200, body: syncStatus() };
  }
  if (rel.kind === "ahead") {
    await publishPush();
    return { status: 200, body: syncStatus() };
  }
  if (rel.kind === "unknown") return refuseJoin(rel);
  if (rel.kind === "behind") {
    const incoming = await listDiff(rel.head, rel.rev);
    const dirty = await dirtySet();
    const overlap = incoming.filter((file) => dirty.has(file));
    if (overlap.length || hasUnresolved()) {
      if (overlap.length) await recordConflicts(overlap, rel.rev);
      return refuseJoin(null);
    }
    await fastForward(rel.rev, []);
    vaultGit.join = false;
    setGitError("");
    await announcePaths(incoming);
    return { status: 200, body: syncStatus() };
  }
  const blocked = new Set();
  const first = await noteDivergence(rel);
  for (const file of first.overlap) blocked.add(file);
  try {
    await commitPendingNotes(blocked);
  } catch (e) {
    throwIfStop(e); setGitError(e && e.message || "git failed");
  }
  await fetchOrigin();
  rel = await compareToRemote();
  if (rel && rel.rev) await dropStaleChoices(rel.rev);
  if (!rel || rel.kind === "none" || rel.kind === "equal") {
    vaultGit.join = false;
    setGitError("");
    return { status: 200, body: syncStatus() };
  }
  if (rel.kind === "ahead") {
    await publishPush();
    return { status: 200, body: syncStatus() };
  }
  if (rel.kind !== "diverged") return refuseJoin(rel);
  const noted = await noteDivergence(rel);
  if (noted.blocking.length || hasUnresolved()) return refuseJoin(null);
  const choices = resolvedChoices();
  if (choices.size) {
    await publishDiverged(rel);
    const status = syncStatus();
    return { status: status.ok ? 200 : 409, body: status };
  }
  try {
    await fetchOrigin();
    const again = await compareToRemote();
    if (again && again.rev) {
      rel = again;
      await dropStaleChoices(again.rev);
    }
  } catch (e) {
    throwIfStop(e); setGitError(e && e.message || "fetch failed");
    vaultGit.join = false;
    return { status: 409, body: syncStatus() };
  }
  if (hasUnresolved()) {
    vaultGit.join = false;
    if (!vaultGit.error) setGitError("push refused");
    return { status: 409, body: syncStatus() };
  }
  if (!rel || rel.kind === "none" || rel.kind === "equal") {
    vaultGit.join = false;
    setGitError("");
    return { status: 200, body: syncStatus() };
  }
  if (rel.kind === "ahead") {
    try { await publishPush(); } catch (e) { throwIfStop(e); setGitError(e && e.message || "push failed"); }
    const status = syncStatus();
    return { status: status.ok ? 200 : 409, body: status };
  }
  if (rel.kind !== "diverged") return refuseJoin(rel);
  const late = resolvedChoices();
  if (late.size) {
    await publishDiverged(rel);
    const status = syncStatus();
    return { status: status.ok ? 200 : 409, body: status };
  }
  const incoming = await listDiff(rel.head, rel.rev);
  pushWatchSilence();
  try {
    try {
      await runGit(
        ["-C", VAULT, "merge", "--no-ff", "--no-commit", rel.rev],
        { timeoutMs: 25000 },
      );
    } catch (e) {
      if (!(await isMerging())) throw e;
    }
    const unmerged = await unmergedFiles();
    if (unmerged.length) {
      await runGit(["-C", VAULT, "merge", "--abort"], { timeoutMs: 8000 }).catch(() => {});
      await recordConflicts(unmerged, rel.rev);
      vaultGit.join = false;
      setGitError("push refused");
      return { status: 409, body: syncStatus() };
    }
    if (!(await isMerging())) {
      vaultGit.join = false;
      setGitError("");
      return { status: 200, body: syncStatus() };
    }
    const label = incoming.length ? incoming.join(", ") : "merge";
    await runGit(["-C", VAULT, "commit", "-m", "vault: " + label], { timeoutMs: 8000 });
    await publishPush();
    await announcePaths(incoming);
    return { status: 200, body: syncStatus() };
  } catch (e) {
    if (await isMerging()) await runGit(["-C", VAULT, "merge", "--abort"], { timeoutMs: 8000 }).catch(() => {});
    throwIfStop(e); setGitError(e && e.message || "push refused");
    vaultGit.join = true;
    return { status: 409, body: syncStatus() };
  } finally {
    popWatchSilence();
  }
}

function resumeBackgroundSync() {
  const wasPaused = vaultGit.syncPaused;
  vaultGit.syncPaused = false;
  if (vaultGit.error === "sync paused") vaultGit.error = "";
  if (wasPaused && vaultGit.pending.size) {
    enqueueVaultGit(() => syncVault(null)).catch((e) => {
      if (e && e.aidanosStop) {
        pauseBackgroundSync(e);
        return;
      }
      setGitError(e && e.message || "git failed");
    });
  }
  if (!vaultGit.syncTimer) startVaultSyncLoop();
}

async function syncVault(commitPaths, resolvePaths) {
  if (!vaultGit.enabled || !vaultGit.ready) return;
  if (Array.isArray(commitPaths)) {
    let changed = false;
    for (const rel of commitPaths) {
      if (!isAppNotePath(rel) || vaultGit.pending.has(rel)) continue;
      vaultGit.pending.add(rel);
      changed = true;
    }
    if (Array.isArray(resolvePaths)) {
      for (const rel of resolvePaths) {
        if (!isAppNotePath(rel)) continue;
        vaultGit.pending.add(rel);
        if (!vaultGit.resolvePending.has(rel)) changed = true;
        vaultGit.resolvePending.add(rel);
      }
    }
    if (changed) persistPending();
  }
  if (vaultGit.syncPaused) return;
  try {
    await assertVaultOpen();
    await releaseRememberedGitLock();
    await syncVaultBody();
  } catch (e) {
    if (e && e.aidanosStop) {
      pauseBackgroundSync(e);
      return;
    }
    if (clientRefusal(e) && String(e && e.message || "") === "symlink: .") {
      const err = new Error("root");
      err.code = "ELOOP";
      pauseBackgroundSync(tagStop(err, "git"));
      return;
    }
    throwIfStop(e);
    setGitError(e && e.message || "git failed");
  } finally {
    if (!vaultGit.fetchFailed) refreshHold();
    await noteUnrelated().catch(() => {});
    finishGitNotice();
  }
}

async function commitPendingNow() {
  if (!vaultGit.fetchFailed) refreshHold();
  const ready = committablePending();
  if (!ready.length) return false;
  return stageAndCommit(ready);
}

async function syncVaultBody() {
  const resolving = [...vaultGit.resolvePending].filter((rel) => isAppNotePath(rel));
  if (resolving.length) await noteChoices(resolving);

  let rel = null;
  try {
    await fetchOrigin();
    rel = await compareToRemote();
  } catch (e) {
    vaultGit.fetchFailed = true;
    throwIfStop(e); setGitError(e && e.message || "fetch failed");
    try {
      if (await commitPendingNow()) await publishPush();
    } catch (pushErr) {
      setGitError(pushErr && pushErr.message || "push failed");
    }
    return;
  }

  if (!rel || rel.kind === "none") {
    try {
      if (await commitPendingNow()) await publishPush();
    } catch (e) {
      throwIfStop(e); setGitError(e && e.message || "push failed");
    }
    return;
  }

  if (rel.kind === "unknown") {
    setGitError("push refused");
    try { await commitPendingNow(); } catch (e) { throwIfStop(e); setGitError(e && e.message || "git failed"); }
    return;
  }

  if (rel.kind === "behind") {
    if (rel.rev) await dropStaleChoices(rel.rev);
    const incoming = await listDiff(rel.head, rel.rev);
    const dirty = await dirtySet();
    const overlap = incoming.filter((file) => dirty.has(file));
    await recordConflicts(overlap.filter((file) => String(file).endsWith(".md")), rel.rev);
    const still = overlap.filter((file) => {
      if (!String(file).endsWith(".md")) return true;
      const item = vaultGit.conflicts.get(file);
      return item && !item.resolved;
    });
    if (still.length) {
      if (!vaultGit.error) setGitError("push refused");
      return;
    }
    const choices = resolvedChoices();
    const park = [];
    for (const file of choices.keys()) {
      if (incoming.includes(file) || overlap.includes(file)) park.push(file);
    }
    try {
      await fastForward(rel.rev, park);
    } catch (e) {
      await recordConflicts(overlap, rel.rev);
      throwIfStop(e); setGitError(e && e.message || "push refused");
      return;
    }
    await announcePaths(incoming);
    for (const file of park) vaultGit.conflicts.delete(file);
    if (!hasUnresolved()) {
      setGitError("");
      vaultGit.join = false;
    }
  } else if (rel.kind === "diverged") {
    if (rel.rev) await dropStaleChoices(rel.rev);
    const noted = await noteDivergence(rel);
    const blocked = new Set(noted.overlap || []);
    for (const item of vaultGit.conflicts.values()) {
      if (!item.resolved) blocked.add(item.path);
    }
    try {
      await commitAppPaths(pendingList(), blocked);
    } catch (e) {
      throwIfStop(e); setGitError(e && e.message || "git failed");
    }
    if (noted.blocking.length || hasUnresolved()) {
      vaultGit.join = false;
      try {
        await publishPush();
      } catch (e) {
        throwIfStop(e); setGitError(e && e.message || "push refused");
      }
      if ((noted.blocking.length || hasUnresolved()) && !vaultGit.error) setGitError("push refused");
      return;
    }
    const choices = resolvedChoices();
    if (choices.size) {
      const remoteChanged = rel.base ? await listDiff(rel.base, rel.rev) : [];
      const waiting = remoteChanged.filter((file) => !choices.has(file));
      if (waiting.length) {
        vaultGit.join = true;
        try {
          await publishPush();
        } catch (e) {
          throwIfStop(e); setGitError(e && e.message || "push refused");
          vaultGit.join = true;
        }
        if (vaultGit.join && !vaultGit.error) setGitError("push refused");
        return;
      }
      vaultGit.join = false;
      await publishDiverged(rel);
      return;
    }
    vaultGit.join = true;
    try {
      await publishPush();
    } catch (e) {
      throwIfStop(e); setGitError(e && e.message || "push refused");
      vaultGit.join = true;
    }
    if (vaultGit.join && !vaultGit.error) setGitError("push refused");
    return;
  } else if (!hasUnresolved()) {
    setGitError("");
    vaultGit.join = false;
  }

  let committed = false;
  try {
    committed = await commitPendingNow();
  } catch (e) {
    throwIfStop(e); setGitError(e && e.message || "git failed");
    return;
  }
  let ahead = rel.kind === "ahead";
  if (committed) {
    try {
      const again = await compareToRemote();
      ahead = !again || again.kind === "ahead" || again.kind === "none" || again.kind === "equal";
      if (again && (again.kind === "behind" || again.kind === "diverged")) {
        await syncVaultBody();
        return;
      }
    } catch {}
  }
  if (committed || ahead) {
    try {
      await publishPush();
    } catch (e) {
      throwIfStop(e); setGitError(e && e.message || "push failed");
      try {
        await fetchOrigin();
        const again = await compareToRemote();
        if (again && (again.kind === "diverged" || again.kind === "behind")) {
          if (again.rev) await dropStaleChoices(again.rev);
          if (again.kind === "diverged") {
            const noted = await noteDivergence(again);
            try {
              await commitAppPaths(pendingList(), new Set(noted.overlap || []));
            } catch (commitErr) {
              setGitError(commitErr && commitErr.message || "git failed");
            }
            if (!noted.blocking.length && !hasUnresolved()) {
              vaultGit.join = true;
              if (!vaultGit.error) setGitError("push refused");
            } else {
              vaultGit.join = false;
            }
          } else {
            const incoming = await listDiff(again.head, again.rev);
            const dirty = await dirtySet();
            await recordConflicts(incoming.filter((file) => dirty.has(file)), again.rev);
            vaultGit.join = false;
          }
          if (hasUnresolved() && !vaultGit.error) setGitError("push refused");
        }
      } catch {}
    }
  }
}

function mondayOf(d) {
  const x = new Date(d + "T12:00:00");
  const day = x.getDay();
  const diff = day === 0 ? -6 : 1 - day;
  x.setDate(x.getDate() + diff);
  return isoDate(x);
}

function isoDate(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function todayIso() {
  return isoDate(new Date());
}

function isIsoDate(value) {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function addDays(iso, n) {
  const x = new Date(iso + "T12:00:00");
  x.setDate(x.getDate() + n);
  return isoDate(x);
}

async function readFileSafe(p) {
  let target;
  try {
    target = await readableTarget(p, VAULT);
  } catch (e) {
    if (e.message === "bad path" || e.message === "path escapes vault") return null;
    throw e;
  }
  if (target == null) return null;
  try {
    return await readRegularText(target);
  } catch (e) {
    if (e.message === "bad path" || e.code === "ENOENT") return null;
    throw e;
  }
}

function parseFrontmatter(raw) {
  const meta = {};
  let body = raw;
  if (raw.startsWith("---\n")) {
    const end = raw.indexOf("\n---\n", 4);
    if (end !== -1) {
      const fm = raw.slice(4, end);
      body = raw.slice(end + 5);
      for (const line of fm.split("\n")) {
        const m = line.match(/^([a-zA-Z0-9_]+):\s*(.*)$/);
        if (!m) continue;
        let v = m[2].trim();
        if (
          (v.startsWith('"') && v.endsWith('"')) ||
          (v.startsWith("'") && v.endsWith("'"))
        ) {
          v = v.slice(1, -1);
        }
        if (v === "true") v = true;
        else if (v === "false") v = false;
        meta[m[1]] = v;
      }
    }
  }
  return { meta, body };
}

function parseTaskLine(line) {
  const m = String(line || "").match(/^\s*[-*+]\s+\[([ xX])\]\s*(.*)$/);
  if (!m) return null;
  return { done: m[1].toLowerCase() === "x", text: m[2].trim() };
}

function parseCheckboxes(text) {
  if (!text || !text.trim()) return [];
  const items = [];
  for (const line of text.split("\n")) {
    const item = parseTaskLine(line);
    if (item) items.push(item);
  }
  return items;
}

function headingIndex(lines, name) {
  const want = `## ${name}`;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trimEnd() === want) return i;
  }
  return -1;
}

function nextHeadingIndex(lines, from) {
  for (let i = from; i < lines.length; i++) {
    if (/^## /.test(lines[i])) return i;
  }
  return lines.length;
}

function getSection(body, name) {
  const lines = (body || "").split("\n");
  const start = headingIndex(lines, name);
  if (start === -1) return "";
  const end = nextHeadingIndex(lines, start + 1);
  return lines.slice(start + 1, end).join("\n").replace(/\s+$/, "");
}

function parseWeekMarkdown(raw, weekStart) {
  const days = [];
  const lines = raw.split("\n");
  let inTable = false;
  for (const line of lines) {
    if (line.startsWith("| date ")) {
      inTable = true;
      continue;
    }
    if (inTable && line.startsWith("|---")) continue;
    if (inTable && line.startsWith("|")) {
      const cells = line
        .split("|")
        .map((c) => c.trim())
        .filter((_, i, a) => i > 0 && i < a.length - 1);
      if (cells.length >= 4 && cells[0] !== "date") {
        days.push({
          date: cells[0],
          role: cells[1] || "",
          energy: (cells[2] || "green").toLowerCase(),
          mission_eve: String(cells[3]).toLowerCase() === "true",
          summary: cells[4] || "",
        });
      }
      continue;
    }
    if (inTable && !line.startsWith("|")) inTable = false;
  }
  if (days.length < 7) {
    const byDate = Object.fromEntries(days.map((d) => [d.date, d]));
    const filled = [];
    for (let i = 0; i < 7; i++) {
      const d = addDays(weekStart, i);
      filled.push(
        byDate[d] || {
          date: d,
          role: "",
          energy: "",
          mission_eve: false,
          summary: "",
        }
      );
    }
    return filled;
  }
  return days.slice(0, 7);
}

function parseBullets(text) {
  if (!text || !text.trim()) return [];
  return text
    .split("\n")
    .map((line) => line.replace(/^- /, "").trim())
    .filter(Boolean);
}

function parsePlan(raw) {
  if (!raw) {
    return { title: "", subtitle: "", why: "", steps: [], parked: [] };
  }
  const { meta, body } = parseFrontmatter(raw);
  const h1 = (body.match(/^#\s+(.+)$/m) || [])[1];
  return {
    title: meta.title || h1 || "",
    subtitle: meta.subtitle || "",
    why: getSection(body, "Why").trim(),
    steps: parseCheckboxes(getSection(body, "Next steps")),
    parked: parseBullets(getSection(body, "Waiting")),
  };
}

function contained(abs, root) {
  const resolved = path.resolve(abs);
  const rootResolved = path.resolve(root);
  return resolved === rootResolved || resolved.startsWith(rootResolved + path.sep);
}

function safeJoin(root, rel) {
  let decoded;
  try {
    decoded = decodeURIComponent(String(rel || "").split("?")[0]);
  } catch {
    throw new Error("bad path");
  }
  const cleaned = decoded.replace(/\\/g, "/").replace(/^\/+/, "");
  if (!cleaned || cleaned.includes("\0")) {
    throw new Error("bad path");
  }
  if (cleaned.length > 400) throw new Error("bad path");
  const parts = cleaned.split("/").filter((p) => p && p !== ".");
  if (parts.some((p) => p.length > 200 || Buffer.byteLength(p) > 200)) {
    throw new Error("bad path");
  }
  if (parts.some((p) => p === ".." || p.startsWith("."))) {
    throw new Error("path escapes vault");
  }
  const resolved = path.resolve(root, ...parts);
  if (!contained(resolved, root)) {
    throw new Error("path escapes vault");
  }
  return resolved;
}

async function resolveInside(root, abs) {
  const rootReal = await fs.realpath(root);
  let cursor = path.resolve(abs);
  for (;;) {
    try {
      const real = await fs.realpath(cursor);
      if (!contained(real, rootReal)) {
        throw new Error("path escapes vault");
      }
      return abs;
    } catch (e) {
      if (e.code !== "ENOENT") throw e;
      const parent = path.dirname(cursor);
      if (parent === cursor) throw new Error("bad path");
      cursor = parent;
    }
  }
}

function applySafeHeaders(res) {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
  res.setHeader(
    "Content-Security-Policy",
    "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'"
  );
}

function sameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  const host = req.headers.host;
  if (!host) return false;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

function isMutating(method) {
  return method !== "GET" && method !== "HEAD" && method !== "OPTIONS";
}

async function listMdTree(dir, vaultRoot, skipped, gitLinks) {
  const out = [];
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const e of entries) {
    if (e.name.startsWith(".")) continue;
    if (e.name.endsWith(".tmp") || e.name.endsWith(".recover")) continue;
    const p = path.join(dir, e.name);
    const rel = path.relative(vaultRoot, p).split(path.sep).join("/");
    if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) continue;
    if (e.isSymbolicLink() || (gitLinks && gitLinks.has(rel))) {
      rememberSkip(skipped, rel);
      continue;
    }
    if (e.isDirectory()) {
      out.push(...(await listMdTree(p, vaultRoot, skipped, gitLinks)));
    } else if (e.isFile() && e.name.endsWith(".md")) {
      out.push(rel);
    }
  }
  return out.sort((a, b) => a.localeCompare(b));
}

function dayMarkdownFromBody(body) {
  if (typeof body === "string") return body;
  if (!body || typeof body !== "object") return "";
  if (typeof body.markdown === "string") return body.markdown;
  return "";
}

async function readBody(req) {
  const chunks = [];
  let n = 0;
  try {
    for await (const c of req) {
      n += c.length;
      if (n > MAX_BODY) {
        const err = new Error("too large");
        err.code = "BODY_TOO_LARGE";
        throw err;
      }
      chunks.push(c);
    }
  } catch (e) {
    if (e && e.code === "BODY_TOO_LARGE") throw e;
    if (isClientAbort(e) || req.aborted) {
      const err = e instanceof Error ? e : new Error("aborted");
      if (!err.code) err.code = "ECONNRESET";
      throw err;
    }
    throw e;
  }
  if (req.aborted) {
    const err = new Error("aborted");
    err.code = "ECONNRESET";
    throw err;
  }
  const declared = req.headers["content-length"];
  if (declared != null && declared !== "" && Number(declared) !== n) {
    const err = new Error("aborted");
    err.code = "ECONNRESET";
    throw err;
  }
  return Buffer.concat(chunks).toString("utf8");
}

function json(res, status, obj) {
  const data = JSON.stringify(obj);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(data);
}

async function fileMtimeMs(p) {
  try {
    const st = await fs.stat(p);
    return Math.trunc(st.mtimeMs);
  } catch (e) {
    if (e.code === "ENOENT") return 0;
    throw e;
  }
}

function isSelfWrite(date, diskMtime) {
  if (pendingSelfWrites.has(date)) return true;
  const own = lastSelfWrites.get(date);
  if (own == null) return false;
  return diskMtime <= own + MTIME_SKEW_MS;
}

const pathWriteChains = new Map();

function enqueuePathWrite(key, fn) {
  const prev = pathWriteChains.get(key) || Promise.resolve();
  const run = enqueueVaultWork(() => prev.then(fn, fn));
  pathWriteChains.set(key, run);
  run.then(
    () => {
      if (pathWriteChains.get(key) === run) pathWriteChains.delete(key);
    },
    () => {
      if (pathWriteChains.get(key) === run) pathWriteChains.delete(key);
    },
  );
  return run;
}

function sameTextAlreadyStored(exists, raw, markdown, conflict, resolve) {
  if (!exists || typeof raw !== "string" || raw !== markdown) return false;
  if (conflict || resolve) return false;
  return true;
}

function testHoldDir(name) {
  if (process.env.NODE_ENV !== "test") return "";
  return String(process.env[name] || "").trim();
}

async function holdRenameForTest() {
  const dir = testHoldDir("AIDANOS_TEST_HOLD_RENAME");
  if (!dir) return;
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, "hold"), "1");
  const go = path.join(dir, "go");
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    try {
      await fs.access(go);
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 20));
    }
  }
}

async function holdWriteForTest() {
  const dir = testHoldDir("AIDANOS_TEST_HOLD_WRITE");
  if (!dir) return;
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, "hold"), "1");
  const go = path.join(dir, "go");
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    try {
      await fs.access(go);
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 20));
    }
  }
}

async function refuseExistingTarget(filePath) {
  let st;
  try {
    st = await fs.lstat(filePath);
  } catch (e) {
    if (e.code === "ENOENT") return null;
    throw e;
  }
  if (st.isSymbolicLink()) throw symlinkError(vaultRel(filePath));
  if (st.isDirectory()) {
    const err = new Error("not a file");
    err.code = "EISDIR";
    throw err;
  }
  // A note and a picture must not be written through a hard link or a pipe.
  if (!st.isFile() || st.nlink > 1) {
    const err = new Error("bad path");
    err.code = "BAD_PATH";
    throw err;
  }
  return { dev: st.dev, ino: st.ino };
}

async function atomicWriteFile(filePath, markdown, beforeRename) {
  const notes = !Buffer.isBuffer(markdown);
  const existing = await refuseExistingTarget(filePath);
  if (notes && noteSaveStyle(filePath) === "in-place") {
    await mkdirNoFollow(path.dirname(filePath));
    const seen = await snapshotParents(filePath);
    await assertParents(seen);
    if (beforeRename) await beforeRename();
    await assertParents(seen);
    // The hold sits after the last parent check and before the open, which
    // is the window where a swapped parent used to be written.
    await holdWriteForTest();
    try {
      await writeNoteText(filePath, markdown, {
        swapInRequested: false,
        expectFile: existing,
        vaultRoot: VAULT,
        parents: seen,
        async afterOpen() {
          await assertParents(seen);
        },
      });
    } catch (e) {
      throwIfStop(e);
      if (e && e.code === "DIRFD") throw e;
      if (clientRefusal(e)) throw e;
      const code = e && e.code;
      if ((code === "EISDIR" || code === "ENOTDIR") && !e.aidanosStop) {
        const err = new Error("not a file");
        err.code = code;
        throw err;
      }
      throw tagStop(e, "write");
    }
    await assertParents(seen);
    return;
  }
  await mkdirNoFollow(path.dirname(filePath));
  const seen = await snapshotParents(filePath);
  await holdWriteForTest();
  const tmpPath = `${filePath}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;
  let fh = null;
  let openedId = null;
  try {
    fh = await fs.open(tmpPath, "wx");
    openedId = await assertOpenedTemp(fh, tmpPath);
    await assertParents(seen);
    if (Buffer.isBuffer(markdown)) await fh.writeFile(markdown);
    else await fh.writeFile(markdown, { encoding: "utf8" });
    await fh.close();
    fh = null;
    if (beforeRename) await beforeRename();
    await assertParents(seen);
    await holdRenameForTest();
    try {
      await fs.rename(tmpPath, filePath);
    } catch (e) {
      throw tagStop(e, "rename");
    }
    await assertParents(seen);
  } catch (e) {
    if (fh) {
      try { await fh.close(); } catch { /* closed */ }
    }
    if (openedId) await unlinkIfSameFile(tmpPath, openedId);
    const code = e && e.code;
    if ((code === "EISDIR" || code === "ENOTDIR") && !e.aidanosStop) {
      const err = new Error("not a file");
      err.code = code;
      throw err;
    }
    throwIfStop(e);
    if (e && e.code === "DIRFD") throw e;
    if (clientRefusal(e)) throw e;
    throw tagStop(e, "write");
  }
}

function atomicWriteDay(logPath, markdown) {
  return atomicWriteFile(logPath, markdown);
}


function normalizeSeasonPlanMarkdown(md) {
  let s = String(md ?? "").replace(/\r\n/g, "\n");
  s = s.replace(/^(\s*)[-*+]\s+\[[ xX]\]\s+(#{1,6}\s+)/gm, "$1$2");
  s = s.replace(/^Sit:\s*stay on plan\.\s*$/gmi, "");
  if (s.startsWith("---\n")) {
    s = s.replace(/^(---\n[\s\S]*?\S)---(\n)/, "$1\n---$2");
  }
  // collapse extra blank lines from Sit: strip
  s = s.replace(/\n{3,}/g, "\n\n");
  return s;
}

function kernelRel(rel) {
  const top = String(rel || "").replace(/\\/g, "/").replace(/^\/+/, "").split("/")[0].toLowerCase();
  return top === "log" || top === "tasks" || top === "aidanos";
}

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function familyRoomPngPath(rel) {
  const p = String(rel || "").replace(/\\/g, "/");
  if (p === "family-room-to-office/plan.png" || p === "family-room-to-office/walk.png") return p;
  return "";
}

function isPngBuffer(buf) {
  return Buffer.isBuffer(buf) && buf.length >= PNG_SIG.length && buf.subarray(0, PNG_SIG.length).equals(PNG_SIG);
}

function refusalMessage(err) {
  if (err && (err.code === "BAD_PATH" || err.code === "EEXIST" || err.code === "ELOOP")) return "bad path";
  const msg = err && err.message;
  if (msg === "EEXIST" || msg === "ELOOP") return "bad path";
  if (msg === "bad path" || msg === "path escapes vault" || msg === "bad png" || msg === "not a file") return msg;
  if (typeof msg === "string" && msg.startsWith("symlink: ")) {
    const named = msg.slice("symlink: ".length);
    if (!named || named.startsWith("/") || named.includes("..") || named.includes("\\") || named.includes("\0")) {
      return "bad path";
    }
    return msg;
  }
  return "";
}

function publicPathError(e) {
  return refusalMessage(e) || "bad path";
}

// Bad path, containment, and a named symlink stay 400. Anything else is unexpected.
function clientRefusal(err) {
  return refusalMessage(err);
}

function tagStop(err, step) {
  const error = err instanceof Error ? err : new Error("failed");
  error.aidanosStop = step;
  if (!error.code) error.code = "EIO";
  return error;
}

function throwIfStop(err) {
  if (err && err.aidanosStop) throw err;
}

function parentChanged(step) {
  const err = new Error("parent changed");
  err.code = "PARENT";
  return tagStop(err, step || "write");
}

function pauseBackgroundSync(err) {
  vaultGit.syncPaused = true;
  if (vaultGit.syncTimer) {
    clearTimeout(vaultGit.syncTimer);
    vaultGit.syncTimer = null;
  }
  if (vaultGit.timer) {
    clearTimeout(vaultGit.timer);
    vaultGit.timer = null;
  }
  vaultGit.error = "sync paused";
  const step = err && err.aidanosStop ? String(err.aidanosStop) : "git";
  const code = err && err.code ? String(err.code) : "EIO";
  console.error("sync paused: " + step + " " + code);
}

async function assertRealVaultRoot() {
  let st;
  try {
    st = await fs.lstat(VAULT);
  } catch (e) {
    if (e.code === "ENOENT") return;
    throw e;
  }
  if (st.isSymbolicLink()) throw symlinkError(".");
}

async function assertVaultOpen() {
  await assertRealVaultRoot();
  let dh;
  try {
    dh = await fs.opendir(VAULT);
  } catch (e) {
    throw tagStop(e, "git");
  }
  await dh.close();
}

async function mkdirNoFollow(dir) {
  await assertRealVaultRoot();
  const root = path.resolve(VAULT);
  const target = path.resolve(dir);
  const rel = path.relative(root, target);
  if (target !== root && (!rel || rel.startsWith("..") || path.isAbsolute(rel))) {
    throw parentChanged();
  }
  const parts = !rel || rel === "." ? [] : rel.split(path.sep);
  let cursor = root;
  for (const part of parts) {
    cursor = path.join(cursor, part);
    let st = null;
    try {
      st = await fs.lstat(cursor);
    } catch (e) {
      if (e.code !== "ENOENT") throw tagStop(e, "write");
    }
    if (reservedDirName(part)) throw new Error("bad path");
    if (!st) {
      try {
        await fs.mkdir(cursor);
      } catch (e) {
        if (e.code !== "EEXIST") throw tagStop(e, "write");
      }
      try {
        st = await fs.lstat(cursor);
      } catch (e) {
        throw tagStop(e, "write");
      }
    }
    if (st.isSymbolicLink()) throw symlinkError(vaultRel(cursor));
    if (!st.isDirectory()) throw new Error("bad path");
  }
}

async function snapshotParents(filePath) {
  await assertRealVaultRoot();
  const root = path.resolve(VAULT);
  const parent = path.resolve(path.dirname(filePath));
  const rel = path.relative(root, parent);
  if (rel.startsWith("..") || path.isAbsolute(rel)) throw parentChanged();
  const parts = !rel || rel === "." ? [] : rel.split(path.sep);
  const seen = [];
  let cursor = root;
  const rootSt = await fs.lstat(cursor);
  if (rootSt.isSymbolicLink()) throw symlinkError(".");
  if (!rootSt.isDirectory()) throw new Error("bad path");
  seen.push({ abs: cursor, dev: rootSt.dev, ino: rootSt.ino });
  for (const part of parts) {
    cursor = path.join(cursor, part);
    let st;
    try {
      st = await fs.lstat(cursor);
    } catch {
      throw parentChanged();
    }
    if (st.isSymbolicLink()) throw symlinkError(vaultRel(cursor));
    if (!st.isDirectory()) throw new Error("bad path");
    seen.push({ abs: cursor, dev: st.dev, ino: st.ino });
  }
  return seen;
}

async function assertParents(seen) {
  for (const item of seen) {
    let st;
    try {
      st = await fs.lstat(item.abs);
    } catch {
      throw parentChanged();
    }
    if (st.isSymbolicLink() || !st.isDirectory() || st.dev !== item.dev || st.ino !== item.ino) {
      throw parentChanged();
    }
  }
}

function reservedDirName(part) {
  const name = String(part || "").toLowerCase();
  return name.endsWith(".png") || name.endsWith(".md") || name.endsWith(".css");
}

async function assertOpenedTemp(fh, tmpPath) {
  const opened = await fh.stat();
  let listed;
  try {
    listed = await fs.lstat(tmpPath);
  } catch (e) {
    throw tagStop(e, "write");
  }
  if (listed.isSymbolicLink() || !listed.isFile() || listed.dev !== opened.dev || listed.ino !== opened.ino) {
    throw parentChanged();
  }
  return { dev: opened.dev, ino: opened.ino };
}

async function unlinkIfSameFile(filePath, id) {
  let st;
  try {
    st = await fs.lstat(filePath);
  } catch {
    return;
  }
  if (st.isSymbolicLink() || st.dev !== id.dev || st.ino !== id.ino) return;
  try { await fs.unlink(filePath); } catch { /* already gone */ }
}

async function gitSymlinkSet() {
  try {
    const st = await fs.lstat(path.join(VAULT, ".git"));
    if (!st || st.isSymbolicLink()) return new Set();
  } catch {
    return new Set();
  }
  try {
    const { out } = await runGit(["-C", VAULT, "ls-files", "-s", "-z"], { timeoutMs: 8000 });
    const set = new Set();
    for (const rec of String(out || "").split("\0")) {
      if (!rec.startsWith("120000 ")) continue;
      const tab = rec.lastIndexOf("\t");
      if (tab === -1) continue;
      const rel = rec.slice(tab + 1).replace(/\\/g, "/");
      if (isSafeRel(rel)) set.add(rel);
    }
    return set;
  } catch {
    return new Set();
  }
}

function isClientAbort(err) {
  if (!err || typeof err !== "object") return false;
  const code = err.code;
  if (code === "ECONNRESET" || code === "EPIPE" || code === "ECONNABORTED" || code === "ERR_STREAM_PREMATURE_CLOSE") {
    return true;
  }
  const msg = String(err.message || "");
  return msg === "aborted" || msg === "request aborted";
}

function refuse(res, err) {
  const msg = typeof err === "string" ? err : publicPathError(err);
  console.error("refused: " + oneLine(msg));
  return json(res, 400, { error: msg });
}

function stopLine(err) {
  const step = err && err.aidanosStop ? String(err.aidanosStop) : "write";
  const code = err && err.code ? String(err.code) : "EIO";
  if (!/^[a-z]+$/.test(step) || !/^[A-Za-z0-9_]+$/.test(code)) return "stopped: write EIO";
  return "stopped: " + step + " " + code;
}

function stopAfterResponse(res, err) {
  console.error(stopLine(err));
  const finish = () => process.exit(1);
  if (!res || res.headersSent) {
    finish();
    return;
  }
  const body = JSON.stringify({ error: "internal error" });
  res.writeHead(500, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body, finish);
  setTimeout(finish, 2000).unref();
}

async function familyRoomPngReal(relPath, abs) {
  const want = familyRoomPngPath(relPath);
  if (!want) throw new Error("bad path");
  await assertRealVaultRoot();
  const logicalRoot = path.resolve(VAULT);
  const logical = path.resolve(abs);
  const rel = path.relative(logicalRoot, logical).split(path.sep).join("/");
  if (rel !== want) throw new Error("path escapes vault");
  const parts = rel.split("/");
  let cursor = logicalRoot;
  for (let i = 0; i < parts.length; i++) {
    cursor = path.join(cursor, parts[i]);
    let st;
    try {
      st = await fs.lstat(cursor);
    } catch (e) {
      if (e.code === "ENOENT") return logical;
      throw new Error("bad path");
    }
    if (st.isSymbolicLink()) throw symlinkError(parts.slice(0, i + 1).join("/"));
    if (i < parts.length - 1 && !st.isDirectory()) throw new Error("bad path");
  }
  return logical;
}

async function readFamilyRoomPng(filePath) {
  let listed;
  try {
    listed = await fs.lstat(filePath);
  } catch (e) {
    if (e.code === "ENOENT") return null;
    throw new Error("bad path");
  }
  // A symlink, pipe, or directory must not be opened. A hard link shares its
  // inode with another name, so the path check alone would return that file.
  if (listed.isSymbolicLink() || !listed.isFile() || listed.nlink > 1) throw new Error("bad path");
  if (listed.size > MAX_BODY || listed.size < PNG_SIG.length) throw new Error("bad png");
  const flags = fsSync.constants.O_RDONLY
    | (fsSync.constants.O_NOFOLLOW || 0)
    | (fsSync.constants.O_NONBLOCK || 0);
  let fh;
  try {
    fh = await fs.open(filePath, flags);
  } catch (e) {
    if (e.code === "ENOENT") return null;
    throw new Error("bad path");
  }
  try {
    const st = await fh.stat();
    if (!st.isFile() || st.nlink > 1) throw new Error("bad path");
    if (st.size > MAX_BODY || st.size < PNG_SIG.length) throw new Error("bad png");
    const buf = Buffer.alloc(st.size);
    const { bytesRead } = await fh.read(buf, 0, st.size, 0);
    const got = buf.subarray(0, bytesRead);
    if (!isPngBuffer(got)) throw new Error("bad png");
    return Buffer.from(got);
  } finally {
    await fh.close();
  }
}

async function atomicWriteBuffer(filePath, buf) {
  await atomicWriteFile(filePath, buf);
}

function sendDayWatch(date, mtime) {
  const payload = `data: ${JSON.stringify({ date, mtime })}\n\n`;
  for (const client of sseClients) {
    try { client.write(payload); } catch {}
  }
}

function startLogWatch() {
  worktreeDir("log").then((logDir) => {
    try {
      fsSync.mkdirSync(logDir, { recursive: true });
    } catch {}
    try {
      const watcher = fsSync.watch(logDir, { persistent: true, recursive: false }, (_eventType, filename) => {
        if (!filename) return;
        const name = path.basename(String(filename));
        if (name.endsWith(".tmp")) return;
        if (!DAY_FILE_RE.test(name)) return;
        const date = name.slice(0, 10);
        const logPath = path.join(logDir, name);
        fsSync.lstat(logPath, (err, st) => {
          if (vaultGit.suppressWatch) return;
          if (err || !st || !st.isFile()) return;
          const mtime = Math.trunc(st.mtimeMs);
          // Own writes are already announced by the save. Ignore the echo.
          if (isSelfWrite(date, mtime)) return;
          sendDayWatch(date, mtime);
        });
      });
      watcher.on("error", (err) => {
        logSafe("log watch", err);
      });
    } catch (err) {
      logSafe("log watch", err);
    }
  }).catch((err) => {
    logSafe("log watch", err);
  });
}

function sendFile(res, filePath, contentType) {
  return fs.readFile(filePath).then(
    async (buf) => {
      if (String(contentType).includes("text/html")) {
        try {
          const st = await fs.stat(path.join(PUBLIC, "app.js"));
          const v = Math.trunc(st.mtimeMs);
          buf = Buffer.from(
            String(buf).replace(/src="\/app\.js[^"]*"/, 'src="/app.js?v=' + v + '&b=door"'),
            "utf8"
          );
        } catch {}
      }
      res.writeHead(200, {
        "Content-Type": contentType,
        "Cache-Control": "no-store",
      });
      res.end(buf);
    },
    () => {
      res.writeHead(404);
      res.end("Not found");
    }
  );
}

const server = http.createServer(async (req, res) => {
  try {
    applySafeHeaders(res);
    if (isMutating(req.method) && !sameOrigin(req)) {
      return json(res, 403, { error: "forbidden" });
    }
    const url = new URL(req.url || "/", `http://${HOST}:${PORT}`);
    const { pathname } = url;

    if (pathname === "/api/health") {
      return json(res, 200, { ok: true, git: gitHint() });
    }

    if (pathname === "/api/sync" && req.method === "GET") {
      return json(res, 200, syncStatus());
    }

    if (pathname === "/api/sync" && req.method === "POST") {
      if (!vaultGit.enabled || !vaultGit.ready) {
        return json(res, 409, syncStatus());
      }
      let body = {};
      try {
        body = JSON.parse((await readBody(req)) || "{}");
      } catch {
        body = {};
      }
      if (!body || body.join !== true) return json(res, 400, { error: "join required" });
      const wasPaused = vaultGit.syncPaused;
      let status = 200;
      let payload = null;
      try {
        await enqueueVaultGit(async () => {
          await assertVaultOpen();
          await releaseRememberedGitLock();
          const result = await joinVault();
          await noteUnrelated().catch(() => {});
          status = result.status;
          payload = syncStatus();
        });
      } catch (e) {
        throwIfStop(e);
        setGitError(e && e.message || "push refused");
        if (!hasUnresolved()) vaultGit.join = true;
        status = 409;
        payload = syncStatus();
      }
      if (status === 200) resumeBackgroundSync();
      else if (wasPaused) {
        vaultGit.syncPaused = true;
        vaultGit.error = "sync paused";
      }
      payload = syncStatus();
      finishGitNotice();
      return json(res, status, payload || syncStatus());
    }

    if (pathname === "/api/week" && req.method === "GET") {
      let start = url.searchParams.get("start");
      if (!start) start = mondayOf(todayIso());
      else if (!isIsoDate(start)) {
        return json(res, 400, { error: "start must be YYYY-MM-DD" });
      }
      const skipped = [];
      const gitLinks = await gitSymlinkSet();
      const raw = await readVaultRel(`aidanos/weeks/${start}.md`, skipped, gitLinks);
      if (!raw) {
        const days = [];
        for (let i = 0; i < 7; i++) {
          const d = addDays(start, i);
          days.push({
            date: d,
            role: "",
            energy: "",
            mission_eve: false,
            summary: "",
          });
        }
        logSkips(skipped);
        return json(res, 200, { week_start: start, days, exists: false, skippedLinks: skipped });
      }
      const days = parseWeekMarkdown(raw, start);
      await readLogNames(skipped, gitLinks);
      for (const d of days) {
        const logRaw = await readVaultRel(`log/${d.date}.md`, skipped, gitLinks);
        if (logRaw) {
          const items = parseCheckboxes(logRaw);
          d.rx_total = items.length;
          d.rx_done = items.filter((p) => p.done).length;
          d.task_open = items.filter((t) => !t.done).length;
        } else {
          d.rx_total = 0;
          d.rx_done = 0;
          d.task_open = 0;
        }
      }
      logSkips(skipped);
      return json(res, 200, { week_start: start, days, exists: true, skippedLinks: skipped });
    }

    if (pathname === "/api/day" && req.method === "GET") {
      const date = url.searchParams.get("date");
      if (!date) return json(res, 400, { error: "date required" });
      if (!isIsoDate(date)) return json(res, 400, { error: "date must be YYYY-MM-DD" });
      const dayRel = `log/${date}.md`;
      const gitLinks = await gitSymlinkSet();
      if (gitLinks.has(dayRel)) {
        const skipped = [dayRel];
        logSkips(skipped);
        return json(res, 200, { date, markdown: "", mtime: 0, skippedLinks: skipped });
      }
      let logPath;
      try {
        logPath = await worktreePath(dayRel);
      } catch (e) {
        return refuse(res, e);
      }
      const raw = await readFileSafe(logPath);
      const markdown = raw == null ? "" : raw;
      const mtime = raw == null ? 0 : await fileMtimeMs(logPath);
      return json(res, 200, { date, markdown, mtime, skippedLinks: [] });
    }

    if (pathname === "/api/month" && req.method === "GET") {
      let year;
      let month;
      const dateParam = url.searchParams.get("date");
      if (dateParam) {
        if (!isIsoDate(dateParam)) return json(res, 400, { error: "date must be YYYY-MM-DD" });
        year = Number(dateParam.slice(0, 4));
        month = Number(dateParam.slice(5, 7));
      } else {
        const yearRaw = url.searchParams.get("year");
        const monthRaw = url.searchParams.get("month");
        if (yearRaw == null || monthRaw == null) {
          return json(res, 400, { error: "year and month, or date, required" });
        }
        year = Number(yearRaw);
        month = Number(monthRaw);
        if (!Number.isInteger(year) || year < 1 || year > 9999) {
          return json(res, 400, { error: "year invalid" });
        }
        if (!Number.isInteger(month) || month < 1 || month > 12) {
          return json(res, 400, { error: "month must be 1–12" });
        }
      }
      const prefix = `${year}-${String(month).padStart(2, "0")}-`;
      const skipped = [];
      const gitLinks = await gitSymlinkSet();
      const names = await readLogNames(skipped, gitLinks);
      if (names == null) return json(res, 200, { year, month, days: [], skippedLinks: skipped });
      const days = [];
      for (const name of names) {
        if (name.endsWith(".tmp")) continue;
        if (!DAY_FILE_RE.test(name)) continue;
        if (!name.startsWith(prefix)) continue;
        const date = name.slice(0, 10);
        const raw = await readVaultRel(`log/${name}`, skipped, gitLinks);
        if (raw == null) continue;
        if (!String(raw).trim()) continue;
        days.push(date);
      }
      days.sort((a, b) => a.localeCompare(b));
      logSkips(skipped);
      return json(res, 200, { year, month, days, skippedLinks: skipped });
    }

    if (pathname === "/api/day" && req.method === "PUT") {
      const date = url.searchParams.get("date");
      if (!date) return json(res, 400, { error: "date required" });
      if (!isIsoDate(date)) return json(res, 400, { error: "date must be YYYY-MM-DD" });
      const incoming = await readBody(req);
      let body;
      try {
        body = JSON.parse(incoming);
      } catch {
        body = incoming;
      }
      const markdown = dayMarkdownFromBody(body);
      const clientMtime = body && typeof body === "object" && body.mtime != null
        ? Number(body.mtime)
        : NaN;
      const dayRel = `log/${date}.md`;
      let logPath;
      try {
        logPath = await worktreePath(dayRel);
      } catch (e) {
        return refuse(res, e);
      }
      return await enqueuePathWrite(dayRel, async () => {
        const dayLinks = await gitSymlinkSet();
        if (dayLinks.has(dayRel)) return refuse(res, "symlink: " + dayRel);
        try {
          logPath = await worktreePath(dayRel);
        } catch (e) {
          return refuse(res, e);
        }
        let diskMtime = 0;
        let exists = false;
        try {
          const st = await fs.lstat(logPath);
          if (st.isSymbolicLink()) {
            return refuse(res, "symlink: " + dayRel);
          }
          if (!st.isFile()) {
            return json(res, 400, { error: "not a file" });
          }
          exists = true;
          diskMtime = Math.trunc(st.mtimeMs);
        } catch (e) {
          if (e.code !== "ENOENT") throw e;
        }
        const raw = exists ? await readFileSafe(logPath) : null;
        const dayResolve = explicitResolve(body);
        const dayConflict = openConflict(dayRel);
        if (sameTextAlreadyStored(exists, raw, markdown, dayConflict, dayResolve)) {
          scheduleVaultSync(dayRel, false);
          return json(res, 200, { ok: true, date, mtime: diskMtime, git: gitHint() });
        }
        // A shared server's own earlier save is still a newer version.
        // The log watcher, not this check, ignores the echo of that save.
        if (
          exists &&
          Number.isFinite(clientMtime) &&
          diskMtime > clientMtime + MTIME_SKEW_MS
        ) {
          return json(res, 409, {
            error: "disk newer",
            date,
            markdown: raw == null ? "" : raw,
            mtime: diskMtime,
          });
        }
        if (dayConflict && !dayResolve) {
          return json(res, 409, {
            error: "still conflicted",
            date,
            markdown: dayConflict.theirs,
            mtime: dayConflict.mtime,
          });
        }
        pendingSelfWrites.add(date);
        try {
          await atomicWriteDay(logPath, markdown);
          const mtime = await fileMtimeMs(logPath);
          lastSelfWrites.set(date, mtime);
          sendDayWatch(date, mtime);
          if (dayResolve && dayConflict) bindChoice(dayRel, dayConflict);
          scheduleVaultSync(dayRel, Boolean(dayResolve && dayConflict));
          return json(res, 200, { ok: true, date, mtime, git: gitHint() });
        } finally {
          pendingSelfWrites.delete(date);
        }
      });
    }

    if (pathname === "/api/plan" && req.method === "GET") {
      const skipped = [];
      const gitLinks = await gitSymlinkSet();
      const raw = await readVaultRel("aidanos/active-horse.md", skipped, gitLinks);
      logSkips(skipped);
      return json(res, 200, { plan: parsePlan(raw), exists: Boolean(raw), skippedLinks: skipped });
    }

    if (pathname === "/api/open-tasks" && req.method === "GET") {
      const skipped = [];
      const gitLinks = await gitSymlinkSet();
      const names = await readLogNames(skipped, gitLinks);
      if (names == null) {
        logSkips(skipped);
        return json(res, 200, { items: [], skippedLinks: skipped });
      }
      const items = [];
      names.sort((a, b) => a.localeCompare(b));
      for (const name of names) {
        if (name.endsWith(".tmp")) continue;
        if (!DAY_FILE_RE.test(name)) continue;
        const date = name.slice(0, 10);
        const raw = await readVaultRel(`log/${name}`, skipped, gitLinks);
        if (raw == null) continue;
        const lines = raw.split("\n");
        for (let i = 0; i < lines.length; i++) {
          const item = parseTaskLine(lines[i]);
          if (item && !item.done) {
            items.push({ date, line: i, text: item.text });
          }
        }
      }
      logSkips(skipped);
      return json(res, 200, { items, skippedLinks: skipped });
    }

    if (pathname === "/api/folders" && req.method === "GET") {
      await assertRealVaultRoot();
      const skipped = [];
      const gitLinks = await gitSymlinkSet();
      const entries = await fs.readdir(VAULT, { withFileTypes: true });
      const folders = [];
      for (const e of entries) {
        if (e.name.startsWith(".")) continue;
        if (e.isSymbolicLink() || gitLinks.has(e.name)) {
          rememberSkip(skipped, e.name);
          continue;
        }
        if (!e.isDirectory()) continue;
        if (e.name === "log" || e.name === "tasks" || e.name === "aidanos") continue;
        folders.push({ name: e.name, path: e.name });
      }
      folders.sort((a, b) => a.name.localeCompare(b.name));
      logSkips(skipped);
      return json(res, 200, { folders, skippedLinks: skipped });
    }

    if (pathname === "/api/file" && req.method === "GET") {
      const rel = url.searchParams.get("path");
      if (!rel) return json(res, 400, { error: "path required" });
      let abs;
      try {
        abs = await worktreePath(rel);
        await readableTarget(abs, VAULT);
      } catch (e) {
        return refuse(res, e);
      }
      const relPath = path.relative(VAULT, abs).split(path.sep).join("/");
      const gitLinks = await gitSymlinkSet();
      if (gitLinks.has(relPath)) return refuse(res, "symlink: " + relPath);
      if (familyRoomPngPath(relPath)) {
        try {
          const real = await familyRoomPngReal(relPath, abs);
          const buf = await readFamilyRoomPng(real);
          if (buf == null) return json(res, 404, { error: "not found", path: relPath });
          res.writeHead(200, {
            "Content-Type": "image/png",
            "Cache-Control": "no-store",
            "X-Content-Type-Options": "nosniff",
          });
          res.end(buf);
          return;
        } catch (e) {
          return refuse(res, e);
        }
      }
      if (!String(relPath).endsWith(".md")) {
        return json(res, 400, { error: "markdown only" });
      }
      const raw = await readFileSafe(abs);
      if (raw == null) return json(res, 404, { error: "not found", path: relPath });
      const mtime = await fileMtimeMs(abs);
      return json(res, 200, { path: relPath, markdown: raw, mtime });
    }

    if (pathname === "/api/file" && req.method === "PUT") {
      const rel = url.searchParams.get("path");
      if (!rel) return json(res, 400, { error: "path required" });
      let abs;
      try {
        abs = await worktreePath(rel);
        await readableTarget(abs, VAULT);
      } catch (e) {
        return refuse(res, e);
      }
      const relPath = path.relative(VAULT, abs).split(path.sep).join("/");
      const gitLinks = await gitSymlinkSet();
      if (gitLinks.has(relPath)) return refuse(res, "symlink: " + relPath);
      if (familyRoomPngPath(relPath)) {
        let real;
        try {
          real = await familyRoomPngReal(relPath, abs);
        } catch (e) {
          return refuse(res, e);
        }
        const incoming = await readBody(req);
        let body;
        try {
          body = JSON.parse(incoming);
        } catch {
          return json(res, 400, { error: "bad png" });
        }
        const b64 = body && typeof body.png === "string" ? body.png : "";
        if (!b64) return json(res, 400, { error: "bad png" });
        const buf = Buffer.from(b64, "base64");
        if (!isPngBuffer(buf)) {
          return json(res, 400, { error: "bad png" });
        }
        const pngKey = "f:" + relPath;
        return await enqueuePathWrite(pngKey, async () => {
          let listed = null;
          try {
            listed = await fs.lstat(real);
          } catch (e) {
            if (e.code !== "ENOENT") throw e;
          }
          if (listed && listed.isSymbolicLink()) return refuse(res, "symlink: " + relPath);
          if (listed && listed.isDirectory()) return json(res, 400, { error: "not a file" });
          pendingSelfWrites.add(pngKey);
          try {
            await atomicWriteBuffer(real, buf);
            const mtime = await fileMtimeMs(real);
            lastSelfWrites.set(pngKey, mtime);
            scheduleVaultSync(relPath);
            return json(res, 200, { ok: true, path: relPath, mtime, git: gitHint() });
          } finally {
            pendingSelfWrites.delete(pngKey);
          }
        });
      }
      if (!String(relPath).endsWith(".md")) {
        return json(res, 400, { error: "markdown only" });
      }
      // Season Plan is editable paper; other aidanos/* stay kernel-locked
      if (kernelRel(relPath) && relPath !== "aidanos/active-horse.md") {
        return json(res, 400, { error: "kernel path" });
      }
      const incoming = await readBody(req);
      let body;
      try {
        body = JSON.parse(incoming);
      } catch {
        body = incoming;
      }
      let markdown = dayMarkdownFromBody(body);
      if (relPath === "aidanos/active-horse.md") {
        markdown = normalizeSeasonPlanMarkdown(markdown);
      }
      const clientMtime = body && typeof body === "object" && body.mtime != null
        ? Number(body.mtime)
        : NaN;
      const writeKey = "f:" + relPath;
      return await enqueuePathWrite(writeKey, async () => {
        try {
          abs = await worktreePath(rel);
          await readableTarget(abs, VAULT);
        } catch (e) {
          return refuse(res, e);
        }
        let diskMtime = 0;
        let exists = false;
        try {
          const st = await fs.lstat(abs);
          if (st.isSymbolicLink()) {
            return refuse(res, "symlink: " + relPath);
          }
          if (st.isDirectory()) {
            return json(res, 400, { error: "not a file" });
          } else {
            exists = st.isFile();
            diskMtime = Math.trunc(st.mtimeMs);
          }
        } catch (e) {
          if (e.code !== "ENOENT") throw e;
        }
        const raw = exists ? await readFileSafe(abs) : null;
        const fileResolve = explicitResolve(body);
        const fileConflict = openConflict(relPath);
        if (sameTextAlreadyStored(exists, raw, markdown, fileConflict, fileResolve)) {
          scheduleVaultSync(relPath, false);
          return json(res, 200, { ok: true, path: relPath, mtime: diskMtime, git: gitHint() });
        }
        // A shared server's own earlier save is still a newer version.
        if (
          exists &&
          Number.isFinite(clientMtime) &&
          diskMtime > clientMtime + MTIME_SKEW_MS
        ) {
          return json(res, 409, {
            error: "disk newer",
            path: relPath,
            markdown: raw == null ? "" : raw,
            mtime: diskMtime,
          });
        }
        if (fileConflict && !fileResolve) {
          return json(res, 409, {
            error: "still conflicted",
            path: relPath,
            markdown: fileConflict.theirs,
            mtime: fileConflict.mtime,
          });
        }
        pendingSelfWrites.add(writeKey);
        try {
          await atomicWriteFile(abs, markdown);
          const mtime = await fileMtimeMs(abs);
          lastSelfWrites.set(writeKey, mtime);
          sendWatch({ path: relPath, mtime });
          if (fileResolve && fileConflict) bindChoice(relPath, fileConflict);
          scheduleVaultSync(relPath, Boolean(fileResolve && fileConflict));
          return json(res, 200, { ok: true, path: relPath, mtime, git: gitHint() });
        } finally {
          pendingSelfWrites.delete(writeKey);
        }
      });
    }

    if (pathname === "/api/tree" && req.method === "GET") {
      const dirParam = url.searchParams.get("dir") || ".";
      let abs;
      try {
        abs = await worktreeDir(dirParam);
      } catch (e) {
        return refuse(res, e);
      }
      let stat;
      try {
        stat = await fs.lstat(abs);
      } catch (e) {
        if (e.code === "ENOENT") {
          return json(res, 404, { error: "directory not found", dir: dirParam });
        }
        throw e;
      }
      if (stat.isSymbolicLink()) return refuse(res, "symlink: " + String(dirParam || ".").replace(/\\/g, "/"));
      if (!stat.isDirectory()) {
        return json(res, 400, { error: "not a directory", dir: dirParam });
      }
      const skipped = [];
      const gitLinks = await gitSymlinkSet();
      const files = await listMdTree(abs, VAULT, skipped, gitLinks);
      logSkips(skipped);
      return json(res, 200, { dir: dirParam, files, skippedLinks: skipped });
    }

    if (pathname === "/api/search" && req.method === "GET") {
      const q = String(url.searchParams.get("q") || "").trim();
      if (!q) return json(res, 200, { hits: [], skippedLinks: [] });
      const needle = q.toLowerCase();
      const skipped = [];
      const gitLinks = await gitSymlinkSet();
      const files = await listMdTree(VAULT, VAULT, skipped, gitLinks);
      const hits = [];
      const MAX_HITS = 40;
      const MAX_PER_FILE = 3;
      const MAX_BYTES = 1000000;
      for (const rel of files) {
        if (!rel.endsWith(".md") || rel.endsWith(".tmp")) continue;
        const relNorm = String(rel).replace(/\\/g, "/");
        const relBase = relNorm.split("/").pop() || "";
        if (/^TODAY\.md$/i.test(relBase)) continue;
        if (relNorm.startsWith("aidanos/") && relNorm !== "aidanos/active-horse.md") continue;
        if (gitLinks.has(relNorm)) {
          rememberSkip(skipped, relNorm);
          continue;
        }
        let abs;
        try {
          abs = await worktreePath(rel);
        } catch (e) {
          const msg = String(e && e.message || "");
          if (msg.startsWith("symlink: ")) rememberSkip(skipped, msg.slice("symlink: ".length));
          continue;
        }
        let st;
        try {
          st = await fs.lstat(abs);
        } catch {
          continue;
        }
        if (st.isSymbolicLink()) {
          rememberSkip(skipped, relNorm);
          continue;
        }
        if (!st.isFile() || st.size > MAX_BYTES) continue;
        const raw = await readFileSafe(abs);
        if (raw == null) continue;
        const lines = raw.split("\n");
        let nThis = 0;
        for (let i = 0; i < lines.length; i++) {
          const text = lines[i].replace(/\r$/, "");
          if (text.toLowerCase().includes(needle)) {
            hits.push({ path: relNorm, line: i, text });
            nThis += 1;
            if (hits.length >= MAX_HITS) {
              logSkips(skipped);
              return json(res, 200, { hits, skippedLinks: skipped });
            }
            if (nThis >= MAX_PER_FILE) break;
          }
        }
      }
      logSkips(skipped);
      return json(res, 200, { hits, skippedLinks: skipped });
    }

    if (pathname === "/api/day-watch" && req.method === "GET") {
      if (sseClients.size >= MAX_SSE) {
        return json(res, 503, { error: "too many listeners" });
      }
      req.setTimeout(0);
      res.setTimeout(0);
      res.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-store",
        Connection: "keep-alive",
      });
      res.write(":\n\n");
      sseClients.add(res);
      const drop = () => sseClients.delete(res);
      req.on("close", drop);
      res.on("close", drop);
      return;
    }

    if (pathname === "/api/skin.css" && req.method === "GET") {
      const skipped = [];
      const gitLinks = await gitSymlinkSet();
      const raw = await readVaultRel("aidanos/skin.css", skipped, gitLinks);
      logSkips(skipped);
      const headers = {
        "Content-Type": "text/css; charset=utf-8",
        "Cache-Control": "no-store",
      };
      if (skipped.length) headers["X-Skipped-Links"] = skipped.join(",");
      res.writeHead(200, headers);
      res.end(raw || "/* no personal skin */\n");
      return;
    }

    let file = pathname === "/" ? "index.html" : pathname;
    let full;
    try {
      full = safeJoin(PUBLIC, file);
      await resolveInside(PUBLIC, full);
    } catch {
      res.writeHead(400);
      return res.end("Bad path");
    }
    const rel = path.relative(path.resolve(PUBLIC), full).split(path.sep).join("/");
    if (!PUBLIC_FILES.has(rel)) {
      res.writeHead(404);
      return res.end("Not found");
    }
    const ext = path.extname(full);
    const types = {
      ".html": "text/html; charset=utf-8",
      ".js": "text/javascript; charset=utf-8",
      ".css": "text/css; charset=utf-8",
      ".svg": "image/svg+xml",
      ".json": "application/json",
      ".webmanifest": "application/manifest+json",
      ".png": "image/png",
      ".ico": "image/x-icon",
    };
    return sendFile(res, full, types[ext] || "application/octet-stream");
  } catch (err) {
    if (err && err.code === "DIRFD") {
      console.error("refused: directory helper unavailable" + (err.reason ? " " + err.reason : ""));
      if (res.headersSent) return;
      return json(res, 503, { error: "directory helper unavailable" });
    }
    if (err && err.code === "BODY_TOO_LARGE") {
      if (!res.headersSent) return json(res, 413, { error: "too large" });
      return;
    }
    if (err && (err.code === "EISDIR" || err.code === "ENOTDIR") && !err.aidanosStop) {
      console.error("refused: not a file");
      if (res.headersSent) return;
      return json(res, 400, { error: "not a file" });
    }
    if (err && err.code === "EACCES" && !err.aidanosStop) {
      console.error("request failed: EACCES");
      if (res.headersSent) return;
      return json(res, 403, { error: "not readable" });
    }
    if (isClientAbort(err)) {
      if (res.headersSent) return;
      res.writeHead(400, {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
      });
      res.end(JSON.stringify({ error: "bad request" }));
      return;
    }
    const refusal = clientRefusal(err);
    if (refusal) {
      console.error("refused: " + oneLine(refusal));
      if (res.headersSent) return;
      return json(res, 400, { error: refusal });
    }
    // Only a tagged write, rename, unlink, or git step stops the process.
    // A cut-off upload, a long name, and a background sync failure stay up.
    if (err && err.aidanosStop) return stopAfterResponse(res, err);
    console.error("request failed: " + (err && err.code ? String(err.code) : "ERROR"));
    if (res.headersSent) return;
    return json(res, 500, { error: "internal error" });
  }
});

function refuseSymlinkedVaultRoot() {
  let st;
  try {
    st = fsSync.lstatSync(VAULT);
  } catch (e) {
    if (e.code === "ENOENT") return;
    throw e;
  }
  if (!st.isSymbolicLink()) return;
  // Name the configured path. logSafe would hide it, and realpath would accept the link.
  console.error(VAULT);
  console.error("Point AIDANOS_VAULT at the real folder.");
  process.exit(1);
}

async function boot() {
  refuseSymlinkedVaultRoot();
  const helperMode = groupWritableHelperMessage(path.join(__dirname, "editor", "bin"));
  if (helperMode) console.error(helperMode);
  const fault = ancestorFault(__dirname);
  if (fault) {
    console.error("refused: bad install location: " + installFaultText(fault));
    process.exit(1);
  }
  await reportRecoveryFiles(VAULT);
  await initVaultGit();
  await sweepAbandonedGitLocks(VAULT);
  await ensureRecoverExcluded(VAULT);
  startLogWatch();
  startVaultSyncLoop();
  server.on("error", (err) => {
    const code = err && err.code ? String(err.code) : "ERROR";
    logSafe([], "listen failed", code);
    process.exit(1);
  });
  server.listen(PORT, HOST, () => {
    const bound = server.address();
    const openPort = bound && typeof bound === "object" ? bound.port : PORT;
    console.log(`AidanOS`);
    console.log(`  vault: ${VAULT}`);
    if (vaultGit.enabled) {
      console.log(`  git:   ${vaultGit.error ? "error" : "on"}`);
    }
    console.log(`  host:  ${HOST}`);
    console.log(`  open:  http://${HOST === "0.0.0.0" ? "127.0.0.1" : HOST}:${openPort}`);
  });
}

function isMainModule() {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return import.meta.url === pathToFileURL(path.resolve(entry)).href;
  } catch {
    return false;
  }
}

if (isMainModule()) {
  // A rejection that escaped a handler is logged and the process stays up.
  // Write and sync failures exit from the request path, where the operation is known.
  // This log is redacted: no vault path, token, or note body.
  process.on("unhandledRejection", (reason) => {
    const err = reason instanceof Error ? reason : new Error(String(reason || "error"));
    logSafe("unhandled rejection", err);
  });
  boot().catch((err) => {
    const code = err && err.code ? String(err.code) : "";
    logSafe([], "startup failed", code || (err instanceof Error ? err.message : "error"));
    process.exit(1);
  });
}
