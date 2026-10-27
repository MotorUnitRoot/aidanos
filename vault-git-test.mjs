#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { authenticatedGitUrl, acquireGitTurn, GIT_LOCK_KEPT_LINE, gitLockBlocksVault, redactSecrets, releaseGitTurn, releaseRememberedGitLock, rememberUnlinkLock, sanitizeGitError, seedBundledVault, setGitLockBeforeUnlinkForTest, setGitLockHoldersForTest } from "./server.mjs";

const root = path.dirname(fileURLToPath(import.meta.url));

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

function git(args, cwd) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

async function waitHealth(base, child) {
  const deadline = Date.now() + 12000;
  let last = "";
  while (Date.now() < deadline) {
    if (child.exitCode != null) {
      throw new Error("server exited " + child.exitCode + " " + last);
    }
    try {
      const res = await fetch(base + "/api/health");
      if (res.ok) return res;
    } catch (e) {
      last = String(e.message || e);
    }
    await new Promise((r) => setTimeout(r, 80));
  }
  throw new Error("health timeout " + last);
}

function spawnServer(env) {
  const child = spawn(process.execPath, ["server.mjs"], {
    cwd: root,
    env: { ...process.env, AIDANOS_VAULT_GIT_RETRY_MS: "0", ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let log = "";
  child.stderr.on("data", (buf) => { log += String(buf); });
  child.stdout.on("data", (buf) => { log += String(buf); });
  child._log = () => log;
  return child;
}

async function stop(child) {
  try { child.kill("SIGTERM"); } catch {}
  const deadline = Date.now() + 2000;
  while (child.exitCode == null && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 40));
  }
  try { child.kill("SIGKILL"); } catch {}
}

async function waitFor(fn, ms, label) {
  const deadline = Date.now() + ms;
  let last = "";
  while (Date.now() < deadline) {
    try {
      const v = fn();
      if (v) return v;
    } catch (e) {
      last = String(e && e.message || e);
    }
    await new Promise((r) => setTimeout(r, 80));
  }
  throw new Error((label || "wait") + " timeout " + last);
}

async function liveGitSync() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "aidanos-git-"));
  const bare = path.join(tmp, "remote.git");
  const seed = path.join(tmp, "seed");
  const vault = path.join(tmp, "vault");
  fs.mkdirSync(seed, { recursive: true });
  fs.mkdirSync(vault, { recursive: true });
  git(["init", "--bare", "-b", "main", bare], tmp);
  git(["init", "-b", "main"], seed);
  git(["config", "user.name", "Seed"], seed);
  git(["config", "user.email", "seed@local"], seed);
  fs.writeFileSync(path.join(seed, "README.md"), "vault\n", "utf8");
  git(["add", "README.md"], seed);
  git(["commit", "-m", "seed"], seed);
  git(["remote", "add", "origin", bare], seed);
  git(["push", "-u", "origin", "HEAD"], seed);

  const port = 21000 + Math.floor(Math.random() * 2000);
  const child = spawnServer({
    PORT: String(port),
    AIDANOS_HOST: "127.0.0.1",
    AIDANOS_VAULT: vault,
    AIDANOS_VAULT_GIT_URL: bare,
    AIDANOS_VAULT_GIT_DEBOUNCE_MS: "80",
    AIDANOS_VAULT_GIT_TOKEN: "",
    GITHUB_TOKEN: "",
  });
  const base = "http://127.0.0.1:" + port;
  try {
    const healthRes = await waitHealth(base, child);
    const health = await healthRes.json();
    assert(health.ok === true, "health ok");
    assert(health.git && health.git.enabled === true, "git enabled");
    assert(!JSON.stringify(health).includes(vault), "health must not leak vault path");
    assert(!JSON.stringify(health).includes(bare), "health must not leak remote path");

    const date = "2026-09-06";
    const put = await fetch(base + "/api/day?date=" + date, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ date, markdown: "from cloud\n", paper: "from cloud\n" }),
    });
    assert(put.ok, "day write " + put.status);
    assert(fs.readFileSync(path.join(vault, "log", date + ".md"), "utf8") === "from cloud\n", "local write kept");

    await waitFor(() => {
      const log = git(["log", "--oneline"], bare);
      return log.includes("vault: log/" + date + ".md") ? log : "";
    }, 5000, "push day");

    const notePut = await fetch(base + "/api/file?path=" + encodeURIComponent("maps/letter.md"), {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ markdown: "a letter\n", paper: "a letter\n", mtime: 0 }),
    });
    assert(notePut.ok, "file write " + notePut.status);

    await waitFor(() => {
      const log = git(["log", "--oneline"], bare);
      return log.includes("maps/letter.md") ? log : "";
    }, 5000, "push file");

    const after = await (await fetch(base + "/api/health")).json();
    assert(after.git && after.git.ok === true, "git ok after push");
    assert(after.git.pushed === true, "git pushed hint");
  } finally {
    await stop(child);
  }

  const missingVault = path.join(tmp, "missing-vault");
  fs.mkdirSync(missingVault, { recursive: true });
  const port2 = port + 1;
  const missing = spawnServer({
    PORT: String(port2),
    AIDANOS_HOST: "127.0.0.1",
    AIDANOS_VAULT: missingVault,
    AIDANOS_VAULT_GIT_URL: path.join(tmp, "no-such-remote.git"),
    AIDANOS_VAULT_GIT_DEBOUNCE_MS: "80",
    AIDANOS_VAULT_GIT_TOKEN: "",
    GITHUB_TOKEN: "",
  });
  const base2 = "http://127.0.0.1:" + port2;
  try {
    const healthRes = await waitHealth(base2, missing);
    const health = await healthRes.json();
    assert(health.ok === true, "missing remote still healthy");
    assert(health.git && health.git.enabled === true, "git still enabled");
    const put = await fetch(base2 + "/api/day?date=2026-09-07", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ date: "2026-09-07", markdown: "kept\n", paper: "kept\n" }),
    });
    assert(put.ok, "local write after missing remote " + put.status);
    assert(
      fs.readFileSync(path.join(missingVault, "log", "2026-09-07.md"), "utf8") === "kept\n",
      "missing remote must not corrupt the write"
    );
    assert(
      fs.existsSync(path.join(missingVault, "aidanos", "active-horse.md")),
      "failed clone still seeds Plan"
    );
    assert(
      fs.existsSync(path.join(missingVault, "maps", "reply-to-a-letter.md")),
      "failed clone still seeds reply-to-a-letter map"
    );
    await new Promise((r) => setTimeout(r, 250));
    const later = await (await fetch(base2 + "/api/health")).json();
    assert(later.ok === true, "still healthy after failed push");
    assert(!JSON.stringify(later).includes(missingVault), "hint must not leak vault path");
  } finally {
    await stop(missing);
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  }
}

function authUrlShaping() {
  const token = "ghp_unit_test_token_9f3a2c1b";
  const url = "https://github.com/MotorUnitRoot/aidanos-vault.git";
  const want = "https://x-access-token:" + token + "@github.com/MotorUnitRoot/aidanos-vault.git";
  const auth = authenticatedGitUrl(url, token);
  assert(auth === want, "https token userinfo");
  assert(authenticatedGitUrl(url, "") === url, "no token keeps public url");
  assert(authenticatedGitUrl(url, "   ") === url, "whitespace token keeps public url");
  assert(authenticatedGitUrl("/tmp/local.git", token) === "/tmp/local.git", "local path unchanged");
  assert(authenticatedGitUrl("file:///tmp/local.git", token) === "file:///tmp/local.git", "file url unchanged");
  const httpUrl = "http://github.com/MotorUnitRoot/aidanos-vault.git";
  assert(authenticatedGitUrl(httpUrl, token) === httpUrl, "http remotes never get token userinfo");
  const replaced = authenticatedGitUrl("https://old:creds@github.com/MotorUnitRoot/aidanos-vault.git", token);
  assert(replaced === want, "replaces existing userinfo");

  const leaked = "fatal: could not read Username for '" + auth + "' terminal prompts disabled";
  const clean = sanitizeGitError(leaked, { token, url, vault: "/tmp/vault" });
  assert(!clean.includes(token), "token redacted from git error");
  assert(!clean.includes(url), "public url redacted");
  assert(!clean.includes("x-access-token:" + token), "auth userinfo redacted");
  assert(clean.includes("[url]") || clean.includes("***"), "sanitized placeholder");

  const other = "gho_other_env_token_not_used_7c1d";
  const prevGithub = process.env.GITHUB_TOKEN;
  const prevAidanos = process.env.AIDANOS_VAULT_GIT_TOKEN;
  process.env.GITHUB_TOKEN = other;
  process.env.AIDANOS_VAULT_GIT_TOKEN = token;
  try {
    const long = "boom " + token + " and " + other + " at " + url + " " + "x".repeat(200);
    const both = redactSecrets(long, { token, url, vault: "/tmp/vault" });
    assert(!both.includes(token), "AIDANOS token redacted");
    assert(!both.includes(other), "GITHUB_TOKEN redacted even when it differs");
    assert(both.length > 180, "log redaction is not capped at the client hint length");
    assert(sanitizeGitError(long, { token, url, vault: "/tmp/vault" }).length <= 180, "client git hint stays compact");
  } finally {
    if (prevGithub == null) delete process.env.GITHUB_TOKEN;
    else process.env.GITHUB_TOKEN = prevGithub;
    if (prevAidanos == null) delete process.env.AIDANOS_VAULT_GIT_TOKEN;
    else process.env.AIDANOS_VAULT_GIT_TOKEN = prevAidanos;
  }
}

async function authOriginIsEmbedded() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "aidanos-git-auth-"));
  const vault = path.join(tmp, "vault");
  fs.mkdirSync(vault, { recursive: true });
  const token = "ghp_shape_test_" + String(Date.now());
  const publicUrl = "https://127.0.0.1:1/MotorUnitRoot/aidanos-vault.git";
  const port = 23000 + Math.floor(Math.random() * 2000);
  const child = spawnServer({
    PORT: String(port),
    AIDANOS_HOST: "127.0.0.1",
    AIDANOS_VAULT: vault,
    AIDANOS_VAULT_GIT_URL: publicUrl,
    AIDANOS_VAULT_GIT_TOKEN: token,
    GITHUB_TOKEN: "",
    AIDANOS_VAULT_GIT_DEBOUNCE_MS: "80",
  });
  const base = "http://127.0.0.1:" + port;
  try {
    const healthRes = await waitHealth(base, child);
    const health = await healthRes.json();
    assert(health.ok === true, "health ok with token");
    assert(health.git && health.git.enabled === true, "git enabled with token");
    const origin = git(["-C", vault, "remote", "get-url", "origin"]).trim();
    assert(origin.includes("x-access-token:"), "origin uses token userinfo");
    assert(origin.includes(token), "origin embeds token");
    assert(origin.includes("127.0.0.1:1/MotorUnitRoot/aidanos-vault.git"), "origin keeps host and path");
    const hint = JSON.stringify(health);
    assert(!hint.includes(token), "health must not leak token");
    assert(!hint.includes(publicUrl), "health must not leak url");
    const log = child._log();
    assert(!log.includes(token), "logs must not leak token");
    assert(!log.includes("x-access-token:" + token), "logs must not leak auth url");
  } finally {
    await stop(child);
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  }
}

async function seedSkipsPlantedLinks() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "aidanos-seed-link-"));
  const dest = path.join(tmp, "dest");
  const outside = path.join(tmp, "outside");
  fs.mkdirSync(dest);
  fs.mkdirSync(outside);
  fs.symlinkSync(outside, path.join(dest, "maps"));
  fs.mkdirSync(path.join(dest, "aidanos"));
  const broken = path.join(outside, "not-created.md");
  fs.symlinkSync(broken, path.join(dest, "aidanos", "active-horse.md"));
  try {
    const seeded = await seedBundledVault(dest, path.join(root, "vault"));
    assert(seeded === true, "seed still copies around a planted link");
    assert(fs.readdirSync(outside).length === 0, "seed wrote through a destination link");
    assert(!fs.existsSync(broken), "broken link created a file outside the vault");
    assert(fs.lstatSync(path.join(dest, "maps")).isSymbolicLink(), "folder link was replaced");
    assert(
      fs.lstatSync(path.join(dest, "aidanos", "active-horse.md")).isSymbolicLink(),
      "file link was replaced",
    );
    assert(
      fs.readFileSync(path.join(dest, "README.md"), "utf8").includes("this folder is the disk"),
      "seed skipped a normal file",
    );
    assert(
      fs.existsSync(path.join(dest, "family-room-to-office", "map.md")),
      "seed skipped a normal folder",
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

function seedDoesNotOverwrite() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "aidanos-seed-"));
  const dest = path.join(tmp, "dest");
  fs.mkdirSync(path.join(dest, "aidanos"), { recursive: true });
  fs.writeFileSync(path.join(dest, "aidanos", "active-horse.md"), "KEEP MINE\n", "utf8");
  return seedBundledVault(dest, path.join(root, "vault")).then((seeded) => {
    assert(seeded === true, "seed copies missing map when plan exists");
    assert(
      fs.readFileSync(path.join(dest, "aidanos", "active-horse.md"), "utf8") === "KEEP MINE\n",
      "seed must not overwrite existing Plan"
    );
    assert(
      fs.existsSync(path.join(dest, "maps", "reply-to-a-letter.md")),
      "seed fills the missing letter map"
    );
    fs.rmSync(tmp, { recursive: true, force: true });
  });
}

async function bundledSeedWhenCloneFails() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "aidanos-seed-live-"));
  const vault = path.join(tmp, "vault");
  fs.mkdirSync(vault, { recursive: true });
  const port = 24000 + Math.floor(Math.random() * 2000);
  const child = spawnServer({
    PORT: String(port),
    AIDANOS_HOST: "127.0.0.1",
    AIDANOS_VAULT: vault,
    AIDANOS_VAULT_GIT_URL: "https://127.0.0.1:1/MotorUnitRoot/aidanos-vault.git",
    AIDANOS_VAULT_GIT_TOKEN: "",
    GITHUB_TOKEN: "",
    AIDANOS_VAULT_GIT_DEBOUNCE_MS: "80",
  });
  const base = "http://127.0.0.1:" + port;
  try {
    const healthRes = await waitHealth(base, child);
    const health = await healthRes.json();
    assert(health.ok === true, "health ok after 403 clone");
    assert(health.git && health.git.enabled === true, "git still enabled without PAT");
    assert(health.git.ok === false, "git error is visible");
    const planRes = await fetch(base + "/api/plan");
    assert(planRes.ok, "plan endpoint " + planRes.status);
    const plan = await planRes.json();
    assert(plan.exists === true, "Plan exists without PAT");
    assert(/plan/i.test(String(plan.plan && plan.plan.title || "")), "Plan has a title");
    const mapRes = await fetch(base + "/api/file?path=" + encodeURIComponent("maps/reply-to-a-letter.md"));
    assert(mapRes.ok, "letter map " + mapRes.status);
    const map = await mapRes.json();
    assert(/Reply to a letter/.test(String(map.markdown || "")), "letter map body");
    const searchRes = await fetch(base + "/api/search?q=" + encodeURIComponent("letter"));
    assert(searchRes.ok, "search " + searchRes.status);
    const search = await searchRes.json();
    const paths = (search.hits || []).map((h) => String(h.path || ""));
    assert(paths.some((p) => p.includes("maps/reply-to-a-letter.md")), "Ask finds the letter map");
    const put = await fetch(base + "/api/day?date=2026-09-08", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ date: "2026-09-08", markdown: "demo write\n", paper: "demo write\n" }),
    });
    assert(put.ok, "local write after seed " + put.status);
    assert(
      fs.readFileSync(path.join(vault, "log", "2026-09-08.md"), "utf8") === "demo write\n",
      "seeded vault still accepts writes"
    );
    const hint = JSON.stringify(health);
    assert(!hint.includes(vault), "health must not leak vault path");
  } finally {
    await stop(child);
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  }
}

async function seededNotesStayUntracked() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "aidanos-seed-untracked-"));
  const vault = path.join(tmp, "vault");
  fs.mkdirSync(vault, { recursive: true });
  const port = 25000 + Math.floor(Math.random() * 2000);
  const child = spawnServer({
    PORT: String(port),
    AIDANOS_HOST: "127.0.0.1",
    AIDANOS_VAULT: vault,
    AIDANOS_VAULT_GIT_URL: "https://127.0.0.1:1/MotorUnitRoot/aidanos-vault.git",
    AIDANOS_VAULT_GIT_TOKEN: "",
    GITHUB_TOKEN: "",
    AIDANOS_VAULT_GIT_DEBOUNCE_MS: "80",
    AIDANOS_VAULT_GIT_SYNC_MS: "0",
    AIDANOS_VAULT_GIT_RETRY_MS: "0",
  });
  const base = "http://127.0.0.1:" + port;
  try {
    await waitHealth(base, child);
    await new Promise((r) => setTimeout(r, 400));
    assert(
      fs.existsSync(path.join(vault, "aidanos", "active-horse.md")),
      "offline start still seeds Plan"
    );
    assert(
      fs.existsSync(path.join(vault, "maps", "reply-to-a-letter.md")),
      "offline start still seeds the letter map"
    );
    const before = git(["ls-files"], vault);
    assert(!before.includes("active-horse.md"), "seeded Plan is not committed at startup");
    assert(!before.includes("reply-to-a-letter.md"), "seeded letter map is not committed at startup");
    assert(!historyNames(vault).includes("active-horse.md"), "seeded Plan is not in history at startup");
    const put = await fetch(base + "/api/day?date=2026-09-08", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ date: "2026-09-08", markdown: "demo write\n", paper: "demo write\n" }),
    });
    assert(put.ok, "saving one day " + put.status);
    await waitFor(() => historyNames(vault).includes("log/2026-09-08.md"), 5000, "the saved day is committed");
    const afterDay = git(["ls-files"], vault);
    assert(afterDay.includes("log/2026-09-08.md"), "the saved day is tracked");
    assert(!afterDay.includes("active-horse.md"), "saving a day does not commit seeded Plan");
    assert(!afterDay.includes("reply-to-a-letter.md"), "saving a day does not commit the seeded map");
    const mapRes = await fetch(base + "/api/file?path=" + encodeURIComponent("maps/reply-to-a-letter.md"));
    const map = await mapRes.json();
    const mapPut = await fetch(base + "/api/file?path=" + encodeURIComponent("maps/reply-to-a-letter.md"), {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ markdown: map.markdown, paper: map.markdown, mtime: map.mtime }),
    });
    assert(mapPut.ok, "saving the seeded map through the app " + mapPut.status);
    await waitFor(() => historyNames(vault).includes("maps/reply-to-a-letter.md"), 5000, "a saved map is committed");
    const afterMap = git(["ls-files"], vault);
    assert(afterMap.includes("maps/reply-to-a-letter.md"), "the map the user saved is tracked");
    assert(!afterMap.includes("active-horse.md"), "the unsaved seeded Plan stays untracked");
    assert(!historyNames(vault).includes("active-horse.md"), "the unsaved seeded Plan stays out of history");
  } finally {
    await stop(child);
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  }
}

function historyNames(cwd) {
  try {
    return git(["log", "--all", "--name-only", "--pretty=format:"], cwd);
  } catch {
    return "";
  }
}

function gitLockMessage(file) {
  return "fatal: unable to unlink '" + file + "': Permission denied";
}

function lockTmp() {
  return fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "aidanos-lock-"));
}

// A same-uid process with an unreadable descriptor directory keeps a
// recorded lock. The no-holder case re-enters as root in a private /proc,
// where every same-uid process can be inspected and none holds the lock.
function runLockCase(name) {
  return new Promise((resolve, reject) => {
    const child = spawn("sudo", [
      "-n",
      "--preserve-env=PATH",
      "env",
      "AIDANOS_LOCK_CASE=" + name,
      "NODE_ENV=" + (process.env.NODE_ENV || ""),
      "unshare",
      "--pid",
      "--mount",
      "--fork",
      "--mount-proc",
      process.execPath,
      fileURLToPath(import.meta.url),
    ], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let err = "";
    child.stderr.on("data", (chunk) => { err += chunk; });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(name + " failed " + code + " " + err.slice(-500)));
    });
  });
}

async function captureErrors(fn) {
  const lines = [];
  const prev = console.error;
  console.error = (...args) => { lines.push(args.map(String).join(" ")); };
  try {
    await fn();
    return lines;
  } finally {
    console.error = prev;
    setGitLockHoldersForTest(null);
    setGitLockBeforeUnlinkForTest(null);
  }
}

async function gitLockIgnoresASymlinkedGit() {
  const tmp = lockTmp();
  try {
    const real = path.join(tmp, "real");
    const vault = path.join(real, "vault");
    fs.mkdirSync(real, { recursive: true });
    git(["init", "-q", "-b", "main", vault]);
    const jump = path.join(tmp, "jump");
    fs.symlinkSync(real, jump);
    const via = path.join(jump, "vault");
    const lock = path.join(vault, ".git", "index.lock");
    fs.writeFileSync(lock, "held\n");
    rememberUnlinkLock(gitLockMessage(path.join(via, ".git", "index.lock")), via);
    await releaseRememberedGitLock(via);
    assert(fs.existsSync(lock), "a symlinked git path deleted index.lock");
    assert(fs.readFileSync(lock, "utf8") === "held\n", "a symlinked git path changed the lock");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

async function gitLockKeepsALiveGitProcess() {
  const tmp = lockTmp();
  const vault = path.join(tmp, "vault");
  fs.mkdirSync(vault);
  git(["init", "-q", "-b", "main", vault]);
  const child = spawn("git", ["-C", vault, "update-index", "--index-info"], { stdio: ["pipe", "pipe", "pipe"] });
  const lock = path.join(vault, ".git", "index.lock");
  const deadline = Date.now() + 2000;
  while (!fs.existsSync(lock) && child.exitCode == null && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 20));
  }
  try {
    assert(fs.existsSync(lock), "git did not hold index.lock");
    rememberUnlinkLock(gitLockMessage(lock), vault);
    await releaseRememberedGitLock(vault);
    assert(fs.existsSync(lock), "a live git process's lock was removed");
    assert(gitLockBlocksVault(vault), "a held lock did not block sync");
  } finally {
    try { child.stdin.end(); } catch { /* already closed */ }
    await new Promise((resolve) => child.on("close", resolve));
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

async function gitLockIgnoresPathsOutsideGit() {
  const tmp = lockTmp();
  try {
    const vault = path.join(tmp, "vault");
    fs.mkdirSync(vault);
    git(["init", "-q", "-b", "main", vault]);
    const outside = path.join(tmp, "index.lock");
    const named = path.join(vault, "index.lock");
    const configLock = path.join(vault, ".git", "config.lock");
    fs.writeFileSync(outside, "out\n");
    fs.writeFileSync(named, "note\n");
    fs.writeFileSync(configLock, "cfg\n");
    const young = path.join(vault, ".git", "index.lock");
    fs.writeFileSync(young, "young\n");
    rememberUnlinkLock(
      [gitLockMessage(outside), gitLockMessage(named), gitLockMessage(configLock)].join("\n"),
      vault,
    );
    const kept = await captureErrors(() => releaseRememberedGitLock(vault));
    assert(fs.readFileSync(outside, "utf8") === "out\n", "a lock outside the vault was removed");
    assert(fs.readFileSync(named, "utf8") === "note\n", "a lock outside .git was removed");
    assert(fs.readFileSync(configLock, "utf8") === "cfg\n", "a lock other than index.lock was removed");
    assert(fs.readFileSync(young, "utf8") === "young\n", "an unrecorded index.lock was removed");
    assert(kept.includes(GIT_LOCK_KEPT_LINE), "an unproven index.lock was removed without a message");
    assert(!kept.some((line) => line.includes(tmp) || line.includes("index.lock")), "the kept message named a path");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

async function gitLockRemovesOnlyARecordedLock() {
  if (process.platform === "linux" && process.env.AIDANOS_LOCK_CASE !== "recorded-free") {
    await runLockCase("recorded-free");
    return;
  }
  const tmp = lockTmp();
  try {
    const vault = path.join(tmp, "vault");
    fs.mkdirSync(vault);
    git(["init", "-q", "-b", "main", vault]);
    const lock = path.join(vault, ".git", "index.lock");
    fs.writeFileSync(lock, "first\n");
    rememberUnlinkLock(gitLockMessage(lock), vault);
    const aside = path.join(vault, ".git", "index.lock.aside");
    fs.renameSync(lock, aside);
    fs.writeFileSync(lock, "second\n");
    const kept = await captureErrors(() => releaseRememberedGitLock(vault));
    assert(fs.readFileSync(lock, "utf8") === "second\n", "a replaced lock inode was removed");
    assert(fs.readFileSync(aside, "utf8") === "first\n", "the recorded inode was unlinked");
    assert(kept.includes(GIT_LOCK_KEPT_LINE), "an unproven index.lock was removed without a message");
    fs.unlinkSync(aside);
    fs.unlinkSync(lock);
    fs.writeFileSync(lock, "recorded\n");
    rememberUnlinkLock(gitLockMessage(lock), vault);
    // Real /proc scan. The test hook is not set.
    await releaseRememberedGitLock(vault);
    assert(!fs.existsSync(lock), "the recorded index.lock was kept");
    assert(!gitLockBlocksVault(vault), "a removed lock still blocks sync");
    fs.writeFileSync(lock, "old\n");
    const old = (Date.now() - 15 * 60 * 1000 - 5000) / 1000;
    fs.utimesSync(lock, old, old);
    const staleKept = await captureErrors(() => releaseRememberedGitLock(vault));
    assert(fs.readFileSync(lock, "utf8") === "old\n", "an unrecorded stale index.lock was removed");
    assert(staleKept.includes(GIT_LOCK_KEPT_LINE), "an unrecorded stale index.lock was removed without a message");
    assert(gitLockBlocksVault(vault), "a kept lock did not block sync");
    assert(!staleKept.some((line) => line.includes(tmp) || line.includes("index.lock")), "the kept message named a path");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

async function gitLockKeepsSameUidScanError() {
  if (process.platform !== "linux") return;
  const tmp = lockTmp();
  const sleeper = spawn("python3", ["-c", [
    "import ctypes, os, time",
    "pid = os.fork()",
    "if pid > 0:",
    "    os.waitpid(pid, 0)",
    "    raise SystemExit(0)",
    "os.setsid()",
    "pid2 = os.fork()",
    "if pid2 > 0:",
    "    raise SystemExit(0)",
    "ctypes.CDLL(None).prctl(4, 0)",
    "print(os.getpid(), flush=True)",
    "time.sleep(60)",
  ].join("\n")], { stdio: ["ignore", "pipe", "pipe"] });
  let deniedPid = 0;
  try {
    const line = await new Promise((resolve, reject) => {
      let buf = "";
      const timer = setTimeout(() => reject(new Error("the same-uid sleeper did not start")), 4000);
      sleeper.stdout.on("data", (chunk) => {
        buf += chunk;
        if (buf.includes("\n")) {
          clearTimeout(timer);
          resolve(buf.trim().split(/\s+/).pop());
        }
      });
    });
    deniedPid = Number(line);
    const proc = "/proc/" + deniedPid;
    assert(fs.statSync(proc).uid === process.getuid(), "the unreadable process is not our uid");
    let denied = false;
    try {
      fs.readdirSync(proc + "/fd");
    } catch (error) {
      denied = error && (error.code === "EACCES" || error.code === "EPERM");
    }
    assert(denied, "a same-uid descriptor directory was readable");
    const vault = path.join(tmp, "vault");
    fs.mkdirSync(vault);
    git(["init", "-q", "-b", "main", vault]);
    const lock = path.join(vault, ".git", "index.lock");
    fs.writeFileSync(lock, "recorded\n");
    rememberUnlinkLock(gitLockMessage(lock), vault);
    const kept = await captureErrors(() => releaseRememberedGitLock(vault));
    assert(fs.readFileSync(lock, "utf8") === "recorded\n", "a same-uid scan error removed the lock");
    assert(kept.includes(GIT_LOCK_KEPT_LINE), "a same-uid scan error was removed without a message");
    assert(gitLockBlocksVault(vault), "a scan error did not block sync");
  } finally {
    if (deniedPid) {
      try { process.kill(deniedPid, "SIGKILL"); } catch { /* namespace exit reaps it */ }
    }
    try { sleeper.kill("SIGKILL"); } catch { /* already exited */ }
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

async function gitLockKeepsAReusedInode() {
  const tmp = lockTmp();
  try {
    const vault = path.join(tmp, "vault");
    fs.mkdirSync(vault);
    git(["init", "-q", "-b", "main", vault]);
    const lock = path.join(vault, ".git", "index.lock");
    fs.writeFileSync(lock, "first\n");
    rememberUnlinkLock(gitLockMessage(lock), vault);
    fs.unlinkSync(lock);
    fs.writeFileSync(lock, "fresh-lock\n");
    const kept = await captureErrors(() => releaseRememberedGitLock(vault));
    assert(fs.readFileSync(lock, "utf8") === "fresh-lock\n", "a reused inode was removed");
    assert(kept.includes(GIT_LOCK_KEPT_LINE), "a reused inode was removed without a message");
    assert(!kept.some((line) => line.includes(tmp) || line.includes("index.lock")), "the kept message named a path");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

async function gitLockKeepsALockSwappedBeforeUnlink() {
  if (process.platform === "linux" && process.env.AIDANOS_LOCK_CASE !== "swapped") {
    await runLockCase("swapped");
    return;
  }
  const tmp = lockTmp();
  const prev = process.env.NODE_ENV;
  process.env.NODE_ENV = "test";
  try {
    const vault = path.join(tmp, "vault");
    fs.mkdirSync(vault);
    git(["init", "-q", "-b", "main", vault]);
    const lock = path.join(vault, ".git", "index.lock");
    fs.writeFileSync(lock, "recorded\n");
    rememberUnlinkLock(gitLockMessage(lock), vault);
    setGitLockBeforeUnlinkForTest(() => {
      fs.unlinkSync(lock);
      fs.writeFileSync(lock, "swapped\n");
    });
    const kept = await captureErrors(() => releaseRememberedGitLock(vault));
    assert(fs.readFileSync(lock, "utf8") === "swapped\n", "a lock swapped before unlink was removed");
    assert(kept.includes(GIT_LOCK_KEPT_LINE), "a swapped lock was removed without a message");
    assert(!kept.some((line) => line.includes(tmp) || line.includes("index.lock")), "the kept message named a path");
  } finally {
    setGitLockBeforeUnlinkForTest(null);
    if (prev == null) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = prev;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

async function gitTurnStaysOffOutsideTests() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "aidanos-turn-"));
  const turn = path.join(tmp, "turn");
  const prevEnv = process.env.NODE_ENV;
  const prevTurn = process.env.AIDANOS_TEST_GIT_TURN;
  try {
    process.env.NODE_ENV = "production";
    process.env.AIDANOS_TEST_GIT_TURN = turn;
    const held = await acquireGitTurn();
    assert(held === "", "the git turn was held outside tests");
    assert(!fs.existsSync(turn), "the git turn file was created outside tests");
    process.env.NODE_ENV = "test";
    const on = await acquireGitTurn();
    assert(on === turn, "the git turn was not held in tests");
    assert(fs.existsSync(turn), "the git turn file is missing");
    releaseGitTurn(on);
    assert(!fs.existsSync(turn), "the git turn file was left behind");
  } finally {
    if (prevEnv == null) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = prevEnv;
    if (prevTurn == null) delete process.env.AIDANOS_TEST_GIT_TURN;
    else process.env.AIDANOS_TEST_GIT_TURN = prevTurn;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

try {
  const only = process.env.AIDANOS_LOCK_CASE || "";
  if (only === "recorded-free") {
    await gitLockRemovesOnlyARecordedLock();
  } else if (only === "swapped") {
    await gitLockKeepsALockSwappedBeforeUnlink();
  } else {
  await gitLockIgnoresASymlinkedGit();
  await gitLockKeepsALiveGitProcess();
  await gitLockIgnoresPathsOutsideGit();
  await gitLockRemovesOnlyARecordedLock();
  await gitLockKeepsSameUidScanError();
  await gitLockKeepsAReusedInode();
  await gitLockKeepsALockSwappedBeforeUnlink();
  await gitTurnStaysOffOutsideTests();
  authUrlShaping();
  await seedDoesNotOverwrite();
  await seedSkipsPlantedLinks();
  await liveGitSync();
  await authOriginIsEmbedded();
  await bundledSeedWhenCloneFails();
  await seededNotesStayUntracked();
  console.log("vault-git-test ok");
  }
} catch (err) {
  console.error("FAIL  vault-git-test  " + err.message);
  process.exit(1);
}
