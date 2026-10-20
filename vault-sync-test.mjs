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

async function waitHealth(base, child) {
  const deadline = Date.now() + 12000;
  let last = "";
  while (Date.now() < deadline) {
    if (child.exitCode != null) throw new Error("server exited " + child.exitCode + " " + last);
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
      const value = await fn();
      if (value) return value;
    } catch (e) {
      last = String(e && e.message || e);
    }
    await new Promise((r) => setTimeout(r, 80));
  }
  throw new Error((label || "wait") + " timeout " + last);
}

function seedBare(tmp) {
  const bare = path.join(tmp, "remote.git");
  const seed = path.join(tmp, "seed");
  fs.mkdirSync(seed, { recursive: true });
  git(["init", "--bare", "-b", "main", bare], tmp);
  git(["init", "-b", "main"], seed);
  git(["config", "user.name", "Seed"], seed);
  git(["config", "user.email", "seed@local"], seed);
  fs.mkdirSync(path.join(seed, "log"), { recursive: true });
  fs.writeFileSync(path.join(seed, "README.md"), "vault\n", "utf8");
  fs.writeFileSync(path.join(seed, "log", "2026-10-19.md"), "seed day\n", "utf8");
  git(["add", "README.md", "log/2026-10-19.md"], seed);
  git(["commit", "-m", "seed"], seed);
  git(["remote", "add", "origin", bare], seed);
  git(["push", "-u", "origin", "HEAD"], seed);
  return bare;
}

function serverEnv(port, vault, bare, extra) {
  return {
    PORT: String(port),
    AIDANOS_HOST: "127.0.0.1",
    AIDANOS_VAULT: vault,
    AIDANOS_VAULT_GIT_URL: bare,
    AIDANOS_VAULT_GIT_DEBOUNCE_MS: "80",
    AIDANOS_VAULT_GIT_TOKEN: "",
    GITHUB_TOKEN: "",
    ...extra,
  };
}

async function putDay(base, date, markdown, mtime) {
  let baseMtime = mtime;
  if (baseMtime == null) {
    const cur = await fetch(base + "/api/day?date=" + date);
    const json = await cur.json().catch(() => ({}));
    baseMtime = Number(json.mtime) || 0;
  }
  const res = await fetch(base + "/api/day?date=" + date, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ date, markdown, paper: markdown, mtime: baseMtime }),
  });
  const body = await res.json().catch(() => ({}));
  return { res, body };
}

async function readSseUntil(res, pred, ms) {
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  const deadline = Date.now() + ms;
  try {
    while (Date.now() < deadline) {
      const left = Math.max(20, deadline - Date.now());
      const chunk = await Promise.race([
        reader.read(),
        new Promise((resolve) => setTimeout(() => resolve({ timeout: true }), left)),
      ]);
      if (chunk.timeout) break;
      if (chunk.done) break;
      buf += dec.decode(chunk.value, { stream: true });
      const parts = buf.split("\n\n");
      buf = parts.pop() || "";
      for (const part of parts) {
        const line = part.split("\n").find((item) => item.startsWith("data: "));
        if (!line) continue;
        let data;
        try { data = JSON.parse(line.slice(6)); } catch { continue; }
        if (pred(data)) return data;
      }
    }
  } finally {
    try { await reader.cancel(); } catch {}
  }
  throw new Error("sse timeout " + buf.slice(0, 240));
}

function assertClientSurfacesConflict() {
  const app = fs.readFileSync(path.join(root, "app.js"), "utf8");
  assert(app.includes('payload.type === "git"'), "day watch routes git notices");
  assert(app.includes("function surfaceGitConflict("), "page applies git notices");
  assert(app.includes("function openGitConflict("), "git notice opens the conflict sheet");
  const openStart = app.indexOf("function openGitConflict(");
  const openEnd = app.indexOf("function surfaceGitConflict(", openStart);
  const openFn = app.slice(openStart, openEnd);
  assert(openFn.includes("openPaperConflict"), "git conflict uses the existing sheet");
  assert(openFn.includes("mine"), "sheet gets the local copy");
  assert(openFn.includes("theirs"), "sheet gets the remote copy");
  assert(app.includes("info.git"), "Take theirs persists a git choice");
  const server = fs.readFileSync(path.join(root, "server.mjs"), "utf8");
  assert(server.includes('merge", "--ff-only"'), "sync fast-forwards only");
  assert(!server.includes('merge", "--rebase"') && !server.includes("pull --rebase"), "sync does not rebase");
  assert(server.includes("if (!GIT_URL || !GIT_SYNC_MS) return;"), "no remote means no sync timer");
}

async function livePull() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "aidanos-sync-live-"));
  const bare = seedBare(tmp);
  const vaultA = path.join(tmp, "a");
  const vaultB = path.join(tmp, "b");
  fs.mkdirSync(vaultA, { recursive: true });
  fs.mkdirSync(vaultB, { recursive: true });
  const portA = 26000 + Math.floor(Math.random() * 1000);
  const portB = portA + 1;
  const childA = spawnServer(serverEnv(portA, vaultA, bare, { AIDANOS_VAULT_GIT_SYNC_MS: "400" }));
  const childB = spawnServer(serverEnv(portB, vaultB, bare, { AIDANOS_VAULT_GIT_SYNC_MS: "400" }));
  const baseA = "http://127.0.0.1:" + portA;
  const baseB = "http://127.0.0.1:" + portB;
  let watch;
  try {
    await waitHealth(baseA, childA);
    await waitHealth(baseB, childB);
    watch = await fetch(baseB + "/api/day-watch");
    assert(watch.ok, "day watch " + watch.status);
    const date = "2026-10-20";
    const markdown = "from copy A\n";
    const put = await putDay(baseA, date, markdown);
    assert(put.res.ok, "A write " + put.res.status + " " + JSON.stringify(put.body));
    await waitFor(async () => {
      const log = git(["log", "--oneline"], bare);
      return log.includes("vault: log/" + date + ".md") ? log : "";
    }, 5000, "A push");
    const seen = await readSseUntil(watch, (data) => data && data.date === date, 5000);
    assert(seen.date === date, "B watch saw the pulled day");
    const body = await waitFor(async () => {
      const res = await fetch(baseB + "/api/day?date=" + date);
      const json = await res.json();
      return json.markdown === markdown ? json : "";
    }, 5000, "B day api");
    assert(body.markdown === markdown, "B serves A's edit without a restart");
    assert(
      fs.readFileSync(path.join(vaultB, "log", date + ".md"), "utf8") === markdown,
      "B vault file matches the pull",
    );
    const health = await (await fetch(baseB + "/api/health")).json();
    assert(health.git && health.git.ok === true, "B git ok after fast-forward " + JSON.stringify(health.git));
  } finally {
    try { if (watch) await watch.body.cancel(); } catch {}
    await stop(childA);
    await stop(childB);
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  }
}

async function sameFileKeepsBoth() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "aidanos-sync-both-"));
  const bare = seedBare(tmp);
  const vaultA = path.join(tmp, "a");
  const vaultB = path.join(tmp, "b");
  fs.mkdirSync(vaultA, { recursive: true });
  fs.mkdirSync(vaultB, { recursive: true });
  const portA = 28000 + Math.floor(Math.random() * 1000);
  const portB = portA + 1;
  const extra = { AIDANOS_VAULT_GIT_SYNC_MS: "0" };
  const childA = spawnServer(serverEnv(portA, vaultA, bare, extra));
  const childB = spawnServer(serverEnv(portB, vaultB, bare, extra));
  const baseA = "http://127.0.0.1:" + portA;
  const baseB = "http://127.0.0.1:" + portB;
  const date = "2026-10-19";
  let watch;
  try {
    await waitHealth(baseA, childA);
    await waitHealth(baseB, childB);
    const fromA = "from copy A\n";
    const putA = await putDay(baseA, date, fromA);
    assert(putA.res.ok, "A save " + putA.res.status);
    await waitFor(async () => {
      const shown = git(["show", "main:log/" + date + ".md"], bare);
      return shown === fromA ? shown : "";
    }, 5000, "A on remote");

    watch = await fetch(baseB + "/api/day-watch");
    const fromB = "from copy B\n";
    const putB = await putDay(baseB, date, fromB);
    assert(putB.res.ok, "B save " + putB.res.status + " " + JSON.stringify(putB.body));
    const notice = await readSseUntil(
      watch,
      (data) => data && data.type === "git" && Array.isArray(data.conflicts) && data.conflicts.length > 0,
      5000,
    );
    assert(notice.error, "refused sync is on the watch channel");
    const hit = notice.conflicts.find((item) => item && item.path === "log/" + date + ".md");
    assert(hit, "conflict names the day");
    assert(hit.mine === fromB, "local copy kept as mine");
    assert(hit.theirs === fromA, "remote copy kept as theirs");
    assert(hit.date === date, "conflict carries the day");
    assert(
      fs.readFileSync(path.join(vaultB, "log", date + ".md"), "utf8") === fromB,
      "B did not lose its edit",
    );
    assert(git(["show", "main:log/" + date + ".md"], bare) === fromA, "remote still has A's edit");
    const sync = await (await fetch(baseB + "/api/sync")).json();
    assert(sync.enabled === true, "sync endpoint on");
    assert(sync.ok === false, "sync endpoint shows the problem");
    assert(sync.error, "sync error is not empty");
    const syncHit = (sync.conflicts || []).find((item) => item.path === "log/" + date + ".md");
    assert(syncHit && syncHit.mine === fromB && syncHit.theirs === fromA, "sync endpoint offers both versions");
    const health = await (await fetch(baseB + "/api/health")).json();
    assert(health.git && health.git.ok === false, "health marks git not ok");
    assert(health.git.error, "health still carries the error");
    assert(!JSON.stringify(health).includes(vaultB), "health must not leak the vault path");
    assert(!JSON.stringify(health).includes(bare), "health must not leak the remote path");
    assert(!JSON.stringify(sync).includes(bare), "sync must not leak the remote path");

    const kept = await putDay(baseB, date, fromB, hit.mtime);
    assert(kept.res.ok, "keep mine " + kept.res.status + " " + JSON.stringify(kept.body));
    await waitFor(async () => {
      return git(["show", "main:log/" + date + ".md"], bare) === fromB ? true : "";
    }, 5000, "keep mine pushed");
    const hist = git(["log", "-p", "--", "log/" + date + ".md"], bare);
    assert(hist.includes("from copy A"), "taking keep mine still leaves A's copy in history");
    assert(fs.readFileSync(path.join(vaultB, "log", date + ".md"), "utf8") === fromB, "B still has its edit");
    const after = await (await fetch(baseB + "/api/sync")).json();
    assert(after.ok === true, "conflict clears after keep mine " + JSON.stringify(after));
    assert(!(after.conflicts || []).length, "no conflict left after keep mine");
  } finally {
    try { if (watch) await watch.body.cancel(); } catch {}
    await stop(childA);
    await stop(childB);
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  }
}

async function refusedPushIsShown() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "aidanos-sync-refuse-"));
  const bare = seedBare(tmp);
  const vaultA = path.join(tmp, "a");
  const vaultB = path.join(tmp, "b");
  fs.mkdirSync(vaultA, { recursive: true });
  fs.mkdirSync(vaultB, { recursive: true });
  const portA = 30000 + Math.floor(Math.random() * 1000);
  const portB = portA + 1;
  const extra = { AIDANOS_VAULT_GIT_SYNC_MS: "0" };
  const childA = spawnServer(serverEnv(portA, vaultA, bare, extra));
  const childB = spawnServer(serverEnv(portB, vaultB, bare, extra));
  const baseA = "http://127.0.0.1:" + portA;
  const baseB = "http://127.0.0.1:" + portB;
  const date = "2026-10-19";
  let watch;
  try {
    await waitHealth(baseA, childA);
    await waitHealth(baseB, childB);
    const baseText = "shared\n";
    const putA = await putDay(baseA, date, baseText);
    assert(putA.res.ok, "seed save " + putA.res.status);
    await waitFor(async () => {
      return git(["show", "main:log/" + date + ".md"], bare) === baseText ? true : "";
    }, 5000, "shared on remote");
    git(["fetch", "origin"], vaultB);
    git(["merge", "--ff-only", "origin/main"], vaultB);

    const fromA = "desk A\n";
    const fromB = "desk B\n";
    fs.writeFileSync(path.join(vaultA, "log", date + ".md"), fromA, "utf8");
    git(["add", "log/" + date + ".md"], vaultA);
    git(["commit", "-m", "A edit"], vaultA);
    git(["push", "origin", "HEAD"], vaultA);
    fs.writeFileSync(path.join(vaultB, "log", date + ".md"), fromB, "utf8");
    git(["add", "log/" + date + ".md"], vaultB);
    git(["commit", "-m", "B edit"], vaultB);

    watch = await fetch(baseB + "/api/day-watch");
    const other = await putDay(baseB, "2026-10-18", "other note\n");
    assert(other.res.ok, "trigger save " + other.res.status);
    const notice = await readSseUntil(
      watch,
      (data) => data && data.type === "git" && data.error && Array.isArray(data.conflicts) && data.conflicts.some((item) => item && item.mine === fromB && item.theirs === fromA),
      5000,
    );
    assert(/rejected|non-fast-forward|behind|refused/i.test(notice.error), "push refusal text reaches the page channel");
    assert(fs.readFileSync(path.join(vaultB, "log", date + ".md"), "utf8") === fromB, "refused push kept B");
    assert(git(["show", "main:log/" + date + ".md"], bare) === fromA, "refused push kept A on the remote");
    assert(fs.readFileSync(path.join(vaultB, "log", "2026-10-18.md"), "utf8") === "other note\n", "unrelated local edit kept");
    const health = await (await fetch(baseB + "/api/health")).json();
    assert(health.git && health.git.ok === false && health.git.error, "health shows the refused push");
    assert(!JSON.stringify(health).includes(bare), "refusal hint must not leak the remote");
  } finally {
    try { if (watch) await watch.body.cancel(); } catch {}
    await stop(childA);
    await stop(childB);
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  }
}

async function noRemoteUnchanged() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "aidanos-sync-local-"));
  const vault = path.join(tmp, "vault");
  fs.mkdirSync(vault, { recursive: true });
  const port = 32000 + Math.floor(Math.random() * 1000);
  const child = spawnServer({
    PORT: String(port),
    AIDANOS_HOST: "127.0.0.1",
    AIDANOS_VAULT: vault,
    AIDANOS_VAULT_GIT_URL: "",
    AIDANOS_VAULT_GIT_TOKEN: "",
    GITHUB_TOKEN: "",
    AIDANOS_VAULT_GIT_SYNC_MS: "200",
  });
  const base = "http://127.0.0.1:" + port;
  try {
    await waitHealth(base, child);
    const sync = await (await fetch(base + "/api/sync")).json();
    assert(sync.enabled === false, "sync stays off without a remote");
    assert(sync.ok === true && !(sync.conflicts || []).length, "no conflicts without a remote");
    const put = await putDay(base, "2026-10-21", "local only\n");
    assert(put.res.ok, "local write " + put.res.status);
    assert(fs.readFileSync(path.join(vault, "log", "2026-10-21.md"), "utf8") === "local only\n", "local write kept");
    assert(!fs.existsSync(path.join(vault, ".git")), "no remote does not create a git checkout");
    const health = await (await fetch(base + "/api/health")).json();
    assert(health.git && health.git.enabled === false, "health git stays disabled");
    await new Promise((r) => setTimeout(r, 300));
    assert(fs.readFileSync(path.join(vault, "log", "2026-10-21.md"), "utf8") === "local only\n", "timer did not touch the local vault");
  } finally {
    await stop(child);
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  }
}

try {
  assertClientSurfacesConflict();
  await noRemoteUnchanged();
  await livePull();
  await sameFileKeepsBoth();
  await refusedPushIsShown();
  console.log("vault-sync-test ok");
} catch (err) {
  console.error("FAIL  vault-sync-test  " + (err && err.stack || err));
  process.exit(1);
}
