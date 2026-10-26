#!/usr/bin/env node
// Every symlink under the vault is refused, including one that stays inside.
// The error names that path. A symlinked vault root refuses to start.
// An unexpected write stops the process. An unexpected read fails that request.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
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
  assert(envFn.includes('GIT_CONFIG_GLOBAL = "/dev/null"') && envFn.includes('GIT_CONFIG_NOSYSTEM = "1"'), "git ignores home and system config");
  assert(run.includes("gitEnv()") && run.includes("gitSafetyPrefix()"), "git commands use that environment and per-command safety");
  assert(read.includes("worktreePath") && read.includes("readableTarget") && read.includes("readRegularText"), "read checks parents and the leaf");
  assert(reader.includes("readRegularText"), "note reads open the checked file");
  assert(rel.includes("readWorktree"), "sync read uses the leaf check");
  assert(write.indexOf("worktreePath") !== write.lastIndexOf("worktreePath"), "write rechecks the folder");
  assert(atomic.includes("beforeRename") && atomic.indexOf("beforeRename") < atomic.indexOf("fs.rename"), "recheck sits before rename");
  assert(atomic.indexOf("assertParents") < atomic.indexOf("writeFile"), "parent snapshot is checked before any bytes are written");
  assert(atomic.includes("assertOpenedTemp") && atomic.includes("unlinkIfSameFile"), "a failed save removes only the opened temp file");
  assert(atomic.includes("!e.aidanosStop"), "a tagged directory error stays a stop");
  assert(detach.includes("vaultRel") && detach.indexOf("worktreePath") < detach.indexOf("unlink"), "unlink checks the path and git gets the checked name");
  assert(detach.includes("snapshotParents") && detach.indexOf("snapshotParents") < detach.indexOf("assertParents") && detach.indexOf("assertParents") < detach.indexOf("unlink"), "detach rechecks the parent snapshot before delete");
  assert(!detach.includes('"--", rel'), "detach does not pass the raw name");
  assert(announce.includes("worktreePath"), "watch stat checks the parent path");
  assert(conflicts.includes("worktreePath") && !conflicts.includes("safeJoin(VAULT"), "conflict mtime uses the checked path");
  assert(choices.includes("worktreePath") && !choices.includes("safeJoin(VAULT"), "choice mtime uses the checked path");
  assert(drop.includes("worktreePath") && !drop.includes("safeJoin(VAULT"), "stale choice mtime uses the checked path");
  assert(stage.includes("vaultRel") && stage.indexOf("worktreePath") < stage.indexOf("pathExists"), "stage checks the path first");
  assert(!stage.includes('"--", rel'), "stage does not pass the raw name");
  assert(reader.includes("readableTarget"), "note reads use the leaf check");
  assert(write.includes(".dev") && write.includes(".ino"), "write compares the folder inode after rename");
  assert(!write.includes("unlink"), "a failed parent check does not delete the file");
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
  assert(dayGet.includes("worktreePath") && dayGet.includes("gitSymlinkSet"), "day read uses worktreePath and skips a git link");
  assert(dayPut.includes("worktreePath") && dayPut.includes("gitSymlinkSet") && !dayPut.includes('path.join(VAULT, "log"'), "day write uses worktreePath and skips a git link");
  assert(dayPut.includes('error: "not a file"'), "a day folder is refused before the write");
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
  assert(serverSrc.includes('throw symlinkError(relSoFar)'), "every path part refuses a symlink");
  assert(serverSrc.includes("Point AIDANOS_VAULT at the real folder."), "startup names the real folder");
  assert(!serverSrc.includes("fs.realpath(logicalRoot)"), "the vault root is not realpath'd open");
  const treeFn = sliceFn("async function listMdTree(", "function dayMarkdownFromBody(");
  assert(treeFn.includes("rememberSkip"), "a listing skips a symlink and remembers it");
  assert(!treeFn.includes("symlinkError"), "a listing does not fail the whole view");
  assert(serverSrc.includes("stopAfterResponse"), "a tagged failure stops the process");
  assert(serverSrc.includes("aidanosStop"), "stop is tagged on the step that failed");
  assert(serverSrc.includes('["core.symlinks", "false"]'), "git does not check out symlinks");
  assert(serverSrc.includes('["credential.helper", ""]') && serverSrc.includes('["core.sshCommand", "ssh"]'), "git ignores credential helpers and a custom ssh command");
  const top = sliceFn('if (err && err.code === "BODY_TOO_LARGE")', "function refuseSymlinkedVaultRoot(");
  assert(top.includes('(err.code === "EISDIR" || err.code === "ENOTDIR") && !err.aidanosStop'), "only an untagged directory error is a 400");
  assert(serverSrc.includes("aidanos-no-hooks"), "git hooks point at a directory we never create");
  assert(skin.includes("X-Skipped-Links"), "skin reports a skipped link in a header");
  const inPlaceAt = atomic.indexOf('noteSaveStyle(filePath) === "in-place"');
  assert(inPlaceAt !== -1, "in-place saves do not share atomicWriteFile");
  const inPlace = atomic.slice(inPlaceAt, atomic.indexOf("return;", inPlaceAt));
  assert(inPlace.indexOf("assertParents") !== -1 && inPlace.indexOf("assertParents") < inPlace.indexOf("writeNoteText"), "in-place rechecks parents before the write");
  assert(inPlace.indexOf("beforeRename") !== -1 && inPlace.indexOf("beforeRename") < inPlace.indexOf("writeNoteText"), "in-place runs the parent hook before the write");
  assert(inPlace.includes("expectFile") && inPlace.includes("afterOpen"), "in-place checks the opened file before it writes");
  const heldAt = inPlace.lastIndexOf("holdWriteForTest");
  const openAt = inPlace.indexOf("writeNoteText");
  assert(heldAt !== -1 && heldAt < openAt, "the in-place hold is not after the last parent check");
  assert(inPlace.lastIndexOf("assertParents", openAt) < heldAt, "a parent check still runs after the in-place hold and before the open");
  assert(!inPlace.includes("fs.rename") && !inPlace.includes("unlink"), "an in-place save does not rename or delete the note");
}

async function refusesNamed(fn, named) {
  try {
    await fn();
  } catch (e) {
    const msg = String(e && e.message || e);
    assert(msg.includes(named), "refusal did not name " + named + ": " + msg);
    assert(!path.isAbsolute(msg), "refusal included an absolute path");
    return;
  }
  throw new Error("expected a refusal of " + named);
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
    fs.writeFileSync(path.join(vault, "real", "note.md"), "inside\n");
    fs.symlinkSync(path.join(vault, "real"), path.join(vault, "alias"));
    await refusesNamed(() => worktreePath("alias/note.md", vault), "alias");
    await refusesNamed(() => readWorktree("alias/note.md", vault), "alias");
    assert(fs.readFileSync(path.join(vault, "real", "note.md"), "utf8") === "inside\n", "in-vault link was followed");

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
      await refusesNamed(() => worktreePath("caps/hooks/x", vault), "caps");
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
    await refusesNamed(() => readWorktree("notes/alias.md", vault), "notes/alias.md");
    assert(fs.readFileSync(path.join(vault, "notes", "real.md"), "utf8") === "inside\n", "in-vault file link was followed");
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
      left.join(",") === "GIT_CONFIG_GLOBAL,GIT_CONFIG_NOSYSTEM,GIT_EDITOR,GIT_LITERAL_PATHSPECS,GIT_MERGE_AUTOEDIT,GIT_TERMINAL_PROMPT",
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
    assert(weekRes.status === 200, "week failed closed on a linked log: " + weekText);
    assert(weekText.includes('"log"'), "week did not report the linked log");
    assert(!weekText.includes("OUTSIDE_DAY") && !weekText.includes("OUTSIDE_TASK_SENTINEL"), "week included an outside day");
    const monthRes = await fetch(base + "/api/month?date=2026-01-05");
    const monthText = await monthRes.text();
    assert(monthRes.status === 200, "month failed closed on a linked log: " + monthText);
    assert(monthText.includes('"log"'), "month did not report the linked log");
    assert(!monthText.includes("OUTSIDE_DAY") && !monthText.includes("OUTSIDE_TASK_SENTINEL"), "month included outside text");
    const taskRes = await fetch(base + "/api/open-tasks");
    const taskText = await taskRes.text();
    assert(taskRes.status === 200, "open tasks failed closed on a linked log: " + taskText);
    assert(taskText.includes('"log"'), "open tasks did not report the linked log");
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

async function assertPlanAndSkin(base, sentinel, mode) {
  const skin = await fetch(base + "/api/skin.css");
  const skinText = await skin.text();
  const plan = await fetch(base + "/api/plan");
  const planText = await plan.text();
  assert(!skinText.includes(sentinel), "skin served git config");
  assert(!planText.includes(sentinel), "plan served git config");
  if (mode === "symlink") {
    assert(skin.status === 200, "skin symlink got " + skin.status + " " + skinText);
    assert(skinText.includes("no personal skin"), "skin followed the link");
    assert(String(skin.headers.get("x-skipped-links") || "").includes("aidanos/skin.css"), "skin did not name the link");
    assert(plan.status === 200, "plan symlink got " + plan.status + " " + planText);
    const linked = JSON.parse(planText);
    assert(linked.exists === false, "plan followed the link");
    assert(linked.skippedLinks.includes("aidanos/active-horse.md"), "plan did not name the link");
    return;
  }
  assert(skin.status === 200, "skin got " + skin.status);
  assert(skinText.includes("no personal skin"), "skin followed a hard link of git config");
  assert(plan.status === 200, "plan got " + plan.status);
  const body = JSON.parse(planText);
  assert(body.exists === false, "plan read a hard link of git config");
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
    await assertPlanAndSkin(base, sentinel, "symlink");
    fs.unlinkSync(skinPath);
    fs.unlinkSync(planPath);
    fs.linkSync(config, skinPath);
    fs.linkSync(config, planPath);
    await assertPlanAndSkin(base, sentinel, "hardlink");
    const health = await fetch(base + "/api/health");
    assert(health.status === 200, "server stopped after the alias reads");
  } finally {
    await stop(child);
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

async function waitExit(child, ms) {
  const deadline = Date.now() + ms;
  while (child.exitCode == null && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 40));
  }
  await new Promise((r) => setTimeout(r, 30));
}

function runningAsRoot() {
  return typeof process.getuid === "function" && process.getuid() === 0;
}

async function readErrorStaysUp() {
  if (runningAsRoot()) {
    console.log("skip permission test as root");
    return;
  }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "aidanos-read-"));
  const vault = path.join(tmp, "vault");
  fs.mkdirSync(path.join(vault, "notes"), { recursive: true });
  const note = path.join(vault, "notes", "secret.md");
  fs.writeFileSync(note, "NOTE_BODY_SECRET\n");
  const port = 33000 + Math.floor(Math.random() * 2000);
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
    fs.chmodSync(note, 0);
    const loggedBefore = child._log().length;
    const res = await fetch(base + "/api/file?path=" + encodeURIComponent("notes/secret.md"));
    const text = await res.text();
    assert(res.status === 403, "unreadable note got " + res.status + " " + text);
    assert(text === JSON.stringify({ error: "not readable" }), "unreadable note leaked " + text);
    assert(!text.includes("NOTE_BODY_SECRET"), "read response included the note");
    assert(!text.includes(vault) && !text.includes(tmp), "read response included a path");
    await new Promise((r) => setTimeout(r, 200));
    assert(child.exitCode == null, "server exited after a failed read");
    const health = await fetch(base + "/api/health");
    assert(health.status === 200, "server was not up after the failed read");
    const logged = child._log().slice(loggedBefore);
    assert(!logged.includes(vault), "read log included the vault path");
    assert(!logged.includes(tmp), "read log included the temp path");
    assert(!logged.includes("NOTE_BODY_SECRET"), "read log included the note");
  } finally {
    try { fs.chmodSync(note, 0o644); } catch {}
    await stop(child);
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

async function writeErrorStops() {
  if (runningAsRoot()) {
    console.log("skip permission test as root");
    return;
  }
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
    let status = 0;
    let text = "";
    try {
      const res = await fetch(base + "/api/file?path=" + encodeURIComponent("ro/x.md"), {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ markdown: "nope\n" }),
      });
      status = res.status;
      text = await res.text();
    } catch (e) {
      text = String(e && e.message || e);
    }
    await waitExit(child, 4000);
    assert(child.exitCode != null, "server stayed up after a failed write");
    if (status) {
      assert(status === 500, "failed write got " + status + " " + text);
      assert(text === JSON.stringify({ error: "internal error" }), "failed write leaked " + text);
    }
    assert(!text.includes("nope"), "write response included the note");
    assert(!text.includes(vault) && !text.includes(tmp), "write response included a path");
    const logged = child._log().slice(loggedBefore);
    assert(logged.includes("stopped: write EACCES"), "write log did not name the step and code: " + logged);
    assert(!logged.includes(vault), "write log included the vault path");
    assert(!logged.includes(tmp), "write log included the temp path");
    assert(!logged.includes("nope"), "write log included the note");
    assert(!logged.includes("ro/x"), "write log included the note path");
    assert(!fs.existsSync(path.join(ro, "x.md")), "read-only folder was written");
  } finally {
    try { fs.chmodSync(ro, 0o755); } catch {}
    await stop(child);
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

async function nestedAndFileSymlinks() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "aidanos-nest-"));
  const vault = path.join(tmp, "vault");
  const outside = path.join(tmp, "outside");
  fs.mkdirSync(path.join(vault, "notes", "box"), { recursive: true });
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(vault, "notes", "box", "real.md"), "inside\n");
  fs.writeFileSync(path.join(outside, "secret.md"), "NESTED_SECRET\n");
  fs.symlinkSync(path.join(outside, "secret.md"), path.join(vault, "notes", "box", "alias.md"));
  fs.symlinkSync(outside, path.join(vault, "notes", "box", "gone"));
  await refusesNamed(() => readWorktree("notes/box/alias.md", vault), "notes/box/alias.md");
  await refusesNamed(() => worktreePath("notes/box/gone/note.md", vault), "notes/box/gone");
  assert(fs.readFileSync(path.join(outside, "secret.md"), "utf8") === "NESTED_SECRET\n", "nested link was followed");

  const port = 35000 + Math.floor(Math.random() * 2000);
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
    const file = await fetch(base + "/api/file?path=" + encodeURIComponent("notes/box/alias.md"));
    const fileText = await file.text();
    assert(file.status === 400, "symlinked file got " + file.status);
    assert(fileText.includes("symlink: notes/box/alias.md"), "file response did not name the link");
    assert(!fileText.includes("NESTED_SECRET"), "file response followed the link");
    const tree = await fetch(base + "/api/tree?dir=" + encodeURIComponent("notes/box"));
    const treeBody = await tree.json();
    assert(tree.status === 200, "nested listing got " + tree.status);
    assert(treeBody.files.includes("notes/box/real.md"), "listing dropped the real note");
    assert(treeBody.skippedLinks.includes("notes/box/alias.md"), "listing did not name the file link");
    assert(treeBody.skippedLinks.includes("notes/box/gone"), "listing did not name the folder link");
    assert(!JSON.stringify(treeBody).includes("NESTED_SECRET"), "listing followed the link");
    const health = await fetch(base + "/api/health");
    assert(health.status === 200, "server stopped after a symlink refusal");
  } finally {
    await stop(child);
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

async function symlinkedVaultRootRefused() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "aidanos-root-"));
  const real = path.join(tmp, "real");
  const link = path.join(tmp, "link");
  fs.mkdirSync(real);
  fs.writeFileSync(path.join(real, "note.md"), "ROOT_SECRET\n");
  fs.symlinkSync(real, link);
  const port = 36000 + Math.floor(Math.random() * 2000);
  const child = spawnServer({
    PORT: String(port),
    AIDANOS_HOST: "127.0.0.1",
    AIDANOS_VAULT: link,
    AIDANOS_VAULT_GIT_URL: "",
    AIDANOS_VAULT_GIT_TOKEN: "",
    GITHUB_TOKEN: "",
  });
  try {
    await waitExit(child, 4000);
    const log = child._log();
    assert(child.exitCode != null, "server stayed up with a symlinked vault");
    assert(log.includes(link), "startup did not name the configured path");
    assert(log.includes("Point AIDANOS_VAULT at the real folder."), "startup did not say to point at the real folder");
    assert(!log.includes("ROOT_SECRET"), "startup read the linked vault");
    let served = false;
    try {
      const res = await fetch("http://127.0.0.1:" + port + "/api/health", { signal: AbortSignal.timeout(400) });
      if (res.ok) served = true;
    } catch { /* not listening */ }
    assert(!served, "symlinked vault served traffic");
    assert(fs.readFileSync(path.join(real, "note.md"), "utf8") === "ROOT_SECRET\n", "linked vault was written");
  } finally {
    await stop(child);
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

function quietLines(log, ...banned) {
  for (const line of log.split("\n")) {
    if (!/sync paused|stopped:|vault seed|vault git|refused:|request failed/.test(line)) continue;
    for (const word of banned) {
      if (word) assert(!line.includes(word), "log leaked " + word + " in " + line);
    }
  }
}

function cutOffUpload(port, rel) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
    const sock = net.connect(port, "127.0.0.1", () => {
      const target = "/api/file?path=" + encodeURIComponent(rel);
      sock.write("PUT " + target + " HTTP/1.1\r\n");
      sock.write("Host: 127.0.0.1:" + port + "\r\n");
      sock.write("Content-Type: application/json\r\n");
      sock.write("Content-Length: 1000\r\n");
      sock.write("Connection: close\r\n\r\n");
      sock.write('{"markdown":"abc');
      sock.end();
      setTimeout(() => {
        sock.destroy();
        finish();
      }, 300);
    });
    sock.on("error", finish);
    sock.on("close", finish);
  });
}

async function abortAndLongNameStayUp() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "aidanos-len-"));
  const vault = path.join(tmp, "vault");
  fs.mkdirSync(path.join(vault, "notes"), { recursive: true });
  const port = 37000 + Math.floor(Math.random() * 2000);
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
    await cutOffUpload(port, "notes/cut.md");
    await new Promise((r) => setTimeout(r, 200));
    assert(child.exitCode == null, "server exited after a cut-off upload");
    const health = await fetch(base + "/api/health");
    assert(health.status === 200, "health failed after a cut-off upload");
    assert(!fs.existsSync(path.join(vault, "notes", "cut.md")), "cut-off upload was stored");
    const exact = ("ab/".repeat(132) + "x.md");
    assert(exact.length === 400, "fixture length " + exact.length);
    assert(exact.split("/").every((part) => part.length < 200), "fixture part is too long");
    const saved = await fetch(base + "/api/file?path=" + encodeURIComponent(exact), {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ markdown: "fits\n" }),
    });
    assert(saved.status === 200, "400-character name got " + saved.status);
    assert(fs.readFileSync(path.join(vault, ...exact.split("/")), "utf8") === "fits\n", "400-character name was not saved");
    const longName = "ab/".repeat(132) + "xy.md";
    assert(longName.length === 401, "401 fixture length " + longName.length);
    assert(longName.split("/").every((part) => part.length < 200), "401 fixture part is too long");
    const longRes = await fetch(base + "/api/file?path=" + encodeURIComponent(longName), {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ markdown: "too long\n" }),
    });
    assert(longRes.status === 400, "401-character name got " + longRes.status);
    const wide = "p".repeat(250) + ".md";
    const wideRes = await fetch(base + "/api/file?path=" + encodeURIComponent("notes/" + wide), {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ markdown: "too wide\n" }),
    });
    assert(wideRes.status === 400, "250-character name got " + wideRes.status);
    assert(child.exitCode == null, "server exited after a long name");
    const again = await fetch(base + "/api/health");
    assert(again.status === 200, "health failed after a long name");
    assert(!fs.existsSync(path.join(vault, "notes", wide)), "long name was written");
  } finally {
    await stop(child);
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

function gitQuiet(dir, args) {
  return execFileSync("git", args, {
    cwd: dir,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function localConfig(dir, key) {
  try {
    return gitQuiet(dir, ["config", "--local", "--get", key]).trim();
  } catch {
    return "";
  }
}

async function syncRequestStops() {
  if (runningAsRoot()) {
    console.log("skip permission test as root");
    return;
  }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "aidanos-syncstop-"));
  const vault = path.join(tmp, "vault");
  const bare = path.join(tmp, "bare.git");
  fs.mkdirSync(vault);
  gitQuiet(tmp, ["init", "--bare", "-b", "main", bare]);
  gitQuiet(tmp, ["init", "-b", "main", vault]);
  gitQuiet(vault, ["config", "user.email", "t@local"]);
  gitQuiet(vault, ["config", "user.name", "t"]);
  const port = 37200 + Math.floor(Math.random() * 200);
  const token = "TOKEN_SENTINEL_sync";
  const child = spawnServer({
    PORT: String(port),
    AIDANOS_HOST: "127.0.0.1",
    AIDANOS_VAULT: vault,
    AIDANOS_VAULT_GIT_URL: bare,
    AIDANOS_VAULT_GIT_TOKEN: token,
    GITHUB_TOKEN: "",
    AIDANOS_VAULT_GIT_SYNC_MS: "0",
  });
  const base = "http://127.0.0.1:" + port;
  try {
    await waitHealth(base, child);
    fs.chmodSync(vault, 0);
    const loggedBefore = child._log().length;
    let status = 0;
    let text = "";
    try {
      const res = await fetch(base + "/api/sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ join: true }),
      });
      status = res.status;
      text = await res.text();
    } catch (e) {
      text = String(e && e.message || e);
    }
    await waitExit(child, 4000);
    assert(child.exitCode != null, "server stayed up after a sync filesystem error");
    if (status) {
      assert(status === 500, "sync filesystem error got " + status + " " + text);
      assert(text === JSON.stringify({ error: "internal error" }), "sync error leaked " + text);
    }
    const logged = child._log().slice(loggedBefore);
    assert(logged.includes("stopped: git EACCES"), "sync stop log was " + logged);
    quietLines(logged, token, bare, vault, "note body");
  } finally {
    try { fs.chmodSync(vault, 0o755); } catch {}
    await stop(child);
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

async function backgroundSyncPauses() {
  if (runningAsRoot()) {
    console.log("skip permission test as root");
    return;
  }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "aidanos-pause-"));
  const vault = path.join(tmp, "vault");
  const bare = path.join(tmp, "bare.git");
  fs.mkdirSync(vault);
  gitQuiet(tmp, ["init", "--bare", "-b", "main", bare]);
  gitQuiet(tmp, ["init", "-b", "main", vault]);
  gitQuiet(vault, ["config", "user.email", "t@local"]);
  gitQuiet(vault, ["config", "user.name", "t"]);
  const port = 37400 + Math.floor(Math.random() * 200);
  const token = "TOKEN_SENTINEL_bg";
  const child = spawnServer({
    PORT: String(port),
    AIDANOS_HOST: "127.0.0.1",
    AIDANOS_VAULT: vault,
    AIDANOS_VAULT_GIT_URL: bare,
    AIDANOS_VAULT_GIT_TOKEN: token,
    GITHUB_TOKEN: "",
    AIDANOS_VAULT_GIT_SYNC_MS: "400",
  });
  const base = "http://127.0.0.1:" + port;
  try {
    await waitHealth(base, child);
    const loggedBefore = child._log().length;
    fs.chmodSync(vault, 0);
    const deadline = Date.now() + 4000;
    let logged = "";
    while (Date.now() < deadline) {
      logged = child._log().slice(loggedBefore);
      if (logged.includes("sync paused:")) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    assert(child.exitCode == null, "background sync exited the server");
    assert(logged.includes("sync paused: git EACCES"), "background sync did not pause: " + logged);
    quietLines(logged, token, bare, vault);
    const health = await fetch(base + "/api/health");
    const body = await health.json();
    assert(health.status === 200, "health failed while sync is paused");
    assert(body.git && body.git.error === "sync paused", "health did not mark git paused");
    await new Promise((r) => setTimeout(r, 500));
    assert(child.exitCode == null, "a later sync exited the server");
  } finally {
    try { fs.chmodSync(vault, 0o755); } catch {}
    await stop(child);
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

async function bootSyncPauses() {
  if (runningAsRoot()) {
    console.log("skip permission test as root");
    return;
  }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "aidanos-boot-"));
  const vault = path.join(tmp, "vault");
  const bare = path.join(tmp, "bare.git");
  fs.mkdirSync(vault);
  gitQuiet(tmp, ["init", "--bare", "-b", "main", bare]);
  fs.chmodSync(vault, 0);
  const port = 37600 + Math.floor(Math.random() * 200);
  const token = "TOKEN_SENTINEL_boot";
  const child = spawnServer({
    PORT: String(port),
    AIDANOS_HOST: "127.0.0.1",
    AIDANOS_VAULT: vault,
    AIDANOS_VAULT_GIT_URL: bare,
    AIDANOS_VAULT_GIT_TOKEN: token,
    GITHUB_TOKEN: "",
    AIDANOS_VAULT_GIT_SYNC_MS: "0",
  });
  const base = "http://127.0.0.1:" + port;
  try {
    await waitHealth(base, child);
    assert(child.exitCode == null, "boot filesystem error exited");
    const health = await fetch(base + "/api/health");
    const body = await health.json();
    assert(health.status === 200 && body.git && body.git.error === "sync paused", "boot did not mark git paused");
    quietLines(child._log(), token, bare, vault);
    assert(child._log().includes("sync paused: git EACCES"), "boot did not pause: " + child._log());
  } finally {
    try { fs.chmodSync(vault, 0o755); } catch {}
    await stop(child);
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

async function rejectedPushStaysUp() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "aidanos-push-"));
  const vault = path.join(tmp, "vault");
  const bare = path.join(tmp, "bare.git");
  fs.mkdirSync(vault);
  gitQuiet(tmp, ["init", "--bare", "-b", "main", bare]);
  gitQuiet(tmp, ["init", "-b", "main", vault]);
  gitQuiet(vault, ["config", "user.email", "t@local"]);
  gitQuiet(vault, ["config", "user.name", "t"]);
  const port = 37800 + Math.floor(Math.random() * 200);
  const child = spawnServer({
    PORT: String(port),
    AIDANOS_HOST: "127.0.0.1",
    AIDANOS_VAULT: vault,
    AIDANOS_VAULT_GIT_URL: bare,
    AIDANOS_VAULT_GIT_TOKEN: "",
    GITHUB_TOKEN: "",
    AIDANOS_VAULT_GIT_SYNC_MS: "0",
  });
  const base = "http://127.0.0.1:" + port;
  try {
    await waitHealth(base, child);
    gitQuiet(vault, ["remote", "set-url", "origin", path.join(tmp, "missing")]);
    const res = await fetch(base + "/api/sync", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ join: true }),
    });
    const text = await res.text();
    assert(res.status === 409, "rejected push got " + res.status + " " + text);
    assert(child.exitCode == null, "rejected push exited the server");
    const health = await fetch(base + "/api/health");
    assert(health.status === 200, "health failed after a rejected push");
    assert(!child._log().includes("stopped:"), "rejected push stopped the process");
  } finally {
    await stop(child);
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

async function gitSafetyAndIndexLink() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "aidanos-safe-"));
  const bare = path.join(tmp, "bare.git");
  const src = path.join(tmp, "src");
  const vault = path.join(tmp, "vault");
  gitQuiet(tmp, ["init", "--bare", "-b", "main", bare]);
  gitQuiet(tmp, ["clone", bare, src]);
  fs.writeFileSync(path.join(src, "target.md"), "LINK_TARGET_SECRET\n");
  fs.symlinkSync("target.md", path.join(src, "link.md"));
  fs.mkdirSync(path.join(src, "log"));
  fs.writeFileSync(path.join(src, "log", "day-target.md"), "DAY_LINK_SECRET\n");
  fs.symlinkSync("day-target.md", path.join(src, "log", "2026-04-01.md"));
  gitQuiet(src, ["config", "user.email", "t@local"]);
  gitQuiet(src, ["config", "user.name", "t"]);
  gitQuiet(src, ["add", "target.md", "link.md", "log/day-target.md", "log/2026-04-01.md"]);
  gitQuiet(src, ["commit", "-m", "link"]);
  gitQuiet(src, ["push", "origin", "HEAD"]);
  const port = 38000 + Math.floor(Math.random() * 200);
  const child = spawnServer({
    PORT: String(port),
    AIDANOS_HOST: "127.0.0.1",
    AIDANOS_VAULT: vault,
    AIDANOS_VAULT_GIT_URL: bare,
    AIDANOS_VAULT_GIT_TOKEN: "",
    GITHUB_TOKEN: "",
    AIDANOS_VAULT_GIT_SYNC_MS: "0",
  });
  const base = "http://127.0.0.1:" + port;
  try {
    await waitHealth(base, child);
    assert(localConfig(vault, "core.symlinks") === "", "core.symlinks was written into the repo");
    assert(localConfig(vault, "core.hooksPath") === "", "hooksPath was written into the repo");
    assert(localConfig(vault, "core.fsmonitor") === "", "fsmonitor was written into the repo");
    assert(localConfig(vault, "protocol.allow") === "", "protocol.allow was written into the repo");
    assert(localConfig(vault, "user.name") !== "", "git identity was not stored in the repo");
    const hooks = path.join(vault, ".git", "aidanos-no-hooks");
    assert(!fs.existsSync(hooks), "hooks directory was created");
    const listed = gitQuiet(vault, ["ls-files", "-s", "link.md"]);
    assert(listed.startsWith("120000 "), "index mode was " + listed);
    assert(!fs.lstatSync(path.join(vault, "link.md")).isSymbolicLink(), "clone checked out a symlink");
    const file = await fetch(base + "/api/file?path=" + encodeURIComponent("link.md"));
    const fileText = await file.text();
    assert(file.status === 400, "git link got " + file.status + " " + fileText);
    assert(!fileText.includes("LINK_TARGET_SECRET"), "git link returned the target");
    const tree = await fetch(base + "/api/tree");
    const treeBody = await tree.json();
    assert(tree.status === 200, "tree failed on a git link");
    assert(treeBody.skippedLinks.includes("link.md"), "tree did not report the git link");
    assert(!JSON.stringify(treeBody).includes("LINK_TARGET_SECRET"), "tree followed the git link");
    assert(treeBody.files.includes("target.md"), "tree dropped the real note");
    const dayPath = path.join(vault, "log", "2026-04-01.md");
    const dayBefore = fs.readFileSync(dayPath);
    assert(!fs.lstatSync(dayPath).isSymbolicLink(), "day checkout followed the git link");
    const day = await fetch(base + "/api/day?date=2026-04-01");
    const dayText = await day.text();
    const dayBody = JSON.parse(dayText);
    assert(day.status === 200, "day read failed " + day.status + " " + dayText);
    assert(dayBody.markdown === "", "day read served the git link");
    assert(dayBody.skippedLinks.includes("log/2026-04-01.md"), "day read did not report the git link");
    assert(!dayText.includes("DAY_LINK_SECRET") && !dayText.includes("day-target.md"), "day read followed the git link");
    const dayPut = await fetch(base + "/api/day?date=2026-04-01", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ markdown: "replaced\n" }),
    });
    const dayPutText = await dayPut.text();
    assert(dayPut.status === 400, "day write of a git link got " + dayPut.status + " " + dayPutText);
    assert(dayPutText.includes("symlink: log/2026-04-01.md"), "day write did not name the git link");
    assert(!dayPutText.includes("DAY_LINK_SECRET"), "day write leaked the target");
    assert(Buffer.compare(fs.readFileSync(dayPath), dayBefore) === 0, "day write replaced the git link");
    assert(!fs.lstatSync(dayPath).isSymbolicLink(), "day write turned the git link into a symlink");
  } finally {
    await stop(child);
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

async function aggregateSkipsLinks() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "aidanos-skip-"));
  const vault = path.join(tmp, "vault");
  const outside = path.join(tmp, "outside");
  fs.mkdirSync(path.join(vault, "notes"), { recursive: true });
  fs.mkdirSync(path.join(vault, "log"), { recursive: true });
  fs.mkdirSync(path.join(vault, "aidanos", "weeks"), { recursive: true });
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, "secret.md"), "SKIP_FILE_SECRET\n");
  fs.writeFileSync(path.join(outside, "day.md"), "SKIP_DAY_SECRET\n- [ ] SKIP_TASK_SECRET\n");
  fs.mkdirSync(path.join(outside, "box"));
  fs.writeFileSync(path.join(outside, "box", "x.md"), "SKIP_DIR_SECRET\n");
  fs.writeFileSync(path.join(vault, "notes", "real.md"), "kept note\n");
  fs.writeFileSync(path.join(vault, "log", "2026-01-05.md"), "- [ ] kept task\n");
  fs.writeFileSync(path.join(vault, "aidanos", "weeks", "2026-01-05.md"), "# week\n");
  fs.symlinkSync(path.join(outside, "secret.md"), path.join(vault, "notes", "alias.md"));
  fs.symlinkSync(path.join(outside, "secret.md"), path.join(vault, "notes", "line\nbreak\u007f.md"));
  fs.symlinkSync(path.join(outside, "box"), path.join(vault, "notes", "gone"));
  fs.symlinkSync(outside, path.join(vault, "extra"));
  fs.symlinkSync(path.join(outside, "day.md"), path.join(vault, "log", "2026-01-06.md"));
  fs.symlinkSync(path.join(outside, "box"), path.join(vault, "log", "box"));
  fs.symlinkSync(path.join(outside, "secret.md"), path.join(vault, "aidanos", "active-horse.md"));
  fs.symlinkSync(path.join(outside, "secret.md"), path.join(vault, "aidanos", "skin.css"));
  const port = 38200 + Math.floor(Math.random() * 200);
  const child = spawnServer({
    PORT: String(port),
    AIDANOS_HOST: "127.0.0.1",
    AIDANOS_VAULT: vault,
    AIDANOS_VAULT_GIT_URL: "",
    AIDANOS_VAULT_GIT_TOKEN: "",
    GITHUB_TOKEN: "",
  });
  const base = "http://127.0.0.1:" + port;
  const secrets = ["SKIP_FILE_SECRET", "SKIP_DAY_SECRET", "SKIP_TASK_SECRET", "SKIP_DIR_SECRET"];
  function noSecrets(text, label) {
    for (const secret of secrets) assert(!text.includes(secret), label + " included " + secret);
    assert(!text.includes(outside) && !text.includes(tmp), label + " included a full path");
  }
  try {
    await waitHealth(base, child);
    const search = await fetch(base + "/api/search?q=" + encodeURIComponent("kept"));
    const searchText = await search.text();
    const searchBody = JSON.parse(searchText);
    assert(search.status === 200 && searchBody.hits.some((hit) => hit.path === "notes/real.md"), "search dropped the real note");
    assert(searchBody.skippedLinks.includes("notes/alias.md"), "search did not report the file link");
    assert(searchBody.skippedLinks.includes("notes/gone"), "search did not report the folder link");
    noSecrets(searchText, "search");
    const folders = await fetch(base + "/api/folders");
    const folderText = await folders.text();
    const folderBody = JSON.parse(folderText);
    assert(folders.status === 200, "folders failed");
    assert(folderBody.folders.some((item) => item.name === "notes"), "folders dropped notes");
    assert(!folderBody.folders.some((item) => item.name === "extra"), "folders followed extra");
    assert(folderBody.skippedLinks.includes("extra"), "folders did not report extra");
    noSecrets(folderText, "folders");
    const tree = await fetch(base + "/api/tree?dir=" + encodeURIComponent("notes"));
    const treeText = await tree.text();
    const treeBody = JSON.parse(treeText);
    assert(tree.status === 200 && treeBody.files.includes("notes/real.md"), "tree dropped the real note");
    assert(treeBody.skippedLinks.includes("notes/alias.md") && treeBody.skippedLinks.includes("notes/gone"), "tree did not report both links");
    noSecrets(treeText, "tree");
    const week = await fetch(base + "/api/week?start=2026-01-05");
    const weekText = await week.text();
    const weekBody = JSON.parse(weekText);
    assert(week.status === 200 && weekBody.exists === true, "week failed");
    assert(weekBody.skippedLinks.includes("log/2026-01-06.md"), "week did not report the day link");
    assert(weekBody.skippedLinks.includes("log/box"), "week did not report the log folder link");
    noSecrets(weekText, "week");
    const month = await fetch(base + "/api/month?date=2026-01-05");
    const monthText = await month.text();
    const monthBody = JSON.parse(monthText);
    assert(month.status === 200 && monthBody.days.includes("2026-01-05"), "month dropped the real day");
    assert(!monthBody.days.includes("2026-01-06"), "month followed the day link");
    assert(monthBody.skippedLinks.includes("log/2026-01-06.md"), "month did not report the day link");
    noSecrets(monthText, "month");
    const tasks = await fetch(base + "/api/open-tasks");
    const taskText = await tasks.text();
    const taskBody = JSON.parse(taskText);
    assert(tasks.status === 200 && taskBody.items.some((item) => item.text === "kept task"), "open tasks dropped the real task");
    assert(taskBody.skippedLinks.includes("log/2026-01-06.md"), "open tasks did not report the day link");
    noSecrets(taskText, "open tasks");
    const plan = await fetch(base + "/api/plan");
    const planText = await plan.text();
    const planBody = JSON.parse(planText);
    assert(plan.status === 200 && planBody.exists === false, "plan followed the link");
    assert(planBody.skippedLinks.includes("aidanos/active-horse.md"), "plan did not report the link");
    noSecrets(planText, "plan");
    const skin = await fetch(base + "/api/skin.css");
    const skinText = await skin.text();
    assert(skin.status === 200 && skinText.includes("no personal skin"), "skin followed the link");
    assert(String(skin.headers.get("x-skipped-links") || "").includes("aidanos/skin.css"), "skin header did not name the link");
    noSecrets(skinText + String(skin.headers.get("x-skipped-links") || ""), "skin");
    const direct = await fetch(base + "/api/file?path=" + encodeURIComponent("notes/alias.md"));
    const directText = await direct.text();
    assert(direct.status === 400, "direct read of a link got " + direct.status);
    noSecrets(directText, "direct");
    const weird = await fetch(base + "/api/file?path=" + encodeURIComponent("notes/line\nbreak\u007f.md"));
    const weirdText = await weird.text();
    assert(weird.status === 400, "direct read of a broken name got " + weird.status);
    noSecrets(weirdText, "broken name");
    const logged = child._log();
    assert(!logged.includes("line\nbreak"), "a note name split a log line");
    assert(logged.includes("notes/line?break?.md"), "control characters stayed in a log line");
    const skipLines = logged.split("\n").filter((line) => line.includes("skipped symlink:"));
    assert(skipLines.length > 0, "skips were not logged");
    for (const line of skipLines) {
      assert(!line.includes(outside) && !line.includes(vault) && !line.includes(tmp), "skip log included a full path: " + line);
    }
    const health = await fetch(base + "/api/health");
    assert(health.status === 200 && child.exitCode == null, "server stopped after skip-and-report");
  } finally {
    await stop(child);
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

async function parentSymlinkIsNotFollowed() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "aidanos-race-"));
  const vault = path.join(tmp, "vault");
  const outside = path.join(tmp, "outside");
  fs.mkdirSync(vault);
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, "marker.md"), "unchanged\n");
  fs.symlinkSync(outside, path.join(vault, "linked"));
  const port = 38400 + Math.floor(Math.random() * 200);
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
    const res = await fetch(base + "/api/file?path=" + encodeURIComponent("linked/note.md"), {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ markdown: "pwned\n" }),
    });
    const text = await res.text();
    assert(res.status === 400, "write through a linked parent got " + res.status + " " + text);
    assert(!text.includes(outside), "refusal included the outside path");
    assert(fs.readdirSync(outside).join(",") === "marker.md", "mkdir followed the linked parent");
    assert(fs.readFileSync(path.join(outside, "marker.md"), "utf8") === "unchanged\n", "outside file changed");
    const health = await fetch(base + "/api/health");
    assert(health.status === 200 && child.exitCode == null, "server stopped after the linked parent");
  } finally {
    await stop(child);
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

async function pngDirectoryDoesNotStop() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "aidanos-pngdir-"));
  const vault = path.join(tmp, "vault");
  fs.mkdirSync(vault);
  const port = 38600 + Math.floor(Math.random() * 200);
  const child = spawnServer({
    PORT: String(port),
    AIDANOS_HOST: "127.0.0.1",
    AIDANOS_VAULT: vault,
    AIDANOS_VAULT_GIT_URL: "",
    AIDANOS_VAULT_GIT_TOKEN: "",
    GITHUB_TOKEN: "",
  });
  const base = "http://127.0.0.1:" + port;
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);
  try {
    await waitHealth(base, child);
    const nested = await fetch(base + "/api/file?path=" + encodeURIComponent("family-room-to-office/plan.png/x.md"), {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ markdown: "nope\n" }),
    });
    const nestedText = await nested.text();
    assert(nested.status === 400, "note inside plan.png got " + nested.status + " " + nestedText);
    const planDir = path.join(vault, "family-room-to-office", "plan.png");
    assert(!fs.existsSync(planDir), "a note created a plan.png folder");
    fs.mkdirSync(planDir, { recursive: true });
    const put = await fetch(base + "/api/file?path=" + encodeURIComponent("family-room-to-office/plan.png"), {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ png: png.toString("base64") }),
    });
    const putText = await put.text();
    assert(put.status === 400, "png onto a folder got " + put.status + " " + putText);
    assert(putText === JSON.stringify({ error: "not a file" }), "png onto a folder said " + putText);
    assert(fs.lstatSync(planDir).isDirectory(), "png save replaced the folder");
    assert(child.exitCode == null, "png onto a folder exited");
    assert(!child._log().includes("stopped:"), "png onto a folder stopped: " + child._log());
    const health = await fetch(base + "/api/health");
    assert(health.status === 200, "health failed after a png folder");
  } finally {
    await stop(child);
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

async function pauseClearsOnlyAfterSuccess() {
  if (runningAsRoot()) {
    console.log("skip permission test as root");
    return;
  }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "aidanos-resume-"));
  const vault = path.join(tmp, "vault");
  const bare = path.join(tmp, "bare.git");
  fs.mkdirSync(vault);
  gitQuiet(tmp, ["init", "--bare", "-b", "main", bare]);
  gitQuiet(tmp, ["init", "-b", "main", vault]);
  gitQuiet(vault, ["config", "user.email", "t@local"]);
  gitQuiet(vault, ["config", "user.name", "t"]);
  fs.writeFileSync(path.join(vault, "README.md"), "vault\n");
  gitQuiet(vault, ["add", "README.md"]);
  gitQuiet(vault, ["commit", "-m", "init"]);
  gitQuiet(vault, ["remote", "add", "origin", bare]);
  gitQuiet(vault, ["push", "-u", "origin", "HEAD"]);
  const port = 38800 + Math.floor(Math.random() * 200);
  const child = spawnServer({
    PORT: String(port),
    AIDANOS_HOST: "127.0.0.1",
    AIDANOS_VAULT: vault,
    AIDANOS_VAULT_GIT_URL: bare,
    AIDANOS_VAULT_GIT_TOKEN: "",
    GITHUB_TOKEN: "",
    AIDANOS_VAULT_GIT_SYNC_MS: "400",
    AIDANOS_VAULT_GIT_DEBOUNCE_MS: "200",
  });
  const base = "http://127.0.0.1:" + port;
  const localOnly = "Sync is paused. Notes are saved on this computer only.";
  function showBare(rel) {
    try {
      return gitQuiet(bare, ["show", "HEAD:" + rel]);
    } catch {
      return null;
    }
  }
  async function pauseWithChmod() {
    const loggedBefore = child._log().length;
    fs.chmodSync(vault, 0);
    const deadline = Date.now() + 4000;
    let logged = "";
    while (Date.now() < deadline) {
      logged = child._log().slice(loggedBefore);
      if (logged.includes("sync paused:")) break;
      await new Promise((r) => setTimeout(r, 40));
    }
    fs.chmodSync(vault, 0o755);
    assert(child.exitCode == null, "pause exited the server");
    assert(logged.includes("sync paused:"), "sync did not pause: " + logged);
  }
  async function putNote(rel, markdown) {
    const res = await fetch(base + "/api/file?path=" + encodeURIComponent(rel), {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ markdown }),
    });
    const body = await res.json();
    return { status: res.status, body };
  }
  async function postSync() {
    const res = await fetch(base + "/api/sync", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ join: true }),
    });
    const text = await res.text();
    let body = {};
    try { body = JSON.parse(text); } catch { body = { raw: text }; }
    return { status: res.status, body, text };
  }
  try {
    await waitHealth(base, child);
    await pauseWithChmod();
    const idle = await postSync();
    assert(idle.status === 200, "idle sync got " + idle.status + " " + idle.text);
    assert(idle.body.error !== "sync paused", "idle sync left the warning: " + idle.text);
    const cleared = await fetch(base + "/api/health");
    const clearedBody = await cleared.json();
    assert(cleared.status === 200, "health failed after an idle sync");
    assert(!clearedBody.git.paused && clearedBody.git.error !== "sync paused" && !clearedBody.git.localOnly, "idle sync left the pause: " + JSON.stringify(clearedBody.git));
    const timed = await putNote("notes/timer.md", "timer note\n");
    assert(timed.status === 200, "save after resume got " + timed.status);
    assert(timed.body.git && timed.body.git.error !== "sync paused" && !timed.body.git.localOnly, "save after resume still said paused");
    const timerDeadline = Date.now() + 8000;
    while (showBare("notes/timer.md") !== "timer note\n" && Date.now() < timerDeadline) {
      await new Promise((r) => setTimeout(r, 50));
    }
    assert(showBare("notes/timer.md") === "timer note\n", "restarted timers did not sync the note");

    await pauseWithChmod();
    const queued = await putNote("notes/queued.md", "queued note\n");
    assert(queued.status === 200, "paused save got " + queued.status);
    assert(queued.body.git && queued.body.git.error === "sync paused", "paused save dropped the warning");
    assert(queued.body.git.localOnly === localOnly, "paused save did not say it is local only");
    const pausedHealth = await fetch(base + "/api/health");
    const pausedBody = await pausedHealth.json();
    assert(pausedBody.git && pausedBody.git.error === "sync paused" && pausedBody.git.paused === true, "health hid the pause");
    assert(pausedBody.git.localOnly === localOnly, "health did not say notes stay on this computer");
    const pending = fs.readFileSync(path.join(vault, ".git", "aidanos-pending"), "utf8");
    assert(pending.includes("notes/queued.md"), "paused save was not queued");
    await new Promise((r) => setTimeout(r, 500));
    assert(showBare("notes/queued.md") == null, "a paused save synced on its own");
    const resumed = await postSync();
    assert(resumed.status === 200, "resume sync got " + resumed.status + " " + resumed.text);
    assert(resumed.body.error !== "sync paused", "resume sync left the warning");
    const queuedDeadline = Date.now() + 8000;
    while (showBare("notes/queued.md") !== "queued note\n" && Date.now() < queuedDeadline) {
      await new Promise((r) => setTimeout(r, 50));
    }
    assert(showBare("notes/queued.md") === "queued note\n", "queued note did not sync after resume");
    const open = await fetch(base + "/api/health");
    const openBody = await open.json();
    assert(!openBody.git.paused && openBody.git.error !== "sync paused", "resume left the pause on");

    await pauseWithChmod();
    const stuck = await putNote("notes/stuck.md", "stuck note\n");
    assert(stuck.status === 200 && stuck.body.git && stuck.body.git.error === "sync paused", "second pause did not warn");
    gitQuiet(vault, ["remote", "set-url", "origin", path.join(tmp, "missing")]);
    const failed = await postSync();
    assert(failed.status === 409, "failed sync got " + failed.status + " " + failed.text);
    assert(failed.body.error === "sync paused", "failed sync cleared the warning: " + failed.text);
    const still = await fetch(base + "/api/health");
    const stillBody = await still.json();
    assert(still.status === 200, "health failed after a failed sync");
    assert(stillBody.git && stillBody.git.paused === true && stillBody.git.error === "sync paused", "failed sync cleared the pause");
    assert(stillBody.git.localOnly === localOnly, "failed sync dropped the local-only sentence");
    await new Promise((r) => setTimeout(r, 500));
    const later = await fetch(base + "/api/health");
    const laterBody = await later.json();
    assert(laterBody.git && laterBody.git.paused === true && laterBody.git.error === "sync paused", "the pause cleared itself");
    assert(showBare("notes/stuck.md") == null, "a failed sync pushed the paused note");
    assert(child.exitCode == null, "failed sync exited the server");
  } finally {
    try { fs.chmodSync(vault, 0o755); } catch {}
    await stop(child);
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

function containsBytes(dir, needle) {
  if (!fs.existsSync(dir)) return false;
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name);
    const st = fs.lstatSync(p);
    if (st.isSymbolicLink()) continue;
    if (st.isDirectory()) {
      if (containsBytes(p, needle)) return true;
      continue;
    }
    if (st.isFile() && fs.readFileSync(p).includes(needle)) return true;
  }
  return false;
}

async function swappedParentWritesNothing() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "aidanos-swap-"));
  const vault = path.join(tmp, "vault");
  const outside = path.join(tmp, "outside");
  const hold = path.join(tmp, "hold");
  const real = path.join(tmp, "notes-real");
  fs.mkdirSync(path.join(vault, "notes"), { recursive: true });
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, "marker.md"), "unchanged\n");
  const port = 39000 + Math.floor(Math.random() * 200);
  const note = Buffer.from("0123456789abcd");
  assert(note.length === 14, "note is not 14 bytes");
  const child = spawnServer({
    PORT: String(port),
    AIDANOS_HOST: "127.0.0.1",
    AIDANOS_VAULT: vault,
    AIDANOS_VAULT_GIT_URL: "",
    AIDANOS_VAULT_GIT_TOKEN: "",
    GITHUB_TOKEN: "",
    NODE_ENV: "test",
    AIDANOS_TEST_HOLD_WRITE: hold,
  });
  const base = "http://127.0.0.1:" + port;
  try {
    await waitHealth(base, child);
    const put = fetch(base + "/api/file?path=" + encodeURIComponent("notes/out.md"), {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ markdown: note.toString("utf8") }),
    });
    const holdFile = path.join(hold, "hold");
    const deadline = Date.now() + 4000;
    while (!fs.existsSync(holdFile) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 20));
    }
    assert(fs.existsSync(holdFile), "save did not stop before the open");
    fs.renameSync(path.join(vault, "notes"), real);
    fs.symlinkSync(outside, path.join(vault, "notes"));
    fs.writeFileSync(path.join(hold, "go"), "1");
    let status = 0;
    let text = "";
    try {
      const res = await put;
      status = res.status;
      text = await res.text();
    } catch (e) {
      text = String(e && e.message || e);
    }
    await waitExit(child, 4000);
    assert(child.exitCode != null, "swapped parent left the server up");
    if (status) assert(status === 500, "swapped parent got " + status + " " + text);
    assert(child._log().includes("stopped: write PARENT"), "swapped parent log was " + child._log());
    assert(!containsBytes(outside, note), "swapped parent wrote the note outside the vault");
    assert(!containsBytes(real, note), "swapped parent wrote the note into the old folder");
    assert(fs.readFileSync(path.join(outside, "marker.md"), "utf8") === "unchanged\n", "outside file changed");
    assert(fs.readdirSync(outside).join(",") === "marker.md", "a temp file was left outside: " + fs.readdirSync(outside).join(","));
  } finally {
    await stop(child);
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

async function folderTargetsStayUp() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "aidanos-folder-"));
  const vault = path.join(tmp, "vault");
  const dayDir = path.join(vault, "log", "2026-04-02.md");
  const noteDir = path.join(vault, "notes", "page.md");
  const pngDir = path.join(vault, "family-room-to-office", "plan.png");
  fs.mkdirSync(dayDir, { recursive: true });
  fs.mkdirSync(noteDir, { recursive: true });
  fs.mkdirSync(pngDir, { recursive: true });
  const port = 39200 + Math.floor(Math.random() * 200);
  const child = spawnServer({
    PORT: String(port),
    AIDANOS_HOST: "127.0.0.1",
    AIDANOS_VAULT: vault,
    AIDANOS_VAULT_GIT_URL: "",
    AIDANOS_VAULT_GIT_TOKEN: "",
    GITHUB_TOKEN: "",
  });
  const base = "http://127.0.0.1:" + port;
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);
  async function put(url, body) {
    const res = await fetch(base + url, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    assert(res.status === 400, url + " got " + res.status + " " + text);
    assert(text === JSON.stringify({ error: "not a file" }), url + " said " + text);
  }
  try {
    await waitHealth(base, child);
    await put("/api/day?date=2026-04-02", { markdown: "DAY_FOLDER_SECRET\n" });
    await put("/api/file?path=" + encodeURIComponent("notes/page.md"), { markdown: "NOTE_FOLDER_SECRET\n" });
    await put("/api/file?path=" + encodeURIComponent("family-room-to-office/plan.png"), { png: png.toString("base64") });
    assert(fs.lstatSync(dayDir).isDirectory(), "day save replaced the folder");
    assert(fs.lstatSync(noteDir).isDirectory(), "note save replaced the folder");
    assert(fs.lstatSync(pngDir).isDirectory(), "png save replaced the folder");
    assert(!containsBytes(vault, Buffer.from("DAY_FOLDER_SECRET")), "day folder stored the note");
    assert(!containsBytes(vault, Buffer.from("NOTE_FOLDER_SECRET")), "note folder stored the note");
    assert(child.exitCode == null, "a folder target exited the server");
    assert(!child._log().includes("stopped:"), "a folder target stopped: " + child._log());
    const health = await fetch(base + "/api/health");
    assert(health.status === 200, "health failed after a folder target");
  } finally {
    await stop(child);
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

async function folderAppearsDuringWriteStops() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "aidanos-midwrite-"));
  const vault = path.join(tmp, "vault");
  const hold = path.join(tmp, "hold");
  const dayDir = path.join(vault, "log", "2026-04-03.md");
  fs.mkdirSync(path.join(vault, "log"), { recursive: true });
  const port = 39100 + Math.floor(Math.random() * 100);
  const child = spawnServer({
    PORT: String(port),
    AIDANOS_HOST: "127.0.0.1",
    AIDANOS_VAULT: vault,
    AIDANOS_VAULT_GIT_URL: "",
    AIDANOS_VAULT_GIT_TOKEN: "",
    GITHUB_TOKEN: "",
    NODE_ENV: "test",
    AIDANOS_TEST_HOLD_RENAME: hold,
  });
  const base = "http://127.0.0.1:" + port;
  try {
    await waitHealth(base, child);
    const put = fetch(base + "/api/day?date=2026-04-03", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ markdown: "DURING_FOLDER_SECRET\n" }),
    });
    const holdFile = path.join(hold, "hold");
    const deadline = Date.now() + 4000;
    while (!fs.existsSync(holdFile) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 20));
    }
    assert(fs.existsSync(holdFile), "save did not stop before rename");
    fs.mkdirSync(dayDir);
    fs.writeFileSync(path.join(hold, "go"), "1");
    let status = 0;
    let text = "";
    try {
      const res = await put;
      status = res.status;
      text = await res.text();
    } catch (e) {
      text = String(e && e.message || e);
    }
    await waitExit(child, 4000);
    assert(child.exitCode != null, "a folder that appeared during the write left the server up");
    if (status) {
      assert(status === 500, "a mid-write folder got " + status + " " + text);
      assert(!text.includes("DURING_FOLDER_SECRET"), "a mid-write folder leaked the note");
    }
    assert(child._log().includes("stopped: rename EISDIR"), "mid-write folder log was " + child._log());
    assert(fs.lstatSync(dayDir).isDirectory(), "mid-write folder was replaced");
    assert(!containsBytes(vault, Buffer.from("DURING_FOLDER_SECRET")), "mid-write folder stored the note");
  } finally {
    await stop(child);
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

async function renameFailureStops() {
  if (runningAsRoot()) {
    console.log("skip permission test as root");
    return;
  }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "aidanos-rename-"));
  const vault = path.join(tmp, "vault");
  const notes = path.join(vault, "notes");
  const hold = path.join(tmp, "hold");
  fs.mkdirSync(notes, { recursive: true });
  fs.writeFileSync(path.join(notes, "page.md"), "old\n");
  const port = 39300 + Math.floor(Math.random() * 100);
  const child = spawnServer({
    PORT: String(port),
    AIDANOS_HOST: "127.0.0.1",
    AIDANOS_VAULT: vault,
    AIDANOS_VAULT_GIT_URL: "",
    AIDANOS_VAULT_GIT_TOKEN: "",
    GITHUB_TOKEN: "",
    NODE_ENV: "test",
    AIDANOS_TEST_HOLD_RENAME: hold,
  });
  const base = "http://127.0.0.1:" + port;
  try {
    await waitHealth(base, child);
    const put = fetch(base + "/api/file?path=" + encodeURIComponent("notes/page.md"), {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ markdown: "RENAME_SECRET\n" }),
    });
    const holdFile = path.join(hold, "hold");
    const deadline = Date.now() + 4000;
    while (!fs.existsSync(holdFile) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 20));
    }
    assert(fs.existsSync(holdFile), "save did not stop before rename");
    fs.chmodSync(notes, 0o555);
    fs.writeFileSync(path.join(hold, "go"), "1");
    let status = 0;
    let text = "";
    try {
      const res = await put;
      status = res.status;
      text = await res.text();
    } catch (e) {
      text = String(e && e.message || e);
    }
    await waitExit(child, 4000);
    fs.chmodSync(notes, 0o755);
    assert(child.exitCode != null, "rename EACCES left the server up");
    if (status) {
      assert(status === 500, "rename EACCES got " + status + " " + text);
      assert(!text.includes("RENAME_SECRET"), "rename EACCES leaked the note");
    }
    assert(child._log().includes("stopped: rename EACCES"), "rename failure log was " + child._log());
    assert(!child._log().includes("RENAME_SECRET"), "rename failure logged the note");
    assert(fs.readFileSync(path.join(notes, "page.md"), "utf8") === "old\n", "rename failure replaced the note");
  } finally {
    try { fs.chmodSync(notes, 0o755); } catch {}
    await stop(child);
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

async function ownGitConfigIsLeftAlone() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "aidanos-ownkeys-"));
  const vault = path.join(tmp, "vault");
  const bare = path.join(tmp, "bare.git");
  const ownHooks = path.join(tmp, "my-hooks");
  fs.mkdirSync(vault);
  gitQuiet(tmp, ["init", "--bare", "-b", "main", bare]);
  gitQuiet(tmp, ["init", "-b", "main", vault]);
  gitQuiet(vault, ["config", "user.email", "t@local"]);
  gitQuiet(vault, ["config", "user.name", "t"]);
  fs.writeFileSync(path.join(vault, "README.md"), "vault\n");
  gitQuiet(vault, ["add", "README.md"]);
  gitQuiet(vault, ["commit", "-m", "init"]);
  gitQuiet(vault, ["remote", "add", "origin", bare]);
  gitQuiet(vault, ["push", "-u", "origin", "HEAD"]);
  gitQuiet(vault, ["config", "core.symlinks", "false"]);
  gitQuiet(vault, ["config", "core.fsmonitor", "false"]);
  gitQuiet(vault, ["config", "protocol.allow", "never"]);
  gitQuiet(vault, ["config", "core.hooksPath", ownHooks]);
  gitQuiet(vault, ["config", "credential.helper", "SECRET_HELPER_VALUE"]);
  const port = 39500 + Math.floor(Math.random() * 100);
  const child = spawnServer({
    PORT: String(port),
    AIDANOS_HOST: "127.0.0.1",
    AIDANOS_VAULT: vault,
    AIDANOS_VAULT_GIT_URL: bare,
    AIDANOS_VAULT_GIT_TOKEN: "",
    GITHUB_TOKEN: "",
    AIDANOS_VAULT_GIT_SYNC_MS: "0",
  });
  const base = "http://127.0.0.1:" + port;
  try {
    await waitHealth(base, child);
    const deadline = Date.now() + 4000;
    while (Date.now() < deadline && !child._log().includes("vault git config:")) {
      await new Promise((r) => setTimeout(r, 40));
    }
    assert(child._log().includes("credential.helper"), "startup did not finish reading git config");
    assert(!child._log().includes("SECRET_HELPER_VALUE"), "git config warning included a value");
    assert(localConfig(vault, "core.symlinks") === "false", "own core.symlinks was removed");
    assert(localConfig(vault, "core.fsmonitor") === "false", "own core.fsmonitor was removed");
    assert(localConfig(vault, "protocol.allow") === "never", "own protocol.allow was removed");
    assert(localConfig(vault, "core.hooksPath") === ownHooks, "own hooksPath was removed");
    assert(child.exitCode == null, "own git config refused startup");
  } finally {
    await stop(child);
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

async function oldSafetyKeysAreRemoved() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "aidanos-oldkeys-"));
  const vault = path.join(tmp, "vault");
  const bare = path.join(tmp, "bare.git");
  fs.mkdirSync(vault);
  gitQuiet(tmp, ["init", "--bare", "-b", "main", bare]);
  gitQuiet(tmp, ["init", "-b", "main", vault]);
  gitQuiet(vault, ["config", "user.email", "t@local"]);
  gitQuiet(vault, ["config", "user.name", "t"]);
  fs.writeFileSync(path.join(vault, "README.md"), "vault\n");
  gitQuiet(vault, ["add", "README.md"]);
  gitQuiet(vault, ["commit", "-m", "init"]);
  gitQuiet(vault, ["remote", "add", "origin", bare]);
  gitQuiet(vault, ["push", "-u", "origin", "HEAD"]);
  const hooks = path.join(vault, ".git", "aidanos-no-hooks");
  gitQuiet(vault, ["config", "core.symlinks", "false"]);
  gitQuiet(vault, ["config", "core.hooksPath", hooks]);
  gitQuiet(vault, ["config", "core.fsmonitor", "false"]);
  gitQuiet(vault, ["config", "protocol.allow", "never"]);
  gitQuiet(vault, ["config", "protocol.https.allow", "always"]);
  gitQuiet(vault, ["config", "protocol.file.allow", "always"]);
  gitQuiet(vault, ["config", "protocol.ssh.allow", "never"]);
  gitQuiet(vault, ["config", "core.editor", "vim"]);
  gitQuiet(vault, ["config", "credential.helper", "SECRET_HELPER_VALUE"]);
  gitQuiet(vault, ["config", "http.extraheader", "SECRET_HEADER_VALUE"]);
  const port = 39400 + Math.floor(Math.random() * 200);
  const child = spawnServer({
    PORT: String(port),
    AIDANOS_HOST: "127.0.0.1",
    AIDANOS_VAULT: vault,
    AIDANOS_VAULT_GIT_URL: bare,
    AIDANOS_VAULT_GIT_TOKEN: "",
    GITHUB_TOKEN: "",
    AIDANOS_VAULT_GIT_SYNC_MS: "0",
  });
  const base = "http://127.0.0.1:" + port;
  try {
    await waitHealth(base, child);
    const deadline = Date.now() + 4000;
    while (Date.now() < deadline && (localConfig(vault, "core.symlinks") !== "" || localConfig(vault, "core.hooksPath") !== "")) {
      await new Promise((r) => setTimeout(r, 40));
    }
    assert(localConfig(vault, "core.symlinks") === "", "core.symlinks was left in the repo");
    assert(localConfig(vault, "core.hooksPath") === "", "hooksPath was left in the repo");
    assert(localConfig(vault, "core.fsmonitor") === "", "fsmonitor was left in the repo");
    assert(localConfig(vault, "protocol.allow") === "", "protocol.allow was left in the repo");
    assert(localConfig(vault, "protocol.https.allow") === "", "protocol.https.allow was left in the repo");
    assert(localConfig(vault, "protocol.file.allow") === "", "protocol.file.allow was left in the repo");
    assert(localConfig(vault, "protocol.ssh.allow") === "never", "a different protocol value was removed");
    assert(localConfig(vault, "core.editor") === "vim", "an unrelated git setting was removed");
    assert(localConfig(vault, "user.name") !== "", "git identity was removed");
    assert(!fs.existsSync(hooks), "hooks directory was created");
    const warnDeadline = Date.now() + 4000;
    while (Date.now() < warnDeadline && !child._log().includes("vault git config:")) {
      await new Promise((r) => setTimeout(r, 40));
    }
    const logged = child._log();
    assert(logged.includes("vault git config: "), "risky git keys were not named");
    assert(logged.includes("credential.helper") && logged.includes("http.extraheader"), "risky git keys were missing: " + logged);
    assert(!logged.includes("SECRET_HELPER_VALUE") && !logged.includes("SECRET_HEADER_VALUE"), "git config warning included a value");
    assert(child.exitCode == null, "a risky git key refused startup");
  } finally {
    await stop(child);
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

async function pausedSentenceFor(vault, bare, extra) {
  const port = 39600 + Math.floor(Math.random() * 200);
  const child = spawnServer({
    PORT: String(port),
    AIDANOS_HOST: "127.0.0.1",
    AIDANOS_VAULT: vault,
    AIDANOS_VAULT_GIT_URL: bare,
    AIDANOS_VAULT_GIT_TOKEN: "",
    GITHUB_TOKEN: "",
    AIDANOS_VAULT_GIT_SYNC_MS: "400",
    K_SERVICE: "",
    ...extra,
  });
  const base = "http://127.0.0.1:" + port;
  try {
    await waitHealth(base, child);
    const loggedBefore = child._log().length;
    fs.chmodSync(vault, 0);
    const deadline = Date.now() + 4000;
    let logged = "";
    while (Date.now() < deadline) {
      logged = child._log().slice(loggedBefore);
      if (logged.includes("sync paused:")) break;
      await new Promise((r) => setTimeout(r, 40));
    }
    fs.chmodSync(vault, 0o755);
    assert(child.exitCode == null, "pause exited the server");
    assert(logged.includes("sync paused:"), "sync did not pause: " + logged);
    const health = await fetch(base + "/api/health");
    const body = await health.json();
    assert(health.status === 200 && body.git && body.git.error === "sync paused", "health did not mark the pause");
    return body.git.localOnly;
  } finally {
    try { fs.chmodSync(vault, 0o755); } catch {}
    await stop(child);
  }
}

async function pausedWordingFollowsTheVault() {
  if (runningAsRoot()) {
    console.log("skip permission test as root");
    return;
  }
  const serverSentence = "Sync is paused. Notes are saved on this server only and may be lost if it restarts.";
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "aidanos-wording-"));
  try {
    const cloudVault = path.join(tmp, "cloud");
    const cloudBare = path.join(tmp, "cloud.git");
    fs.mkdirSync(cloudVault);
    gitQuiet(tmp, ["init", "--bare", "-b", "main", cloudBare]);
    gitQuiet(tmp, ["init", "-b", "main", cloudVault]);
    gitQuiet(cloudVault, ["config", "user.email", "t@local"]);
    gitQuiet(cloudVault, ["config", "user.name", "t"]);
    fs.writeFileSync(path.join(cloudVault, "README.md"), "vault\n");
    gitQuiet(cloudVault, ["add", "README.md"]);
    gitQuiet(cloudVault, ["commit", "-m", "init"]);
    gitQuiet(cloudVault, ["remote", "add", "origin", cloudBare]);
    gitQuiet(cloudVault, ["push", "-u", "origin", "HEAD"]);
    const cloud = await pausedSentenceFor(cloudVault, cloudBare, { K_SERVICE: "aidanos" });
    assert(cloud === serverSentence, "Cloud Run pause said " + cloud);

    const cloneVault = path.join(tmp, "clone");
    const cloneBare = path.join(tmp, "clone.git");
    fs.mkdirSync(cloneVault);
    gitQuiet(tmp, ["init", "--bare", "-b", "main", cloneBare]);
    gitQuiet(tmp, ["init", "-b", "main", cloneVault]);
    gitQuiet(cloneVault, ["config", "user.email", "t@local"]);
    gitQuiet(cloneVault, ["config", "user.name", "t"]);
    fs.writeFileSync(path.join(cloneVault, "README.md"), "vault\n");
    gitQuiet(cloneVault, ["add", "README.md"]);
    gitQuiet(cloneVault, ["commit", "-m", "init"]);
    gitQuiet(cloneVault, ["remote", "add", "origin", cloneBare]);
    gitQuiet(cloneVault, ["push", "-u", "origin", "HEAD"]);
    const clone = await pausedSentenceFor(cloneVault, cloneBare, {
      AIDANOS_VAULT: "",
      AIDANOS_VAULT_CLONE: cloneVault,
    });
    assert(clone === serverSentence, "temp clone pause said " + clone);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

function childEnv(port, vault, extra) {
  return {
    PORT: String(port),
    AIDANOS_HOST: "127.0.0.1",
    AIDANOS_VAULT: vault,
    AIDANOS_VAULT_GIT_URL: "",
    AIDANOS_VAULT_GIT_TOKEN: "",
    GITHUB_TOKEN: "",
    AIDANOS_SAVE_SWAP_IN: "1",
    AIDANOS_VAULT_KIND: "",
    ...extra,
  };
}

async function putMarkdown(base, url, markdown) {
  const res = await fetch(base + url, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ markdown }),
  });
  const text = await res.text();
  let body = null;
  try { body = JSON.parse(text); } catch { body = null; }
  return { status: res.status, text, body };
}

async function refusedSavesStayUp(kind) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "aidanos-refuse-" + (kind || "swap") + "-"));
  const vault = path.join(tmp, "vault");
  const outside = path.join(tmp, "outside");
  fs.mkdirSync(path.join(vault, "notes"), { recursive: true });
  fs.mkdirSync(path.join(vault, "log"), { recursive: true });
  fs.mkdirSync(outside);
  const note = path.join(vault, "notes", "page.md");
  fs.writeFileSync(note, "original text\n");
  const inode = fs.statSync(note).ino;
  fs.writeFileSync(path.join(outside, "secret.md"), "kept-outside\n");
  fs.symlinkSync(path.join(outside, "secret.md"), path.join(vault, "notes", "alias.md"));
  fs.writeFileSync(path.join(outside, "hard.md"), "kept-hard\n");
  fs.linkSync(path.join(outside, "hard.md"), path.join(vault, "notes", "hard.md"));
  execFileSync("mkfifo", [path.join(vault, "notes", "pipe.md")]);
  execFileSync("mkfifo", [path.join(vault, "log", "2026-04-04.md")]);
  fs.mkdirSync(path.join(vault, "notes", "folder.md"));
  fs.mkdirSync(path.join(vault, "log", "2026-04-05.md"));
  const port = 39500 + Math.floor(Math.random() * 200);
  const child = spawnServer(childEnv(port, vault, kind ? { AIDANOS_VAULT_KIND: kind } : {}));
  const base = "http://127.0.0.1:" + port;
  const label = kind || "swap-in";
  try {
    await waitHealth(base, child);
    if (kind === "noteplan") {
      const saved = await putMarkdown(base, "/api/file?path=" + encodeURIComponent("notes/page.md"), "saved text\n");
      assert(saved.status === 200, label + " save got " + saved.status + " " + saved.text);
      assert(fs.readFileSync(note, "utf8") === "saved text\n", label + " did not keep the new text");
      assert(fs.statSync(note).ino === inode, label + " replaced the note");
    }
    const link = await putMarkdown(base, "/api/file?path=" + encodeURIComponent("notes/alias.md"), "THROUGH_LINK\n");
    assert(link.status === 400, label + " link got " + link.status + " " + link.text);
    assert(link.body && String(link.body.error || "").startsWith("symlink: "), label + " link said " + link.text);
    assert(fs.readFileSync(path.join(outside, "secret.md"), "utf8") === "kept-outside\n", label + " link wrote the target");
    assert(fs.lstatSync(path.join(vault, "notes", "alias.md")).isSymbolicLink(), label + " replaced the link");
    const hard = await putMarkdown(base, "/api/file?path=" + encodeURIComponent("notes/hard.md"), "THROUGH_HARD\n");
    assert(hard.status === 400, label + " hard link got " + hard.status + " " + hard.text);
    assert(hard.body && hard.body.error === "bad path", label + " hard link said " + hard.text);
    assert(fs.readFileSync(path.join(outside, "hard.md"), "utf8") === "kept-hard\n", label + " hard link wrote the target");
    assert(fs.statSync(path.join(vault, "notes", "hard.md")).nlink > 1, label + " replaced the hard link");
    const fifo = await Promise.race([
      putMarkdown(base, "/api/file?path=" + encodeURIComponent("notes/pipe.md"), "THROUGH_FIFO\n"),
      new Promise((resolve) => setTimeout(() => resolve({ status: 0, text: "hung", body: null }), 4000)),
    ]);
    assert(fifo.status === 400, label + " fifo got " + fifo.status + " " + fifo.text);
    assert(fifo.body && fifo.body.error === "bad path", label + " fifo said " + fifo.text);
    assert(fs.lstatSync(path.join(vault, "notes", "pipe.md")).isFIFO(), label + " replaced the fifo");
    const dayFifo = await Promise.race([
      putMarkdown(base, "/api/day?date=2026-04-04", "THROUGH_DAY_FIFO\n"),
      new Promise((resolve) => setTimeout(() => resolve({ status: 0, text: "hung", body: null }), 4000)),
    ]);
    assert(dayFifo.status === 400, label + " day fifo got " + dayFifo.status + " " + dayFifo.text);
    assert(dayFifo.body && (dayFifo.body.error === "bad path" || dayFifo.body.error === "not a file"), label + " day fifo said " + dayFifo.text);
    assert(fs.lstatSync(path.join(vault, "log", "2026-04-04.md")).isFIFO(), label + " replaced the day fifo");
    const folder = await putMarkdown(base, "/api/file?path=" + encodeURIComponent("notes/folder.md"), "INTO_FOLDER\n");
    assert(folder.status === 400, label + " folder got " + folder.status + " " + folder.text);
    assert(folder.body && folder.body.error === "not a file", label + " folder said " + folder.text);
    assert(fs.lstatSync(path.join(vault, "notes", "folder.md")).isDirectory(), label + " replaced the folder");
    const dayFolder = await putMarkdown(base, "/api/day?date=2026-04-05", "INTO_DAY_FOLDER\n");
    assert(dayFolder.status === 400 && dayFolder.body && dayFolder.body.error === "not a file", label + " day folder said " + dayFolder.text);
    assert(child.exitCode == null, label + " refusal exited the server");
    assert(!child._log().includes("stopped:"), label + " refusal stopped: " + child._log());
    const health = await fetch(base + "/api/health");
    assert(health.status === 200, label + " health failed after a refusal");
    if (kind === "noteplan") assert(fs.readFileSync(note, "utf8") === "saved text\n", label + " refusal emptied the note");
  } finally {
    await stop(child);
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

async function inPlaceSwappedParentKeepsText() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "aidanos-inplace-swap-"));
  const vault = path.join(tmp, "vault");
  const outside = path.join(tmp, "outside");
  const hold = path.join(tmp, "hold");
  const real = path.join(tmp, "notes-real");
  fs.mkdirSync(path.join(vault, "notes"), { recursive: true });
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, "marker.md"), "unchanged\n");
  fs.writeFileSync(path.join(outside, "page.md"), "outside-original\n");
  const note = path.join(vault, "notes", "page.md");
  fs.writeFileSync(note, "original text\n");
  const inode = fs.statSync(note).ino;
  const port = 39720 + Math.floor(Math.random() * 80);
  const child = spawnServer(childEnv(port, vault, {
    AIDANOS_VAULT_KIND: "noteplan",
    NODE_ENV: "test",
    AIDANOS_TEST_HOLD_WRITE: hold,
  }));
  const base = "http://127.0.0.1:" + port;
  try {
    await waitHealth(base, child);
    const put = putMarkdown(base, "/api/file?path=" + encodeURIComponent("notes/page.md"), "SWAPPED_SECRET\n");
    const holdFile = path.join(hold, "hold");
    const deadline = Date.now() + 4000;
    while (!fs.existsSync(holdFile) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 20));
    }
    assert(fs.existsSync(holdFile), "in-place save did not stop before the write");
    fs.renameSync(path.join(vault, "notes"), real);
    fs.symlinkSync(outside, path.join(vault, "notes"));
    fs.writeFileSync(path.join(hold, "go"), "1");
    let status = 0;
    let text = "";
    try {
      const res = await put;
      status = res.status;
      text = res.text;
    } catch (e) {
      text = String(e && e.message || e);
    }
    await waitExit(child, 4000);
    assert(child.exitCode != null, "in-place swapped parent left the server up");
    if (status) assert(status === 500, "in-place swapped parent got " + status + " " + text);
    const log = child._log();
    assert(log.includes("stopped: write PARENT") || log.includes("stopped: write RACE"), "in-place swapped parent log was " + log);
    assert(fs.readFileSync(path.join(real, "page.md"), "utf8") === "original text\n", "in-place swapped parent changed the note");
    assert(fs.statSync(path.join(real, "page.md")).ino === inode, "in-place swapped parent replaced the note");
    assert(fs.readFileSync(path.join(outside, "page.md"), "utf8") === "outside-original\n", "in-place swapped parent wrote the outside note");
    assert(!containsBytes(outside, Buffer.from("SWAPPED_SECRET")), "in-place swapped parent wrote outside");
    assert(fs.readFileSync(path.join(outside, "marker.md"), "utf8") === "unchanged\n", "outside file changed");
  } finally {
    await stop(child);
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

async function inPlaceWriteFailureExits() {
  if (runningAsRoot()) {
    console.log("skip permission test as root");
    return;
  }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "aidanos-inplace-eacces-"));
  const vault = path.join(tmp, "vault");
  const hold = path.join(tmp, "hold");
  fs.mkdirSync(path.join(vault, "notes"), { recursive: true });
  const note = path.join(vault, "notes", "page.md");
  fs.writeFileSync(note, "original text\n");
  const port = 39820 + Math.floor(Math.random() * 80);
  const child = spawnServer(childEnv(port, vault, {
    AIDANOS_VAULT_KIND: "noteplan",
    NODE_ENV: "test",
    AIDANOS_TEST_HOLD_WRITE: hold,
  }));
  const base = "http://127.0.0.1:" + port;
  try {
    await waitHealth(base, child);
    const put = putMarkdown(base, "/api/file?path=" + encodeURIComponent("notes/page.md"), "FAILED_WRITE\n");
    const holdFile = path.join(hold, "hold");
    const deadline = Date.now() + 4000;
    while (!fs.existsSync(holdFile) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 20));
    }
    assert(fs.existsSync(holdFile), "in-place save did not stop before the write");
    fs.chmodSync(note, 0);
    fs.writeFileSync(path.join(hold, "go"), "1");
    let status = 0;
    let text = "";
    try {
      const res = await put;
      status = res.status;
      text = res.text;
    } catch (e) {
      text = String(e && e.message || e);
    }
    await waitExit(child, 4000);
    assert(child.exitCode != null, "an in-place write failure left the server up");
    if (status) assert(status === 500, "in-place write failure got " + status + " " + text);
    assert(child._log().includes("stopped: write"), "in-place write failure log was " + child._log());
    assert(!child._log().includes("THROUGH") && !String(text).includes("FAILED_WRITE"), "in-place write failure leaked the note");
    fs.chmodSync(note, 0o644);
    assert(fs.readFileSync(note, "utf8") === "original text\n", "a failed in-place write emptied the note");
  } finally {
    try { fs.chmodSync(note, 0o644); } catch {}
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
await readErrorStaysUp();
await writeErrorStops();
await nestedAndFileSymlinks();
await symlinkedVaultRootRefused();
await liveSyncDoesNotFollowOutside();
await abortAndLongNameStayUp();
await syncRequestStops();
await backgroundSyncPauses();
await bootSyncPauses();
await rejectedPushStaysUp();
await gitSafetyAndIndexLink();
await pngDirectoryDoesNotStop();
await pauseClearsOnlyAfterSuccess();
await swappedParentWritesNothing();
await folderTargetsStayUp();
await folderAppearsDuringWriteStops();
await renameFailureStops();
await ownGitConfigIsLeftAlone();
await oldSafetyKeysAreRemoved();
await pausedWordingFollowsTheVault();
await aggregateSkipsLinks();
await parentSymlinkIsNotFollowed();
async function putPng(base, rel, png) {
  const res = await fetch(base + "/api/file?path=" + encodeURIComponent(rel), {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ png }),
  });
  const text = await res.text();
  let body = null;
  try { body = JSON.parse(text); } catch { body = null; }
  return { status: res.status, text, body };
}

async function refusedPictureSavesStayUp(kind) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "aidanos-picture-" + (kind || "swap") + "-"));
  const vault = path.join(tmp, "vault");
  const room = path.join(vault, "family-room-to-office");
  fs.mkdirSync(room, { recursive: true });
  const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
  const pngBytes = Buffer.from(png, "base64");
  const other = path.join(room, "other.png");
  const plan = path.join(room, "plan.png");
  const walk = path.join(room, "walk.png");
  fs.writeFileSync(other, pngBytes);
  fs.linkSync(other, plan);
  execFileSync("mkfifo", [walk]);
  const port = 39920 + Math.floor(Math.random() * 70);
  const child = spawnServer(childEnv(port, vault, kind ? { AIDANOS_VAULT_KIND: kind } : {}));
  const base = "http://127.0.0.1:" + port;
  const label = kind || "swap-in";
  try {
    await waitHealth(base, child);
    const hard = await putPng(base, "family-room-to-office/plan.png", png);
    assert(hard.status === 400, label + " picture hard link got " + hard.status + " " + hard.text);
    assert(hard.body && hard.body.error === "bad path", label + " picture hard link said " + hard.text);
    assert(Buffer.compare(fs.readFileSync(other), pngBytes) === 0, label + " picture hard link changed the other name");
    assert(Buffer.compare(fs.readFileSync(plan), pngBytes) === 0, label + " picture hard link changed the picture name");
    assert(fs.statSync(plan).nlink > 1, label + " picture hard link was replaced");
    const fifo = await Promise.race([
      putPng(base, "family-room-to-office/walk.png", png),
      new Promise((resolve) => setTimeout(() => resolve({ status: 0, text: "hung", body: null }), 4000)),
    ]);
    assert(fifo.status === 400, label + " picture fifo got " + fifo.status + " " + fifo.text);
    assert(fifo.body && fifo.body.error === "bad path", label + " picture fifo said " + fifo.text);
    assert(fs.lstatSync(walk).isFIFO(), label + " picture fifo was replaced");
    assert(child.exitCode == null, label + " picture refusal exited the server");
    assert(!child._log().includes("stopped:"), label + " picture refusal stopped: " + child._log());
    const health = await fetch(base + "/api/health");
    assert(health.status === 200, label + " health failed after a picture refusal");
  } finally {
    await stop(child);
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

await refusedSavesStayUp("");
await refusedSavesStayUp("noteplan");
await refusedPictureSavesStayUp("");
await refusedPictureSavesStayUp("noteplan");
await inPlaceSwappedParentKeepsText();
await inPlaceWriteFailureExits();
console.log("sync-path-test ok");
