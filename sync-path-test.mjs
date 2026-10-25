#!/usr/bin/env node
// A folder symlink under the vault is followed by read, write, and unlink.
// The last path part is a separate case (open security draft). This checks
// the parent link: it must not leave the vault or land in .git.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { worktreePath } from "./server.mjs";

const root = path.dirname(fileURLToPath(import.meta.url));
const serverSrc = fs.readFileSync(path.join(root, "server.mjs"), "utf8");

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

function sliceFn(start, end) {
  const i = serverSrc.indexOf(start);
  const j = serverSrc.indexOf(end, i + start.length);
  assert(i !== -1 && j !== -1, "missing " + start);
  return serverSrc.slice(i, j);
}

async function rejects(fn) {
  try {
    await fn();
  } catch {
    return;
  }
  throw new Error("expected a refusal");
}

function checkWiring() {
  const read = sliceFn("async function readRel(", "async function writeVaultText(");
  const write = sliceFn("async function writeVaultText(", "async function gitShow(");
  const detach = sliceFn("async function detachFile(", "async function fastForward(");
  const announce = sliceFn("async function announcePaths(", "async function recordConflicts(");
  const stage = sliceFn("async function stageAndCommit(", "async function commitAppPaths(");
  assert(read.includes("worktreePath"), "read checks the parent path");
  assert(write.includes("worktreePath"), "write checks the parent path");
  assert(detach.includes("worktreePath") && detach.indexOf("worktreePath") < detach.indexOf("unlink"), "unlink checks the parent path first");
  assert(announce.includes("worktreePath"), "watch stat checks the parent path");
  assert(stage.includes("worktreePath") && stage.indexOf("worktreePath") < stage.indexOf("pathExists"), "stage checks the parent path first");
}

async function pathChecks() {
  const vault = fs.mkdtempSync(path.join(os.tmpdir(), "aidanos-wt-"));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "aidanos-wt-out-"));
  try {
    fs.mkdirSync(path.join(vault, "maps"));
    const plain = await worktreePath("maps/note.md", vault);
    assert(plain === path.join(vault, "maps", "note.md"), "ordinary note path");
    const missing = await worktreePath("newbox/note.md", vault);
    assert(missing === path.join(vault, "newbox", "note.md"), "missing folder is not a link");

    fs.mkdirSync(path.join(vault, "real"));
    fs.symlinkSync(path.join(vault, "real"), path.join(vault, "alias"));
    const inside = await worktreePath("alias/note.md", vault);
    assert(inside === path.join(vault, "alias", "note.md"), "link that stays inside the vault");

    fs.writeFileSync(path.join(outside, "note.md"), "sentinel\n", "utf8");
    fs.symlinkSync(outside, path.join(vault, "maps-out"));
    await rejects(() => worktreePath("maps-out/note.md", vault));
    await rejects(() => worktreePath("maps-out/brand-new.md", vault));
    assert(fs.readFileSync(path.join(outside, "note.md"), "utf8") === "sentinel\n", "check does not touch the outside file");

    fs.mkdirSync(path.join(vault, ".git"));
    fs.writeFileSync(path.join(vault, ".git", "config"), "not-a-token\n", "utf8");
    fs.symlinkSync(path.join(vault, ".git"), path.join(vault, "gitlink"));
    await rejects(() => worktreePath("gitlink/config", vault));

    fs.symlinkSync(path.join(vault, "gitlink"), path.join(vault, "loop"));
    await rejects(() => worktreePath("loop/config", vault));
  } finally {
    fs.rmSync(vault, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
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
    if (child.exitCode != null) throw new Error("server exited " + child.exitCode);
    try {
      const res = await fetch(base + "/api/health");
      if (res.ok) return;
    } catch (e) {
      last = String(e && e.message || e);
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
  while (Date.now() < deadline) {
    if (fn()) return;
    await new Promise((r) => setTimeout(r, 80));
  }
  throw new Error(label || "wait timeout");
}

async function liveSyncDoesNotFollowOutside() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "aidanos-sync-link-"));
  const outside = path.join(tmp, "outside");
  const sentinel = "OUTSIDE_NOTE_SENTINEL";
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, "note.md"), sentinel + "\n", "utf8");
  const bare = path.join(tmp, "remote.git");
  const seed = path.join(tmp, "seed");
  git(["init", "--bare", "-b", "main", bare], tmp);
  fs.mkdirSync(seed);
  git(["init", "-b", "main"], seed);
  git(["config", "user.name", "Seed"], seed);
  git(["config", "user.email", "seed@local"], seed);
  fs.mkdirSync(path.join(seed, "maps"));
  fs.writeFileSync(path.join(seed, "maps", "note.md"), "original\n", "utf8");
  git(["add", "maps/note.md"], seed);
  git(["commit", "-m", "seed"], seed);
  git(["remote", "add", "origin", bare], seed);
  git(["push", "-u", "origin", "HEAD"], seed);

  const vault = path.join(tmp, "vault");
  fs.mkdirSync(vault);
  const port = 28000 + Math.floor(Math.random() * 2000);
  const child = spawnServer({
    PORT: String(port),
    AIDANOS_HOST: "127.0.0.1",
    AIDANOS_VAULT: vault,
    AIDANOS_VAULT_GIT_URL: bare,
    AIDANOS_VAULT_GIT_TOKEN: "",
    GITHUB_TOKEN: "",
    AIDANOS_VAULT_GIT_DEBOUNCE_MS: "60000",
    AIDANOS_VAULT_GIT_SYNC_MS: "0",
  });
  const base = "http://127.0.0.1:" + port;
  try {
    await waitHealth(base, child);
    await waitFor(() => fs.existsSync(path.join(vault, "maps", "note.md")), 8000, "clone");
    fs.rmSync(path.join(vault, "maps"), { recursive: true, force: true });
    fs.symlinkSync(outside, path.join(vault, "maps"));

    const other = path.join(tmp, "other");
    git(["clone", bare, other], tmp);
    git(["config", "user.name", "Other"], other);
    git(["config", "user.email", "other@local"], other);
    fs.writeFileSync(path.join(other, "maps", "note.md"), "remote edit\n", "utf8");
    git(["add", "maps/note.md"], other);
    git(["commit", "-m", "remote"], other);
    git(["push", "origin", "HEAD"], other);

    const res = await fetch(base + "/api/sync", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ join: true }),
      signal: AbortSignal.timeout(10000),
    });
    const body = await res.json().catch(() => ({}));
    const raw = JSON.stringify(body);
    assert(!raw.includes(sentinel), "sync response included the outside note");
    assert(!raw.includes(outside), "sync response included the outside path");
    assert(!child._log().includes(sentinel), "server log included the outside note");
    assert(fs.lstatSync(path.join(vault, "maps")).isSymbolicLink(), "folder link was replaced");
    assert(fs.readFileSync(path.join(outside, "note.md"), "utf8") === sentinel + "\n", "outside note was changed or removed");
  } finally {
    await stop(child);
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

checkWiring();
await pathChecks();
await liveSyncDoesNotFollowOutside();
console.log("sync-path-test ok");
