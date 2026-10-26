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
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

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
const PORT = Number.isInteger(PORT_RAW) && PORT_RAW > 0 && PORT_RAW < 65536 ? PORT_RAW : 3847;
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

function gitHint() {
  if (!vaultGit.enabled) return { enabled: false };
  const open = [...vaultGit.conflicts.values()].filter((item) => !item.resolved);
  const hint = { enabled: true, ok: !vaultGit.error && open.length === 0 };
  if (vaultGit.error) hint.error = vaultGit.error;
  if (vaultGit.lastPushAt) hint.pushed = true;
  if (open.length) hint.conflicts = open.map((item) => item.path);
  return hint;
}

export function gitEnv() {
  const env = {
    ...process.env,
    GIT_TERMINAL_PROMPT: "0",
    GIT_EDITOR: "true",
    GIT_MERGE_AUTOEDIT: "no",
    // Pathspecs stay literal after "--". Otherwise `Q?.md` also matches QA.md.
    GIT_LITERAL_PATHSPECS: "1",
  };
  delete env.GIT_ASKPASS;
  // These point git at another repository or inject config. Drop them from
  // every child. Leave other GIT_* alone: wiping the rest would drop the
  // editor settings above.
  const drop = [
    "GIT_DIR",
    "GIT_WORK_TREE",
    "GIT_INDEX_FILE",
    "GIT_OBJECT_DIRECTORY",
    "GIT_ALTERNATE_OBJECT_DIRECTORIES",
    "GIT_CONFIG",
    "GIT_CONFIG_GLOBAL",
    "GIT_CONFIG_SYSTEM",
    "GIT_CONFIG_COUNT",
  ];
  for (const key of Object.keys(env)) {
    if (drop.includes(key) || key.startsWith("GIT_CONFIG_KEY_") || key.startsWith("GIT_CONFIG_VALUE_")) {
      delete env[key];
    }
  }
  return env;
}

function runGit(args, { cwd, timeoutMs = 20000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, {
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
      if (code === 0) resolve({ out, err });
      else reject(new Error((err || out || ("git " + args[0] + " failed")).trim()));
    });
  });
}

async function ensureGitIdentity(cwd) {
  const name = process.env.AIDANOS_VAULT_GIT_NAME || "AidanOS";
  const email = process.env.AIDANOS_VAULT_GIT_EMAIL || "aidanos@local";
  await runGit(["-C", cwd, "config", "user.name", name], { timeoutMs: 4000 });
  await runGit(["-C", cwd, "config", "user.email", email], { timeoutMs: 4000 });
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
  if (!GIT_URL || !GIT_RETRY_MS) return;
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
    vaultGit.error = sanitizeGitError(e && e.message || "vault git failed");
    console.error("vault git:", vaultGit.error);
    await seedBundledVaultIfNeeded("vault git failed");
    scheduleVaultGitRetry();
  }
}

function isSafeRel(rel) {
  const s = String(rel || "").replace(/\\/g, "/");
  if (!s || s.startsWith("/") || s.includes("..") || s.includes("\0")) return false;
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

function enqueueVaultGit(work) {
  const run = vaultGit.chain.then(work, work);
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
  if (vaultGit.timer) clearTimeout(vaultGit.timer);
  const started = new Set(vaultGit.pending);
  vaultGit.timer = setTimeout(() => {
    vaultGit.timer = null;
    enqueueVaultGit(() => syncVault(null)).catch((e) => {
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
    vaultGit.syncTimer = setTimeout(() => {
      vaultGit.syncTimer = null;
      enqueueVaultGit(() => syncVault(null)).catch((e) => {
        setGitError(e && e.message || "git failed");
      }).finally(arm);
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
  if (!vaultGit.enabled) {
    return { enabled: false, ok: true, error: "", conflicts: [], join: false, left: "" };
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
  };
}

function finishGitNotice() {
  const status = syncStatus();
  const notice = JSON.stringify({
    error: status.error,
    conflicts: status.conflicts,
    join: status.join,
    left: status.left,
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
  const child = spawnSync("git", ["-C", rootReal, "rev-parse", "--git-dir"], {
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
// rel is vault-relative. Throws Error("bad path") when a parent symlink
// leaves the vault or lands in .git. A parent link that stays inside the
// vault is allowed. The last path part is not checked here: reads use
// readableTarget, and writes replace a leaf link. Callers (including the
// live-editor branch) pass one or two arguments and no more.
// A directory symlink is followed by a later read, write, or unlink.
// O_NOFOLLOW applies only to the last path part, so a link named like a
// folder can still aim a note at another directory.
export async function worktreePath(rel, root = VAULT) {
  if (!isSafeRel(rel)) throw new Error("bad path");
  const abs = safeJoin(root, rel);
  const logicalRoot = path.resolve(root);
  let rootReal = logicalRoot;
  try {
    rootReal = await fs.realpath(logicalRoot);
  } catch (e) {
    if (e.code !== "ENOENT") throw new Error("bad path");
  }
  const logical = path.resolve(abs);
  const relPath = path.relative(logicalRoot, logical);
  if (!relPath || relPath.startsWith("..") || path.isAbsolute(relPath)) {
    throw new Error("bad path");
  }
  const parts = relPath.split(path.sep);
  let cursor = logicalRoot;
  for (let i = 0; i < parts.length - 1; i++) {
    cursor = path.join(cursor, parts[i]);
    let st;
    try {
      st = await fs.lstat(cursor);
    } catch (e) {
      if (e.code === "ENOENT") return abs;
      throw new Error("bad path");
    }
    if (st.isSymbolicLink()) {
      let real;
      try {
        real = await fs.realpath(cursor);
      } catch {
        throw new Error("bad path");
      }
      if (!contained(real, rootReal)) throw new Error("bad path");
      if (realPathInGit(real, rootReal)) throw new Error("bad path");
      continue;
    }
    if (!st.isDirectory()) throw new Error("bad path");
  }
  return abs;
}

// Listing has no leaf file, so check the folder by asking about a child.
// worktreePath's signature stays (rel, root).
async function worktreeDir(rel, root = VAULT) {
  const cleaned = String(rel || "").replace(/\\/g, "/").replace(/\/+$/, "");
  if (!cleaned || cleaned === ".") return path.resolve(root);
  await worktreePath(cleaned + "/note.md", root);
  return safeJoin(root, cleaned);
}

async function readVaultRel(rel) {
  try {
    return await readFileSafe(await worktreePath(rel));
  } catch {
    return null;
  }
}

async function readLogNames() {
  let logDir;
  try {
    logDir = await worktreeDir("log");
  } catch {
    return null;
  }
  try {
    return await fs.readdir(logDir);
  } catch (e) {
    if (e.code === "ENOENT") return [];
    throw e;
  }
}

// Last path part on read. resolveInside allows a target that stays in the
// vault, including .git/config, so the git check is separate. Returns the
// path to read: the real file for a link, the logical path otherwise.
async function readableTarget(abs, root) {
  let st;
  try {
    st = await fs.lstat(abs);
  } catch (e) {
    if (e.code === "ENOENT") return null;
    throw new Error("bad path");
  }
  if (!st.isSymbolicLink()) return abs;
  try {
    await resolveInside(root, abs);
  } catch (e) {
    if (e.message === "path escapes vault" || e.message === "bad path") throw new Error("bad path");
    if (e.code === "ENOENT" || e.code === "ELOOP" || e.code === "ENOTDIR") throw new Error("bad path");
    throw e;
  }
  let rootReal = path.resolve(root);
  try {
    rootReal = await fs.realpath(root);
  } catch (e) {
    if (e.code !== "ENOENT") throw new Error("bad path");
  }
  let real;
  try {
    real = await fs.realpath(abs);
  } catch (e) {
    if (e.code === "ENOENT") return null;
    throw new Error("bad path");
  }
  if (!contained(real, rootReal) || realPathInGit(real, rootReal)) throw new Error("bad path");
  return real;
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

async function writeVaultText(rel, text) {
  const abs = await worktreePath(rel);
  const parent = path.dirname(abs);
  let seen = null;
  await atomicWriteFile(abs, text, async () => {
    await worktreePath(rel);
    const st = await fs.stat(parent);
    if (!st.isDirectory()) throw new Error("bad path");
    seen = { dev: st.dev, ino: st.ino };
  });
  let after;
  try {
    after = await fs.stat(parent);
  } catch {
    throw new Error("bad path");
  }
  if (!seen || !after.isDirectory() || after.dev !== seen.dev || after.ino !== seen.ino) {
    await fs.unlink(abs).catch(() => {});
    throw new Error("bad path");
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
      if (isSafeRel(file)) set.add(file);
      if (isSafeRel(dest)) set.add(dest);
      continue;
    }
    if (isSafeRel(file)) set.add(file);
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
  let tracked = true;
  try {
    await runGit(["-C", VAULT, "ls-files", "--error-unmatch", "--", gitPath], { timeoutMs: 4000 });
  } catch {
    tracked = false;
  }
  if (tracked) {
    await runGit(["-C", VAULT, "checkout", "HEAD", "--", gitPath], { timeoutMs: 8000 });
    return;
  }
  await fs.unlink(abs).catch(() => {});
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
    setGitError(e && e.message || "fetch failed");
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
    try { await publishPush(); } catch (e) { setGitError(e && e.message || "push failed"); }
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
    setGitError(e && e.message || "push refused");
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
    setGitError(e && e.message || "git failed");
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
    setGitError(e && e.message || "fetch failed");
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
    try { await publishPush(); } catch (e) { setGitError(e && e.message || "push failed"); }
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
    setGitError(e && e.message || "push refused");
    vaultGit.join = true;
    return { status: 409, body: syncStatus() };
  } finally {
    popWatchSilence();
  }
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
  try {
    await syncVaultBody();
  } catch (e) {
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
    setGitError(e && e.message || "fetch failed");
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
      setGitError(e && e.message || "push failed");
    }
    return;
  }

  if (rel.kind === "unknown") {
    setGitError("push refused");
    try { await commitPendingNow(); } catch (e) { setGitError(e && e.message || "git failed"); }
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
      setGitError(e && e.message || "push refused");
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
      setGitError(e && e.message || "git failed");
    }
    if (noted.blocking.length || hasUnresolved()) {
      vaultGit.join = false;
      try {
        await publishPush();
      } catch (e) {
        setGitError(e && e.message || "push refused");
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
          setGitError(e && e.message || "push refused");
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
      setGitError(e && e.message || "push refused");
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
    setGitError(e && e.message || "git failed");
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
      setGitError(e && e.message || "push failed");
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
  const parts = cleaned.split("/").filter((p) => p && p !== ".");
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

async function listMdTree(dir, vaultRoot) {
  const out = [];
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const e of entries) {
    if (e.name.startsWith(".")) continue;
    if (e.name.endsWith(".tmp")) continue;
    if (e.isSymbolicLink()) continue;
    const p = path.join(dir, e.name);
    const rel = path.relative(vaultRoot, p);
    if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) continue;
    if (e.isDirectory()) {
      out.push(...(await listMdTree(p, vaultRoot)));
    } else if (e.isFile() && e.name.endsWith(".md")) {
      out.push(rel.split(path.sep).join("/"));
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
  for await (const c of req) {
    n += c.length;
    if (n > MAX_BODY) {
      const err = new Error("too large");
      err.code = "BODY_TOO_LARGE";
      throw err;
    }
    chunks.push(c);
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
  const run = prev.then(fn, fn);
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

async function atomicWriteFile(filePath, markdown, beforeRename) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;
  try {
    await fs.writeFile(tmpPath, markdown, { encoding: "utf8", flag: "wx" });
    if (beforeRename) await beforeRename();
    await fs.rename(tmpPath, filePath);
  } catch (e) {
    try { await fs.unlink(tmpPath); } catch {}
    throw e;
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

function publicPathError(e) {
  const msg = e && e.message;
  if (msg === "bad path" || msg === "path escapes vault" || msg === "bad png") return msg;
  return "bad path";
}

// Bad path and containment stay 400. Anything else, including EACCES,
// is a 500 whose text is fixed and never the filesystem path.
function clientRefusal(err) {
  if (err && err.code === "BAD_PATH") return "bad path";
  const msg = err && err.message;
  if (msg === "bad path" || msg === "path escapes vault" || msg === "bad png") return msg;
  return "";
}

async function familyRoomPngReal(relPath, abs) {
  const want = familyRoomPngPath(relPath);
  if (!want) throw new Error("bad path");
  let rootReal;
  try {
    rootReal = await fs.realpath(VAULT);
  } catch {
    throw new Error("bad path");
  }
  let cursor = path.resolve(abs);
  const missing = [];
  let base = null;
  for (;;) {
    try {
      base = await fs.realpath(cursor);
      break;
    } catch (e) {
      // A raw realpath error includes the vault's absolute path.
      if (e.code !== "ENOENT") throw new Error("bad path");
      const parent = path.dirname(cursor);
      if (parent === cursor) throw new Error("bad path");
      missing.push(path.basename(cursor));
      cursor = parent;
    }
  }
  const real = missing.length ? path.join(base, ...missing.reverse()) : base;
  const rel = path.relative(rootReal, real).split(path.sep).join("/");
  if (rel !== want) throw new Error("path escapes vault");
  return real;
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
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;
  try {
    await fs.writeFile(tmpPath, buf, { flag: "wx" });
    await fs.rename(tmpPath, filePath);
  } catch (e) {
    try { await fs.unlink(tmpPath); } catch {}
    throw e;
  }
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
      let status = 200;
      let payload = null;
      try {
        await enqueueVaultGit(async () => {
          const result = await joinVault();
          await noteUnrelated().catch(() => {});
          status = result.status;
          payload = syncStatus();
        });
      } catch (e) {
        setGitError(e && e.message || "push refused");
        if (!hasUnresolved()) vaultGit.join = true;
        status = 409;
        payload = syncStatus();
      }
      finishGitNotice();
      return json(res, status, payload || syncStatus());
    }

    if (pathname === "/api/week" && req.method === "GET") {
      let start = url.searchParams.get("start");
      if (!start) start = mondayOf(todayIso());
      else if (!isIsoDate(start)) {
        return json(res, 400, { error: "start must be YYYY-MM-DD" });
      }
      const raw = await readVaultRel(`aidanos/weeks/${start}.md`);
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
        return json(res, 200, { week_start: start, days, exists: false });
      }
      const days = parseWeekMarkdown(raw, start);
      for (const d of days) {
        const logRaw = await readVaultRel(`log/${d.date}.md`);
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
      return json(res, 200, { week_start: start, days, exists: true });
    }

    if (pathname === "/api/day" && req.method === "GET") {
      const date = url.searchParams.get("date");
      if (!date) return json(res, 400, { error: "date required" });
      if (!isIsoDate(date)) return json(res, 400, { error: "date must be YYYY-MM-DD" });
      const dayRel = `log/${date}.md`;
      let logPath;
      try {
        logPath = await worktreePath(dayRel);
      } catch (e) {
        return json(res, 400, { error: publicPathError(e) });
      }
      const raw = await readFileSafe(logPath);
      const markdown = raw == null ? "" : raw;
      const mtime = raw == null ? 0 : await fileMtimeMs(logPath);
      return json(res, 200, { date, markdown, mtime });
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
      const names = await readLogNames();
      if (names == null) return json(res, 200, { year, month, days: [] });
      const days = [];
      for (const name of names) {
        if (name.endsWith(".tmp")) continue;
        if (!DAY_FILE_RE.test(name)) continue;
        if (!name.startsWith(prefix)) continue;
        const date = name.slice(0, 10);
        const raw = await readVaultRel(`log/${name}`);
        if (raw == null) continue;
        if (!String(raw).trim()) continue;
        days.push(date);
      }
      days.sort((a, b) => a.localeCompare(b));
      return json(res, 200, { year, month, days });
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
        return json(res, 400, { error: publicPathError(e) });
      }
      return await enqueuePathWrite(dayRel, async () => {
        try {
          logPath = await worktreePath(dayRel);
        } catch (e) {
          return json(res, 400, { error: publicPathError(e) });
        }
        let diskMtime = 0;
        let exists = false;
        try {
          const st = await fs.lstat(logPath);
          // A leaf symlink is replaced by the write below. Do not follow it.
          if (!st.isSymbolicLink() && st.isFile()) {
            exists = true;
            diskMtime = Math.trunc(st.mtimeMs);
          }
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
      const raw = await readVaultRel("aidanos/active-horse.md");
      return json(res, 200, { plan: parsePlan(raw), exists: Boolean(raw) });
    }

    if (pathname === "/api/open-tasks" && req.method === "GET") {
      const names = await readLogNames();
      if (names == null) return json(res, 200, { items: [] });
      const items = [];
      names.sort((a, b) => a.localeCompare(b));
      for (const name of names) {
        if (name.endsWith(".tmp")) continue;
        if (!DAY_FILE_RE.test(name)) continue;
        const date = name.slice(0, 10);
        const raw = await readVaultRel(`log/${name}`);
        if (raw == null) continue;
        const lines = raw.split("\n");
        for (let i = 0; i < lines.length; i++) {
          const item = parseTaskLine(lines[i]);
          if (item && !item.done) {
            items.push({ date, line: i, text: item.text });
          }
        }
      }
      return json(res, 200, { items });
    }

    if (pathname === "/api/folders" && req.method === "GET") {
      const entries = await fs.readdir(VAULT, { withFileTypes: true });
      const folders = [];
      for (const e of entries) {
        if (!e.isDirectory() || e.name.startsWith(".")) continue;
        if (e.name === "log" || e.name === "tasks" || e.name === "aidanos") continue;
        folders.push({ name: e.name, path: e.name });
      }
      folders.sort((a, b) => a.name.localeCompare(b.name));
      return json(res, 200, { folders });
    }

    if (pathname === "/api/file" && req.method === "GET") {
      const rel = url.searchParams.get("path");
      if (!rel) return json(res, 400, { error: "path required" });
      let abs;
      try {
        abs = await worktreePath(rel);
        await readableTarget(abs, VAULT);
      } catch (e) {
        return json(res, 400, { error: publicPathError(e) });
      }
      const relPath = path.relative(VAULT, abs).split(path.sep).join("/");
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
          return json(res, 400, { error: publicPathError(e) });
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
        return json(res, 400, { error: publicPathError(e) });
      }
      const relPath = path.relative(VAULT, abs).split(path.sep).join("/");
      if (familyRoomPngPath(relPath)) {
        let real;
        try {
          real = await familyRoomPngReal(relPath, abs);
        } catch (e) {
          return json(res, 400, { error: publicPathError(e) });
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
          return json(res, 400, { error: publicPathError(e) });
        }
        let diskMtime = 0;
        let exists = false;
        try {
          const st = await fs.lstat(abs);
          // A leaf symlink is replaced by the write below. Do not follow it.
          if (st.isSymbolicLink()) {
            exists = false;
          } else if (st.isDirectory()) {
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
        return json(res, 400, { error: publicPathError(e) });
      }
      let stat;
      try {
        stat = await fs.stat(abs);
      } catch (e) {
        if (e.code === "ENOENT") {
          return json(res, 404, { error: "directory not found", dir: dirParam });
        }
        throw e;
      }
      if (!stat.isDirectory()) {
        return json(res, 400, { error: "not a directory", dir: dirParam });
      }
      const files = await listMdTree(abs, VAULT);
      return json(res, 200, { dir: dirParam, files });
    }

    if (pathname === "/api/search" && req.method === "GET") {
      const q = String(url.searchParams.get("q") || "").trim();
      if (!q) return json(res, 200, { hits: [] });
      const needle = q.toLowerCase();
      const files = await listMdTree(VAULT, VAULT);
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
        let abs;
        try {
          abs = await worktreePath(rel);
        } catch {
          continue;
        }
        let st;
        try {
          st = await fs.stat(abs);
        } catch {
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
            if (hits.length >= MAX_HITS) return json(res, 200, { hits });
            if (nThis >= MAX_PER_FILE) break;
          }
        }
      }
      return json(res, 200, { hits });
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
      const raw = await readVaultRel("aidanos/skin.css");
      res.writeHead(200, {
        "Content-Type": "text/css; charset=utf-8",
        "Cache-Control": "no-store",
      });
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
    if (err && err.code === "BODY_TOO_LARGE") {
      if (!res.headersSent) return json(res, 413, { error: "too large" });
      return;
    }
    const refusal = clientRefusal(err);
    logSafe(err);
    if (res.headersSent) return;
    if (refusal) return json(res, 400, { error: refusal });
    return json(res, 500, { error: "internal error" });
  }
});

async function boot() {
  await initVaultGit();
  startLogWatch();
  startVaultSyncLoop();
  server.listen(PORT, HOST, () => {
    console.log(`AidanOS`);
    console.log(`  vault: ${VAULT}`);
    if (vaultGit.enabled) {
      console.log(`  git:   ${vaultGit.error ? "error" : "on"}`);
    }
    console.log(`  host:  ${HOST}`);
    console.log(`  open:  http://${HOST === "0.0.0.0" ? "127.0.0.1" : HOST}:${PORT}`);
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
  // A rejected request promise must not print the vault path or exit.
  process.on("unhandledRejection", (reason) => {
    const err = reason instanceof Error ? reason : new Error(String(reason || "error"));
    logSafe("unhandled rejection", err);
  });
  boot().catch((err) => {
    logSafe(err);
    process.exit(1);
  });
}
