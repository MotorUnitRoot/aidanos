#!/usr/bin/env node
// A folder symlink under the vault is followed by read, write, and unlink.
// Refuse a parent or a leaf that leaves the vault or lands in .git.
// A link that stays on a normal file or folder inside the vault still works.
// Writes replace a leaf link; they do not follow it.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { gitEnv, readWorktree, vaultRel, worktreePath } from "./server.mjs";

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
  const envFn = sliceFn("function gitEnv(", "function runGit(");
  const run = sliceFn("function runGit(", "async function ensureGitIdentity(");
  const read = sliceFn("export async function readWorktree(", "async function readRel(");
  const rel = sliceFn("async function readRel(", "async function writeVaultText(");
  const write = sliceFn("async function writeVaultText(", "async function gitShow(");
  const detach = sliceFn("async function detachFile(", "async function fastForward(");
  const announce = sliceFn("async function announcePaths(", "async function recordConflicts(");
  const conflicts = sliceFn("async function recordConflicts(", "function explicitResolve(");
  const choices = sliceFn("async function noteChoices(", "async function dropStaleChoices(");
  const drop = sliceFn("async function dropStaleChoices(", "async function noteDivergence(");
  const stage = sliceFn("async function stageAndCommit(", "async function commitAppPaths(");
  const atomic = sliceFn("async function atomicWriteFile(", "function atomicWriteDay(");
  const reader = sliceFn("async function readFileSafe(", "function parseFrontmatter(");
  assert(envFn.includes('GIT_LITERAL_PATHSPECS = "1"') || envFn.includes('GIT_LITERAL_PATHSPECS: "1"'), "git pathspecs are literal");
  assert(envFn.includes('startsWith("GIT_")'), "git children drop every inherited GIT_ variable");
  assert(envFn.indexOf('startsWith("GIT_")') < envFn.indexOf("GIT_EDITOR"), "editor settings are set after the scrub");
  assert(!envFn.includes("Leave other GIT_"), "the scrub comment no longer says a full wipe is impossible");
  assert(envFn.includes('GIT_EDITOR = "true"') && envFn.includes('GIT_MERGE_AUTOEDIT = "no"'), "editor settings stay on git children");
  assert(envFn.includes('GIT_TERMINAL_PROMPT = "0"'), "git prompts stay off");
  assert(run.includes("gitEnv()"), "git commands use that environment");
  assert(read.includes("worktreePath") && read.includes("readableTarget") && read.includes("readRegularText"), "read checks parents and the leaf");
  assert(reader.includes("readRegularText"), "note reads open the checked file");
  assert(rel.includes("readWorktree"), "sync read uses the leaf check");
  assert(write.indexOf("worktreePath") !== write.lastIndexOf("worktreePath"), "write rechecks the folder");
  assert(atomic.includes("beforeRename") && atomic.indexOf("beforeRename") < atomic.indexOf("fs.rename"), "recheck sits before rename");
  assert(detach.includes("vaultRel") && detach.indexOf("worktreePath") < detach.indexOf("unlink"), "unlink checks the path and git gets the checked name");
  assert(!detach.includes('"--", rel'), "detach does not pass the raw name");
  assert(announce.includes("worktreePath"), "watch stat checks the parent path");
  assert(conflicts.includes("worktreePath") && !conflicts.includes("safeJoin(VAULT"), "conflict mtime uses the checked path");
  assert(choices.includes("worktreePath") && !choices.includes("safeJoin(VAULT"), "choice mtime uses the checked path");
  assert(drop.includes("worktreePath") && !drop.includes("safeJoin(VAULT"), "stale choice mtime uses the checked path");
  assert(stage.includes("vaultRel") && stage.indexOf("worktreePath") < stage.indexOf("pathExists"), "stage checks the path first");
  assert(!stage.includes('"--", rel'), "stage does not pass the raw name");
  assert(reader.includes("readableTarget"), "note reads use the leaf check");
  assert(write.includes(".dev") && write.includes(".ino"), "write compares the folder inode after rename");
  assert(serverSrc.includes('process.platform === "darwin" || process.platform === "win32"'), "lowercase .git name is only a second check on darwin and win32");
  assert(serverSrc.includes('"--git-dir"'), "a .git pointer file resolves the real git dir");
  const dayGet = sliceFn('pathname === "/api/day" && req.method === "GET"', 'pathname === "/api/month"');
  const dayPut = sliceFn('pathname === "/api/day" && req.method === "PUT"', 'pathname === "/api/plan"');
  const fileGet = sliceFn('pathname === "/api/file" && req.method === "GET"', 'pathname === "/api/file" && req.method === "PUT"');
  const filePut = sliceFn('pathname === "/api/file" && req.method === "PUT"', 'pathname === "/api/tree"');
  const tree = sliceFn('pathname === "/api/tree"', 'pathname === "/api/search"');
  const search = sliceFn('pathname === "/api/search"', 'pathname === "/api/day-watch"');
  const dirFn = sliceFn("async function worktreeDir(", "async function readVaultRel(");
  const vaultRead = sliceFn("async function readVaultRel(", "async function readLogNames(");
  const week = sliceFn('pathname === "/api/week"', 'pathname === "/api/day" && req.method === "GET"');
  const month = sliceFn('pathname === "/api/month"', 'pathname === "/api/day" && req.method === "PUT"');
  const tasks = sliceFn('pathname === "/api/open-tasks"', 'pathname === "/api/folders"');
  const plan = sliceFn('pathname === "/api/plan"', 'pathname === "/api/open-tasks"');
  const skin = sliceFn('pathname === "/api/skin.css"', "let file = pathname");
  const watch = sliceFn("function startLogWatch(", "function sendFile(");
  assert(dayGet.includes("worktreePath"), "day read uses worktreePath");
  assert(dayPut.includes("worktreePath") && !dayPut.includes('path.join(VAULT, "log"'), "day write uses worktreePath");
  assert(fileGet.includes("worktreePath") && !fileGet.includes("resolveInside"), "file read uses worktreePath");
  assert(filePut.includes("worktreePath") && !filePut.includes("resolveInside"), "file write uses worktreePath");
  assert(tree.includes("worktreeDir") && dirFn.includes("worktreePath"), "tree checks the folder through worktreePath");
  assert(search.includes("worktreePath"), "search reads through worktreePath");
  assert(vaultRead.includes("worktreePath"), "vault reads use worktreePath");
  assert(week.includes("readVaultRel") && !week.includes("path.join"), "week reads use the checked path");
  assert(month.includes("readLogNames") && month.includes("readVaultRel"), "month reads use the checked path");
  assert(tasks.includes("readLogNames") && tasks.includes("readVaultRel"), "open tasks use the checked path");
  assert(plan.includes("readVaultRel"), "plan reads use the checked path");
  assert(skin.includes("readVaultRel"), "skin reads use the checked path");
  assert(watch.includes("worktreeDir") && watch.includes("lstat"), "log watch skips a linked folder");
  assert(serverSrc.includes("worktreePath(rel, root = VAULT)"), "worktreePath keeps a two-argument signature");
}

async function refusesRead(rel, root, sentinel) {
  try {
    const text = await readWorktree(rel, root);
    if (text && text.includes(sentinel)) throw new Error("read returned the target");
    throw new Error("expected a refusal");
  } catch (e) {
    if (e.message === "read returned the target" || e.message === "expected a refusal") throw e;
    assert(!String(e.message).includes(sentinel), "refusal leaked the target");
  }
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

    fs.mkdirSync(path.join(vault, "sub", ".git", "hooks"), { recursive: true });
    fs.symlinkSync(path.join(vault, "sub", ".git", "hooks"), path.join(vault, "nested"));
    await rejects(() => worktreePath("nested/sample", vault));
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

async function inodeGitDir() {
  const vault = fs.mkdtempSync(path.join(os.tmpdir(), "aidanos-ino-"));
  try {
    // Linux cannot have both spellings of one directory. Point .git at
    // store so the resolved path has no ".git" text and the inode still matches.
    fs.mkdirSync(path.join(vault, "store", "hooks"), { recursive: true });
    fs.writeFileSync(path.join(vault, "store", "config"), "git-config-sentinel\n");
    fs.symlinkSync(path.join(vault, "store"), path.join(vault, ".git"));
    fs.symlinkSync(path.join(vault, "store", "hooks"), path.join(vault, "planted"));
    const spelled = fs.realpathSync(path.join(vault, "planted"));
    assert(!spelled.split(path.sep).includes(".git"), "inode case uses a path with no .git part");
    await rejects(() => worktreePath("planted/post-update", vault));

    fs.mkdirSync(path.join(vault, "notes"));
    fs.symlinkSync(path.join(vault, "store", "config"), path.join(vault, "notes", "gitcfg.md"));
    await refusesRead("notes/gitcfg.md", vault, "git-config-sentinel");

    if (process.platform !== "darwin" && process.platform !== "win32") {
      fs.mkdirSync(path.join(vault, ".GIT", "hooks"), { recursive: true });
      fs.symlinkSync(path.join(vault, ".GIT"), path.join(vault, "caps"));
      const allowed = await worktreePath("caps/hooks/x", vault);
      assert(allowed === path.join(vault, "caps", "hooks", "x"), "a different-inode .GIT folder is not the vault git dir");
    }
  } finally {
    fs.rmSync(vault, { recursive: true, force: true });
  }
}

async function leafChecks() {
  const vault = fs.mkdtempSync(path.join(os.tmpdir(), "aidanos-leaf-"));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "aidanos-leaf-out-"));
  try {
    fs.mkdirSync(path.join(vault, "notes"));
    fs.writeFileSync(path.join(vault, "notes", "real.md"), "inside\n");
    fs.symlinkSync(path.join(vault, "notes", "real.md"), path.join(vault, "notes", "alias.md"));
    assert(await readWorktree("notes/alias.md", vault) === "inside\n", "in-vault leaf link still reads");
    assert(await readWorktree("notes/missing.md", vault) == null, "missing note");

    fs.writeFileSync(path.join(outside, "secret.md"), "OUTSIDE_LEAF\n");
    fs.symlinkSync(path.join(outside, "secret.md"), path.join(vault, "notes", "leak.md"));
    await refusesRead("notes/leak.md", vault, "OUTSIDE_LEAF");
    assert(fs.readFileSync(path.join(outside, "secret.md"), "utf8") === "OUTSIDE_LEAF\n", "outside file unchanged");

    fs.mkdirSync(path.join(vault, ".git"));
    fs.writeFileSync(path.join(vault, ".git", "config"), "git-config-sentinel\n");
    fs.symlinkSync(path.join(vault, ".git", "config"), path.join(vault, "notes", "gitcfg.md"));
    await refusesRead("notes/gitcfg.md", vault, "git-config-sentinel");
  } finally {
    fs.rmSync(vault, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
}

async function decodedGitPath() {
  const vault = fs.mkdtempSync(path.join(os.tmpdir(), "aidanos-rel-"));
  try {
    const abs = await worktreePath("notes%2Fa.md", vault);
    assert(abs === path.join(vault, "notes", "a.md"), "percent-encoded slash is a real separator");
    assert(vaultRel(abs, vault) === "notes/a.md", "git receives the checked path");
  } finally {
    fs.rmSync(vault, { recursive: true, force: true });
  }
}

function gitWithEnv(args, cwd, allowFail) {
  try {
    return execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      env: gitEnv(),
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (e) {
    if (allowFail) return "";
    throw e;
  }
}

async function inheritedGitDirIsIgnored() {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "aidanos-gitdir-"));
  const decoy = fs.mkdtempSync(path.join(os.tmpdir(), "aidanos-gitdir-decoy-"));
  const planted = {
    GIT_DIR: decoy,
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "core.editor",
    GIT_CONFIG_VALUE_0: "evil-editor",
  };
  const saved = {};
  try {
    git(["init", "-b", "main"], repo);
    git(["config", "user.email", "t@local"], repo);
    git(["config", "user.name", "T"], repo);
    fs.writeFileSync(path.join(repo, "note.md"), "real\n");
    git(["add", "note.md"], repo);
    git(["commit", "-m", "seed"], repo);
    for (const key of Object.keys(planted)) {
      saved[key] = process.env[key];
      process.env[key] = planted[key];
    }
    const env = gitEnv();
    for (const key of Object.keys(planted)) {
      assert(!(key in env), key + " reached a git child");
    }
    assert(env.GIT_EDITOR === "true", "GIT_EDITOR was dropped");
    assert(env.GIT_MERGE_AUTOEDIT === "no", "GIT_MERGE_AUTOEDIT was dropped");
    assert(env.GIT_TERMINAL_PROMPT === "0", "GIT_TERMINAL_PROMPT was dropped");
    assert(env.GIT_LITERAL_PATHSPECS === "1", "literal pathspecs were dropped");
    const shown = gitWithEnv(["rev-parse", "--git-dir"], repo).trim();
    const resolved = path.resolve(repo, shown);
    assert(resolved === path.resolve(repo, ".git"), "git used the decoy directory " + shown);
  } finally {
    for (const key of Object.keys(planted)) {
      if (saved[key] == null) delete process.env[key];
      else process.env[key] = saved[key];
    }
    fs.rmSync(repo, { recursive: true, force: true });
    fs.rmSync(decoy, { recursive: true, force: true });
  }
}

async function plantedGitEnvIsIgnored() {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "aidanos-gitplant-"));
  const hooks = fs.mkdtempSync(path.join(os.tmpdir(), "aidanos-hooks-"));
  const decoy = fs.mkdtempSync(path.join(os.tmpdir(), "aidanos-common-"));
  const saved = {
    GIT_CONFIG_PARAMETERS: process.env.GIT_CONFIG_PARAMETERS,
    GIT_COMMON_DIR: process.env.GIT_COMMON_DIR,
    GIT_GLOB_PATHSPECS: process.env.GIT_GLOB_PATHSPECS,
  };
  try {
    git(["init", "-b", "main"], repo);
    git(["config", "user.email", "t@local"], repo);
    git(["config", "user.name", "T"], repo);
    git(["init", "-b", "main"], decoy);
    fs.writeFileSync(path.join(repo, "QA.md"), "qa\n");
    fs.writeFileSync(path.join(repo, "Q?.md"), "qq\n");
    git(["add", "-A"], repo);
    git(["commit", "-m", "seed"], repo);
    fs.writeFileSync(path.join(repo, "QA.md"), "changed-qa\n");
    fs.writeFileSync(path.join(repo, "Q?.md"), "changed-qq\n");
    process.env.GIT_CONFIG_PARAMETERS = "'core.hookspath'='" + hooks + "'";
    process.env.GIT_GLOB_PATHSPECS = "1";
    delete process.env.GIT_COMMON_DIR;
    const hooked = gitWithEnv(["config", "--get", "core.hookspath"], repo, true).trim();
    assert(hooked !== hooks, "git read core.hookspath from GIT_CONFIG_PARAMETERS");
    gitWithEnv(["add", "--", "Q?.md"], repo);
    const staged = git(["diff", "--cached", "--name-only"], repo).split("\n").map((s) => s.trim()).filter(Boolean);
    assert(staged.includes("Q?.md"), "literal Q?.md was not staged");
    assert(!staged.includes("QA.md"), "git honored GIT_GLOB_PATHSPECS");
    delete process.env.GIT_CONFIG_PARAMETERS;
    delete process.env.GIT_GLOB_PATHSPECS;
    process.env.GIT_COMMON_DIR = path.join(decoy, ".git");
    const shown = gitWithEnv(["rev-parse", "--git-common-dir"], repo).trim();
    assert(path.resolve(shown) !== path.resolve(decoy, ".git"), "git used the decoy GIT_COMMON_DIR " + shown);
    assert(path.resolve(repo, shown) === path.resolve(repo, ".git"), "common dir left the repo " + shown);
    const left = Object.keys(gitEnv()).filter((key) => key.startsWith("GIT_")).sort();
    assert(
      left.join(",") === "GIT_EDITOR,GIT_LITERAL_PATHSPECS,GIT_MERGE_AUTOEDIT,GIT_TERMINAL_PROMPT",
      "git child kept " + left.join(","),
    );
  } finally {
    for (const key of Object.keys(saved)) {
      if (saved[key] == null) delete process.env[key];
      else process.env[key] = saved[key];
    }
    fs.rmSync(repo, { recursive: true, force: true });
    fs.rmSync(hooks, { recursive: true, force: true });
    fs.rmSync(decoy, { recursive: true, force: true });
  }
}

async function hardLinkAndPipe() {
  const vault = fs.mkdtempSync(path.join(os.tmpdir(), "aidanos-nlink-"));
  const sentinel = "git-config-sentinel";
  try {
    git(["init", "-b", "main"], vault);
    fs.appendFileSync(path.join(vault, ".git", "config"), "\n# " + sentinel + "\n");
    fs.mkdirSync(path.join(vault, "notes"));
    fs.linkSync(path.join(vault, ".git", "config"), path.join(vault, "notes", "alias.md"));
    await refusesRead("notes/alias.md", vault, sentinel);
    execFileSync("mkfifo", [path.join(vault, "notes", "pipe.md")]);
    const hung = Symbol("hung");
    const result = await Promise.race([
      refusesRead("notes/pipe.md", vault, sentinel).then(() => "refused"),
      new Promise((resolve) => setTimeout(() => resolve(hung), 1500)),
    ]);
    assert(result === "refused", "fifo read hung");
  } finally {
    fs.rmSync(vault, { recursive: true, force: true });
  }
}

async function literalPathspecs() {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "aidanos-literal-"));
  try {
    git(["init", "-b", "main"], repo);
    git(["config", "user.email", "t@local"], repo);
    git(["config", "user.name", "T"], repo);
    fs.writeFileSync(path.join(repo, "QA.md"), "qa\n");
    fs.writeFileSync(path.join(repo, "Q?.md"), "qq\n");
    fs.writeFileSync(path.join(repo, "a.md"), "committed\n");
    git(["add", "-A"], repo);
    git(["commit", "-m", "seed"], repo);

    fs.writeFileSync(path.join(repo, "QA.md"), "changed-qa\n");
    fs.writeFileSync(path.join(repo, "Q?.md"), "changed-qq\n");
    gitWithEnv(["add", "--", "Q?.md"], repo);
    const staged = git(["diff", "--cached", "--name-only"], repo).split("\n").map((s) => s.trim()).filter(Boolean);
    assert(staged.includes("Q?.md"), "stages the literal note");
    assert(!staged.includes("QA.md"), "does not stage QA.md");

    git(["reset", "--hard"], repo);
    fs.rmSync(path.join(repo, "Q?.md"));
    gitWithEnv(["rm", "--", "Q?.md"], repo);
    assert(fs.readFileSync(path.join(repo, "QA.md"), "utf8") === "qa\n", "QA.md stays");
    const tracked = git(["ls-files"], repo).split("\n").map((s) => s.trim());
    assert(tracked.includes("QA.md"), "QA.md still tracked");
    assert(!tracked.includes("Q?.md"), "literal Q?.md is deleted");

    fs.writeFileSync(path.join(repo, "a.md"), "dirty\n");
    gitWithEnv(["checkout", "HEAD", "--", "?.md"], repo, true);
    assert(fs.readFileSync(path.join(repo, "a.md"), "utf8") === "dirty\n", "checkout of ?.md leaves a.md");
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
}

async function gitPointerFile() {
  const vault = fs.mkdtempSync(path.join(os.tmpdir(), "aidanos-pointer-"));
  try {
    git(["init", "-b", "main"], vault);
    git(["config", "user.email", "t@local"], vault);
    git(["config", "user.name", "T"], vault);
    fs.writeFileSync(path.join(vault, "README.md"), "seed\n");
    git(["add", "README.md"], vault);
    git(["commit", "-m", "seed"], vault);
    fs.renameSync(path.join(vault, ".git"), path.join(vault, "realgit"));
    fs.writeFileSync(path.join(vault, ".git"), "gitdir: realgit\n");
    const resolved = git(["rev-parse", "--git-dir"], vault).trim();
    fs.symlinkSync(path.resolve(vault, resolved, "hooks"), path.join(vault, "planted"));
    const spelled = fs.realpathSync(path.join(vault, "planted"));
    assert(!spelled.split(path.sep).includes(".git"), "pointer target is not named .git");
    await rejects(() => worktreePath("planted/post-update", vault));
  } finally {
    fs.rmSync(vault, { recursive: true, force: true });
  }
}

async function expectRefused(res, sentinel) {
  const text = await res.text();
  assert(res.status === 400, "expected a refusal, got " + res.status);
  assert(!text.includes(sentinel), "response included the target");
}

async function httpPaths() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "aidanos-http-"));
  const vault = path.join(tmp, "vault");
  const outside = path.join(tmp, "outside");
  fs.mkdirSync(vault);
  fs.mkdirSync(outside);
  const outsideDay = "OUTSIDE_DAY\n";
  fs.writeFileSync(path.join(outside, "2026-01-05.md"), outsideDay);
  fs.writeFileSync(path.join(outside, "2026-01-06.md"), "- [ ] OUTSIDE_TASK_SENTINEL\n");
  const port = 30000 + Math.floor(Math.random() * 2000);
  const child = spawnServer({
    PORT: String(port),
    AIDANOS_HOST: "127.0.0.1",
    AIDANOS_VAULT: vault,
    AIDANOS_VAULT_GIT_URL: "",
    AIDANOS_VAULT_GIT_TOKEN: "",
    GITHUB_TOKEN: "",
  });
  const base = "http://127.0.0.1:" + port;
  try {
    await waitHealth(base, child);
    fs.mkdirSync(path.join(vault, "notes"));
    const saved = await fetch(base + "/api/file?path=" + encodeURIComponent("notes/plain.md"), {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ markdown: "hello note\n" }),
    });
    assert(saved.status === 200, "ordinary note save failed");
    assert(fs.readFileSync(path.join(vault, "notes", "plain.md"), "utf8") === "hello note\n", "ordinary note was not written");
    const readNote = await fetch(base + "/api/file?path=" + encodeURIComponent("notes/plain.md"));
    const noteBody = await readNote.json();
    assert(readNote.status === 200 && noteBody.markdown === "hello note\n", "ordinary note read failed");
    const savedDay = await fetch(base + "/api/day?date=2026-01-05", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ markdown: "ordinary day\n" }),
    });
    assert(savedDay.status === 200, "ordinary day save failed");
    assert(fs.readFileSync(path.join(vault, "log", "2026-01-05.md"), "utf8") === "ordinary day\n", "ordinary day was not written");
    const readDay = await fetch(base + "/api/day?date=2026-01-05");
    const dayBody = await readDay.json();
    assert(readDay.status === 200 && dayBody.markdown === "ordinary day\n", "ordinary day read failed");
    const monthOk = await fetch(base + "/api/month?date=2026-01-05");
    const monthOkBody = await monthOk.json();
    assert(monthOk.status === 200 && monthOkBody.days.includes("2026-01-05"), "ordinary month failed");
    const listed = await fetch(base + "/api/tree?dir=" + encodeURIComponent("notes"));
    const listedBody = await listed.json();
    assert(listed.status === 200 && listedBody.files.includes("notes/plain.md"), "ordinary tree failed");
    const found = await fetch(base + "/api/search?q=" + encodeURIComponent("hello note"));
    const foundBody = await found.json();
    assert(found.status === 200 && foundBody.hits.some((hit) => hit.path === "notes/plain.md"), "ordinary search failed");

    fs.rmSync(path.join(vault, "log"), { recursive: true, force: true });
    fs.symlinkSync(outside, path.join(vault, "log"));
    const dayWrite = await fetch(base + "/api/day?date=2026-01-05", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ markdown: "PWNED\n" }),
    });
    await expectRefused(dayWrite, "OUTSIDE_DAY");
    assert(fs.readFileSync(path.join(outside, "2026-01-05.md"), "utf8") === outsideDay, "outside day was written");
    assert(fs.readdirSync(outside).sort().join(",") === "2026-01-05.md,2026-01-06.md", "outside log gained a file");
    await expectRefused(await fetch(base + "/api/day?date=2026-01-05"), "OUTSIDE_DAY");
    await expectRefused(
      await fetch(base + "/api/file?path=" + encodeURIComponent("log/2026-01-05.md")),
      "OUTSIDE_DAY",
    );
    await expectRefused(await fetch(base + "/api/tree?dir=" + encodeURIComponent("log")), "OUTSIDE_DAY");
    fs.mkdirSync(path.join(vault, "aidanos", "weeks"), { recursive: true });
    fs.writeFileSync(path.join(vault, "aidanos", "weeks", "2026-01-05.md"), "week\n");
    const weekRes = await fetch(base + "/api/week?start=2026-01-05");
    const weekText = await weekRes.text();
    assert(weekRes.status === 200, "week failed");
    assert(!weekText.includes("OUTSIDE_DAY") && !weekText.includes("OUTSIDE_TASK_SENTINEL"), "week included an outside day");
    const weekBody = JSON.parse(weekText);
    const tuesday = (weekBody.days || []).find((d) => d.date === "2026-01-06");
    assert(tuesday && !tuesday.task_open && !tuesday.rx_total, "week counted an outside task");
    const monthRes = await fetch(base + "/api/month?date=2026-01-05");
    const monthText = await monthRes.text();
    assert(monthRes.status === 200, "month failed");
    assert(!monthText.includes("2026-01-05") && !monthText.includes("2026-01-06"), "month listed an outside day");
    assert(!monthText.includes("OUTSIDE_DAY") && !monthText.includes("OUTSIDE_TASK_SENTINEL"), "month included outside text");
    const taskRes = await fetch(base + "/api/open-tasks");
    const taskText = await taskRes.text();
    assert(taskRes.status === 200, "open tasks failed");
    assert(!taskText.includes("OUTSIDE_DAY") && !taskText.includes("OUTSIDE_TASK_SENTINEL"), "open tasks included an outside task");

    fs.mkdirSync(path.join(vault, ".git", "info"), { recursive: true });
    fs.writeFileSync(path.join(vault, ".git", "info", "secret.md"), "GIT_SECRET\n");
    fs.symlinkSync(path.join(vault, ".git"), path.join(vault, "gitdir"));
    const gitWrite = await fetch(base + "/api/file?path=" + encodeURIComponent("gitdir/info/x.md"), {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ markdown: "secret write\n" }),
    });
    await expectRefused(gitWrite, "GIT_SECRET");
    assert(!fs.existsSync(path.join(vault, ".git", "info", "x.md")), "write landed in .git/info");
    assert(fs.readFileSync(path.join(vault, ".git", "info", "secret.md"), "utf8") === "GIT_SECRET\n", ".git file was changed");
    assert(fs.readdirSync(path.join(vault, ".git", "info")).join(",") === "secret.md", ".git/info gained a file");
    await expectRefused(
      await fetch(base + "/api/file?path=" + encodeURIComponent("gitdir/info/secret.md")),
      "GIT_SECRET",
    );
    await expectRefused(await fetch(base + "/api/tree?dir=" + encodeURIComponent("gitdir")), "GIT_SECRET");
    await expectRefused(await fetch(base + "/api/tree?dir=" + encodeURIComponent("gitdir/info")), "secret.md");
    const leaked = await fetch(base + "/api/search?q=" + encodeURIComponent("GIT_SECRET"));
    const leakedText = await leaked.text();
    assert(!leakedText.includes("GIT_SECRET"), "search returned the git file");
    const still = await fetch(base + "/api/file?path=" + encodeURIComponent("notes/plain.md"));
    const stillBody = await still.json();
    assert(still.status === 200 && stillBody.markdown === "hello note\n", "ordinary note read broke");
  } finally {
    await stop(child);
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

async function assertPlanAndSkin(base, sentinel) {
  const skin = await fetch(base + "/api/skin.css");
  const skinText = await skin.text();
  assert(skin.status === 200, "skin got " + skin.status);
  assert(skinText.includes("no personal skin"), "skin followed an alias of git config");
  assert(!skinText.includes(sentinel), "skin served git config");
  const plan = await fetch(base + "/api/plan");
  const planText = await plan.text();
  assert(plan.status === 200, "plan got " + plan.status);
  assert(!planText.includes(sentinel), "plan served git config");
  const body = JSON.parse(planText);
  assert(body.exists === false, "plan read an alias of git config");
}

async function planAndSkinDoNotServeGit() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "aidanos-alias-"));
  const vault = path.join(tmp, "vault");
  fs.mkdirSync(vault);
  git(["init", "-b", "main"], vault);
  const sentinel = "GIT_CONFIG_SENTINEL";
  const config = path.join(vault, ".git", "config");
  fs.appendFileSync(config, "\n# " + sentinel + "\n");
  const port = 34000 + Math.floor(Math.random() * 2000);
  const child = spawnServer({
    PORT: String(port),
    AIDANOS_HOST: "127.0.0.1",
    AIDANOS_VAULT: vault,
    AIDANOS_VAULT_GIT_URL: "",
    AIDANOS_VAULT_GIT_TOKEN: "",
    GITHUB_TOKEN: "",
  });
  const base = "http://127.0.0.1:" + port;
  const skinPath = path.join(vault, "aidanos", "skin.css");
  const planPath = path.join(vault, "aidanos", "active-horse.md");
  try {
    await waitHealth(base, child);
    fs.mkdirSync(path.join(vault, "aidanos"));
    fs.symlinkSync(config, skinPath);
    fs.symlinkSync(config, planPath);
    await assertPlanAndSkin(base, sentinel);
    fs.unlinkSync(skinPath);
    fs.unlinkSync(planPath);
    fs.linkSync(config, skinPath);
    fs.linkSync(config, planPath);
    await assertPlanAndSkin(base, sentinel);
    const health = await fetch(base + "/api/health");
    assert(health.status === 200, "server stopped after the alias reads");
  } finally {
    await stop(child);
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

async function readOnlySaveStaysUp() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "aidanos-ro-"));
  const vault = path.join(tmp, "vault");
  fs.mkdirSync(vault);
  const port = 32000 + Math.floor(Math.random() * 2000);
  const child = spawnServer({
    PORT: String(port),
    AIDANOS_HOST: "127.0.0.1",
    AIDANOS_VAULT: vault,
    AIDANOS_VAULT_GIT_URL: "",
    AIDANOS_VAULT_GIT_TOKEN: "",
    GITHUB_TOKEN: "",
  });
  const base = "http://127.0.0.1:" + port;
  const ro = path.join(vault, "ro");
  try {
    await waitHealth(base, child);
    fs.mkdirSync(ro);
    fs.chmodSync(ro, 0o555);
    const loggedBefore = child._log().length;
    const res = await fetch(base + "/api/file?path=" + encodeURIComponent("ro/x.md"), {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ markdown: "nope\n" }),
    });
    const text = await res.text();
    assert(res.status === 500, "read-only save got " + res.status + " " + text);
    assert(text === JSON.stringify({ error: "internal error" }), "read-only save leaked " + text);
    assert(!text.includes(vault) && !text.includes(tmp), "save response included a path");
    await new Promise((r) => setTimeout(r, 300));
    assert(child.exitCode == null, "server exited after a failed save");
    const health = await fetch(base + "/api/health");
    assert(health.status === 200, "server was not up after the failed save");
    const logged = child._log().slice(loggedBefore);
    assert(!logged.includes(vault), "save log included the vault path");
    assert(!logged.includes(tmp), "save log included the temp path");
    assert(!fs.existsSync(path.join(ro, "x.md")), "read-only folder was written");
    const again = await fetch(base + "/api/file?path=" + encodeURIComponent("notes/ok.md"), {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ markdown: "still up\n" }),
    });
    assert(again.status === 200, "later save failed after the read-only put");
  } finally {
    try { fs.chmodSync(ro, 0o755); } catch {}
    await stop(child);
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

checkWiring();
await pathChecks();
await inodeGitDir();
await leafChecks();
await decodedGitPath();
await literalPathspecs();
await inheritedGitDirIsIgnored();
await plantedGitEnvIsIgnored();
await hardLinkAndPipe();
await gitPointerFile();
await httpPaths();
await planAndSkinDoNotServeGit();
await readOnlySaveStaysUp();
await liveSyncDoesNotFollowOutside();
console.log("sync-path-test ok");
