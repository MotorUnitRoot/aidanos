#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { authenticatedGitUrl, sanitizeGitError, seedBundledVault } from "./server.mjs";

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
  const replaced = authenticatedGitUrl("https://old:creds@github.com/MotorUnitRoot/aidanos-vault.git", token);
  assert(replaced === want, "replaces existing userinfo");

  const leaked = "fatal: could not read Username for '" + auth + "' terminal prompts disabled";
  const clean = sanitizeGitError(leaked, { token, url, vault: "/tmp/vault" });
  assert(!clean.includes(token), "token redacted from git error");
  assert(!clean.includes(url), "public url redacted");
  assert(!clean.includes("x-access-token:" + token), "auth userinfo redacted");
  assert(clean.includes("[url]") || clean.includes("***"), "sanitized placeholder");
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

try {
  authUrlShaping();
  await seedDoesNotOverwrite();
  await liveGitSync();
  await authOriginIsEmbedded();
  await bundledSeedWhenCloneFails();
  console.log("vault-git-test ok");
} catch (err) {
  console.error("FAIL  vault-git-test  " + err.message);
  process.exit(1);
}
