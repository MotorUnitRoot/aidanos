#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

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
    env: { ...process.env, ...env },
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
    await new Promise((r) => setTimeout(r, 250));
    const later = await (await fetch(base2 + "/api/health")).json();
    assert(later.ok === true, "still healthy after failed push");
    assert(!JSON.stringify(later).includes(missingVault), "hint must not leak vault path");
  } finally {
    await stop(missing);
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  }
}

try {
  await liveGitSync();
  console.log("vault-git-test ok");
} catch (err) {
  console.error("FAIL  vault-git-test  " + err.message);
  process.exit(1);
}
