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

async function putDay(base, date, markdown, mtime, resolve) {
  let baseMtime = mtime;
  if (baseMtime == null) {
    const cur = await fetch(base + "/api/day?date=" + date);
    const json = await cur.json().catch(() => ({}));
    baseMtime = Number(json.mtime) || 0;
  }
  const payload = { date, markdown, paper: markdown, mtime: baseMtime };
  if (resolve) payload.resolve = resolve;
  const res = await fetch(base + "/api/day?date=" + date, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
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
  assert(!server.includes('"--force"') && !server.includes("push --force"), "sync does not force-push");
  assert(server.includes("if (!GIT_URL || !GIT_SYNC_MS) return;"), "no remote means no sync timer");
  assert(app.includes("Your other copy has changes."), "diverged copies say the other copy has changes");
  assert(!app.includes("Another copy has changes."), "the old diverged sentence is gone");
  const joinUiStart = app.indexOf("function openGitJoin(");
  const joinUiEnd = app.indexOf("function closeGitJoin(", joinUiStart);
  const joinUi = app.slice(joinUiStart, joinUiEnd);
  assert(joinUi.includes("Your other copy has changes."), "the sentence is on the sheet");
  assert(!joinUi.includes(', "error"'), "the diverged sentence is not a red status");
  assert(joinUi.includes('setStatus("")'), "the status line stays quiet while the sheet offers join");
  const css = fs.readFileSync(path.join(root, "day.css"), "utf8");
  assert(css.includes(".conflict-sheet:not(.is-join) #conflict-join"), "Bring them in is hidden on the conflict sheet");
  const paperOpen = app.slice(app.indexOf("function openPaperConflict("), app.indexOf("function closePaperConflict("));
  assert(paperOpen.includes('classList.remove("is-join")'), "a file conflict is not the other-copy sheet");
  assert(paperOpen.includes("conflict-join") && paperOpen.includes("hidden = true"), "opening the conflict sheet hides Bring them in");
  const keepFn = app.slice(app.indexOf("async function resolveConflictKeep("), app.indexOf("async function resolveConflictTheirs("));
  const takeFn = app.slice(app.indexOf("async function resolveConflictTheirs("), app.indexOf("function gitConflictForOpenPage("));
  assert(keepFn.includes('resolve: "keep"'), "Keep mine is an explicit resolution");
  assert(takeFn.includes('resolve: "theirs"'), "Take theirs is an explicit resolution");
  const saveFn = app.slice(app.indexOf("async function saveDay("), app.indexOf("function currentView("));
  assert(saveFn.includes('resolve: "edit"'), "Edit is an explicit resolution");
  const openDayFn = app.slice(app.indexOf("async function openDay("), app.indexOf("\nfunction renderDay("));
  assert(openDayFn.includes("leavingDay && !conflictOpen"), "day switch does not re-save an open conflict");
  const surface = app.slice(app.indexOf("function surfaceGitConflict("), app.indexOf("async function surfaceOpenGitConflict("));
  assert(surface.indexOf("data.join") < surface.indexOf("data.left"), "an unrelated file stays off the other-copy sheet");
  assert(surface.indexOf("conflicts.length") < surface.indexOf("openGitJoin("), "Bring them in stays hidden while any conflict is unresolved");
  const afterChoice = app.slice(app.indexOf("function afterGitChoice("), app.indexOf("function gitConflictForOpenPage("));
  assert(afterChoice.indexOf("conflicts.length") < afterChoice.indexOf("openGitJoin("), "a remaining conflict hides Bring them in");
  assert(keepFn.includes("afterGitChoice(") && takeFn.includes("afterGitChoice("), "a choice looks for changes still waiting");
  assert(app.includes("function afterGitChoice(") && app.slice(app.indexOf("function afterGitChoice("), app.indexOf("function gitConflictForOpenPage(")).includes("openGitJoin("), "a choice opens the other-copy sheet when changes are still waiting");
  assert(app.includes("function resolveGitJoin("), "join waits for the click");
  assert(app.includes('body: JSON.stringify({ join: true })'), "join posts only after the click");
  assert(htmlIncludesJoin(), "join action sits on the existing sheet");
  const syncBody = server.slice(server.indexOf("async function syncVaultBody("), server.indexOf("function mondayOf("));
  assert(!syncBody.includes("joinVault("), "a save or the timer does not merge on its own");
  assert(server.includes("async function joinVault("), "join re-checks before the merge commit");
  const joinFn = server.slice(server.indexOf("async function joinVault("), server.indexOf("async function syncVault("));
  assert(joinFn.includes('merge", "--no-ff", "--no-commit"'), "join is a normal merge commit");
  assert(joinFn.includes("unmergedFiles"), "join aborts when a file overlaps");
  assert(joinFn.indexOf("noteDivergence") < joinFn.indexOf('merge", "--no-ff"'), "join re-checks overlap before merging");
  assert(joinFn.includes("dropStaleChoices("), "Bring them in checks the recorded blob");
  const publish = server.slice(server.indexOf("async function publishDiverged("), server.indexOf("async function refuseJoin("));
  assert(publish.indexOf("dropStaleChoices(") !== -1 && publish.indexOf("dropStaleChoices(") < publish.indexOf('merge", "--no-ff"'), "the merge checks the blob immediately before applying a choice");
  const diverge = server.slice(server.indexOf("async function noteDivergence("), server.indexOf("async function stageAndCommit("));
  const recordAt = diverge.indexOf("recordConflicts(");
  assert(recordAt !== -1 && recordAt < diverge.indexOf("!item.resolved"), "compare re-checks a recorded choice before treating it as settled");
  assert(!syncBody.includes("noteChoices(paths)"), "an ordinary save does not resolve a conflict");
  assert(syncBody.includes("noteChoices(resolving)"), "only an explicit resolution resolves a conflict");
  assert(server.includes('error: "still conflicted"'), "an ordinary save of a conflict is refused");
  assert(!server.includes("commitDisjointDirty"), "sync does not stage every dirty file");
  assert(!server.includes('add", "-A"') && !server.includes('add", "."') && !server.includes('commit", "-a"'), "sync does not broad-stage");
  const sched = server.slice(server.indexOf("function scheduleVaultSync("), server.indexOf("function startVaultSyncLoop("));
  assert(!sched.includes("pending.clear()") && !sched.includes("resolvePending.clear()"), "starting a sync does not drop pending notes");
  const loop = server.slice(server.indexOf("function startVaultSyncLoop("), server.indexOf("function pushWatchSilence("));
  assert(loop.includes("syncVault(null)"), "the minute sync reads the pending list");
}

function retryUsesSyncQueue() {
  const server = fs.readFileSync(path.join(root, "server.mjs"), "utf8");
  const sched = server.slice(server.indexOf("function scheduleVaultGitRetry("), server.indexOf("async function retryVaultGit("));
  assert(sched.includes("enqueueVaultGit(() => retryVaultGit())"), "offline retry runs on the sync queue");
  assert(!sched.includes("syncVault("), "offline retry does not sync beside the queue");
}

function htmlIncludesJoin() {
  const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
  return html.includes('id="conflict-join"') && html.includes("Bring them in");
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

    const kept = await putDay(baseB, date, fromB, hit.mtime, "keep");
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

function commitFile(vault, rel, text, message) {
  const abs = path.join(vault, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, text, "utf8");
  git(["add", "--", rel], vault);
  git(["commit", "-m", message], vault);
}

function fileText(vault, rel) {
  return fs.readFileSync(path.join(vault, rel), "utf8");
}

async function divergedDifferentFiles() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "aidanos-sync-disjoint-"));
  const bare = seedBare(tmp);
  const vaultA = path.join(tmp, "a");
  const vaultB = path.join(tmp, "b");
  fs.mkdirSync(vaultA, { recursive: true });
  fs.mkdirSync(vaultB, { recursive: true });
  const portA = 33000 + Math.floor(Math.random() * 800);
  const portB = portA + 1;
  const extra = { AIDANOS_VAULT_GIT_SYNC_MS: "0" };
  const childA = spawnServer(serverEnv(portA, vaultA, bare, extra));
  const childB = spawnServer(serverEnv(portB, vaultB, bare, extra));
  const baseA = "http://127.0.0.1:" + portA;
  const baseB = "http://127.0.0.1:" + portB;
  const dayX = "2026-10-20";
  const dayY = "2026-10-21";
  const dayW = "2026-10-18";
  const textX = "day X from A\n";
  const textY = "day Y from B\n";
  const textW = "later save\n";
  let watch;
  try {
    await waitHealth(baseA, childA);
    await waitHealth(baseB, childB);
    commitFile(vaultA, "log/" + dayX + ".md", textX, "A day X");
    git(["push", "origin", "HEAD"], vaultA);
    commitFile(vaultB, "log/" + dayY + ".md", textY, "B day Y");
    watch = await fetch(baseB + "/api/day-watch");
    const later = await putDay(baseB, dayW, textW, 0);
    assert(later.res.ok, "later save reaches disk " + later.res.status + " " + JSON.stringify(later.body));
    assert(fileText(vaultB, "log/" + dayW + ".md") === textW, "later save is on disk before the join");
    const notice = await readSseUntil(
      watch,
      (data) => data && data.type === "git" && data.join === true && data.error && !(data.conflicts || []).length,
      5000,
    );
    assert(/rejected|non-fast-forward|behind|refused/i.test(notice.error), "refused push is shown when no file overlaps");
    const sync = await (await fetch(baseB + "/api/sync")).json();
    assert(sync.ok === false && sync.join === true, "page state offers the one join action " + JSON.stringify(sync));
    assert(!(sync.conflicts || []).length, "no same-file conflict to resolve");
    assert(git(["log", "--oneline", "--", "log/" + dayW + ".md"], vaultB).trim(), "later save is in local git");
    assert(!git(["status", "--porcelain"], vaultB).includes(dayW), "later save is not left untracked");
    assert(git(["show", "main:log/" + dayX + ".md"], bare) === textX, "remote still has only A's day");
    let missingY = false;
    try { git(["show", "main:log/" + dayY + ".md"], bare); } catch { missingY = true; }
    assert(missingY, "join has not run yet, so B's day is not on the remote");
    await new Promise((r) => setTimeout(r, 400));
    try { git(["show", "main:log/" + dayY + ".md"], bare); missingY = false; } catch { missingY = true; }
    assert(missingY, "nothing merges without the click");
    const joined = await fetch(baseB + "/api/sync", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ join: true }),
    });
    const joinedBody = await joined.json();
    assert(joined.ok, "join " + joined.status + " " + JSON.stringify(joinedBody) + " " + childB._log().slice(-500));
    assert(joinedBody.join === false && joinedBody.ok === true, "join clears the refused state");
    assert(git(["show", "main:log/" + dayX + ".md"], bare) === textX, "A's day was not rewritten");
    assert(git(["show", "main:log/" + dayY + ".md"], bare) === textY, "B's day was not rewritten");
    assert(git(["show", "main:log/" + dayW + ".md"], bare) === textW, "later save was pushed intact");
    const parents = git(["rev-list", "--parents", "-n", "1", "main"], bare).trim().split(/\s+/);
    assert(parents.length === 3, "join is a merge commit, not a rebase " + parents.join(" "));
    assert(fileText(vaultB, "log/" + dayX + ".md") === textX, "B has A's day unchanged");
    assert(fileText(vaultB, "log/" + dayY + ".md") === textY, "B kept its own day");
    assert(!fileText(vaultB, "log/" + dayX + ".md").includes("day Y"), "days were not combined");
    assert(!fileText(vaultB, "log/" + dayY + ".md").includes("day X"), "days were not combined");
    const nudge = await putDay(baseA, "2026-10-19", "seed day\n");
    assert(nudge.res.ok, "A sync trigger " + nudge.res.status);
    await waitFor(async () => fileText(vaultA, "log/" + dayY + ".md") === textY, 5000, "A receives B's day");
    assert(fileText(vaultA, "log/" + dayX + ".md") === textX, "A still has its own day");
    assert(fileText(vaultA, "log/" + dayW + ".md") === textW, "A receives the later save");
    assert(fileText(vaultB, "log/" + dayX + ".md") === textX, "B still has A's day");
    const after = await (await fetch(baseB + "/api/sync")).json();
    assert(after.ok === true && after.join === false, "both sides are caught up " + JSON.stringify(after));
  } finally {
    try { if (watch) await watch.body.cancel(); } catch {}
    await stop(childA);
    await stop(childB);
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  }
}

async function mixedOverlapAndDisjoint() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "aidanos-sync-mixed-"));
  const bare = seedBare(tmp);
  const vaultA = path.join(tmp, "a");
  const vaultB = path.join(tmp, "b");
  fs.mkdirSync(vaultA, { recursive: true });
  fs.mkdirSync(vaultB, { recursive: true });
  const portA = 34000 + Math.floor(Math.random() * 800);
  const portB = portA + 1;
  const extra = { AIDANOS_VAULT_GIT_SYNC_MS: "0" };
  const childA = spawnServer(serverEnv(portA, vaultA, bare, extra));
  const childB = spawnServer(serverEnv(portB, vaultB, bare, extra));
  const baseA = "http://127.0.0.1:" + portA;
  const baseB = "http://127.0.0.1:" + portB;
  const overlap = "2026-10-19";
  const localOnly = "2026-10-21";
  const remoteOnly = "2026-10-20";
  const laterDay = "2026-10-18";
  const textA = "overlap from A\n";
  const textB = "overlap from B\n";
  const textLocal = "only on B\n";
  const textRemote = "only on A\n";
  const textLater = "saved while split\n";
  let watch;
  try {
    await waitHealth(baseA, childA);
    await waitHealth(baseB, childB);
    commitFile(vaultA, "log/" + overlap + ".md", textA, "A overlap");
    commitFile(vaultA, "log/" + remoteOnly + ".md", textRemote, "A disjoint");
    git(["push", "origin", "HEAD"], vaultA);
    commitFile(vaultB, "log/" + overlap + ".md", textB, "B overlap");
    commitFile(vaultB, "log/" + localOnly + ".md", textLocal, "B disjoint");
    const remoteBefore = git(["rev-parse", "main"], bare).trim();
    watch = await fetch(baseB + "/api/day-watch");
    const later = await putDay(baseB, laterDay, textLater, 0);
    assert(later.res.ok, "mixed later save " + later.res.status);
    const notice = await readSseUntil(
      watch,
      (data) => data && data.type === "git" && Array.isArray(data.conflicts) && data.conflicts.some((item) => item && item.path === "log/" + overlap + ".md"),
      5000,
    );
    assert(notice.join !== true, "an overlapping file does not offer the blind join");
    assert(notice.error, "mixed divergence still shows the refusal");
    const hit = notice.conflicts.find((item) => item.path === "log/" + overlap + ".md");
    assert(hit.mine === textB && hit.theirs === textA, "overlap keeps both versions");
    assert(notice.conflicts.length === 1, "the disjoint file is not a conflict");
    assert(fileText(vaultB, "log/" + localOnly + ".md") === textLocal, "B kept the disjoint day");
    assert(fileText(vaultB, "log/" + overlap + ".md") === textB, "B kept its overlap text");
    assert(git(["log", "--oneline", "--", "log/" + laterDay + ".md"], vaultB).trim(), "save during a mixed split is in local git");
    assert(fileText(vaultB, "log/" + laterDay + ".md") === textLater, "save during a mixed split stays on disk");
    const blocked = await fetch(baseB + "/api/sync", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ join: true }),
    });
    const blockedBody = await blocked.json();
    assert(blocked.status === 409, "join refuses while a file overlaps " + JSON.stringify(blockedBody));
    assert(git(["rev-parse", "main"], bare).trim() === remoteBefore, "refused join did not push a merge");
    assert(git(["show", "main:log/" + overlap + ".md"], bare) === textA, "remote overlap stays A's until the sheet");
    const kept = await putDay(baseB, overlap, textB, hit.mtime, "keep");
    assert(kept.res.ok, "keep mine " + kept.res.status + " " + JSON.stringify(kept.body) + " " + childB._log().slice(-400));
    const offered = await waitFor(async () => {
      const sync = await (await fetch(baseB + "/api/sync")).json();
      return sync.join === true && !(sync.conflicts || []).length ? sync : "";
    }, 5000, "other-copy sheet after the choice");
    assert(offered.join === true, "after the choice the other copy is still waiting");
    let notMerged = false;
    try { git(["show", "main:log/" + localOnly + ".md"], bare); } catch { notMerged = true; }
    assert(notMerged, "the choice does not bring the other days in by itself");
    const joined = await fetch(baseB + "/api/sync", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ join: true }),
    });
    const joinedBody = await joined.json();
    assert(joined.ok, "bring them in after the choice " + joined.status + " " + JSON.stringify(joinedBody) + " " + childB._log().slice(-400));
    await waitFor(async () => {
      try { return git(["show", "main:log/" + localOnly + ".md"], bare) === textLocal; } catch { return ""; }
    }, 5000, "merge after Bring them in");
    assert(git(["show", "main:log/" + overlap + ".md"], bare) === textB, "overlap resolved to one whole version");
    assert(!git(["show", "main:log/" + overlap + ".md"], bare).includes("overlap from A"), "overlap text was not combined");
    assert(git(["show", "main:log/" + remoteOnly + ".md"], bare) === textRemote, "remote-only day kept");
    assert(git(["show", "main:log/" + laterDay + ".md"], bare) === textLater, "later save survived the merge");
    const parents = git(["rev-list", "--parents", "-n", "1", "main"], bare).trim().split(/\s+/);
    assert(parents.length === 3, "the rest lands in a merge commit " + parents.join(" "));
    const first = parents[1];
    const second = parents[2];
    assert(git(["show", first + ":log/" + overlap + ".md"], bare) === textB, "local parent kept B's version");
    assert(git(["show", second + ":log/" + overlap + ".md"], bare) === textA, "other parent kept A's version");
    assert(fileText(vaultB, "log/" + remoteOnly + ".md") === textRemote, "B received A's disjoint day intact");
    assert(fileText(vaultB, "log/" + localOnly + ".md") === textLocal, "B still has its disjoint day");
    const nudge = await putDay(baseA, "2026-10-17", "from A after\n");
    assert(nudge.res.ok, "A catch-up " + nudge.res.status);
    await waitFor(async () => {
      try { return fileText(vaultA, "log/" + localOnly + ".md") === textLocal; } catch { return ""; }
    }, 5000, "A receives B's disjoint day");
    assert(fileText(vaultA, "log/" + overlap + ".md") === textB, "A has the chosen overlap text");
    assert(fileText(vaultA, "log/" + remoteOnly + ".md") === textRemote, "A kept its disjoint day");
    assert(git(["show", "main:log/" + overlap + ".md"], bare) === textB, "remote overlap is still one version");
  } finally {
    try { if (watch) await watch.body.cancel(); } catch {}
    await stop(childA);
    await stop(childB);
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  }
}

async function conflictSurvivesDaySwitch() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "aidanos-sync-switch-"));
  const bare = seedBare(tmp);
  const vaultA = path.join(tmp, "a");
  const vaultB = path.join(tmp, "b");
  fs.mkdirSync(vaultA, { recursive: true });
  fs.mkdirSync(vaultB, { recursive: true });
  const portA = 35000 + Math.floor(Math.random() * 800);
  const portB = portA + 1;
  const extra = { AIDANOS_VAULT_GIT_SYNC_MS: "0" };
  const childA = spawnServer(serverEnv(portA, vaultA, bare, extra));
  const childB = spawnServer(serverEnv(portB, vaultB, bare, extra));
  const baseA = "http://127.0.0.1:" + portA;
  const baseB = "http://127.0.0.1:" + portB;
  const date = "2026-10-19";
  const other = "2026-10-18";
  try {
    await waitHealth(baseA, childA);
    await waitHealth(baseB, childB);
    const fromA = "from copy A\n";
    const putA = await putDay(baseA, date, fromA);
    assert(putA.res.ok, "A save " + putA.res.status);
    await waitFor(async () => git(["show", "main:log/" + date + ".md"], bare) === fromA, 5000, "A on remote");
    const fromB = "from copy B\n";
    const putB = await putDay(baseB, date, fromB);
    assert(putB.res.ok, "B save " + putB.res.status + " " + JSON.stringify(putB.body));
    const sync = await waitFor(async () => {
      const body = await (await fetch(baseB + "/api/sync")).json();
      const hit = (body.conflicts || []).find((item) => item && item.path === "log/" + date + ".md");
      return hit && hit.mine === fromB && hit.theirs === fromA ? body : "";
    }, 5000, "conflict sheet");
    const hit = sync.conflicts.find((item) => item.path === "log/" + date + ".md");
    const headBefore = git(["rev-parse", "HEAD"], vaultB).trim();
    const remoteBefore = git(["rev-parse", "main"], bare).trim();
    const away = await putDay(baseB, other, "switched away\n", 0);
    assert(away.res.ok, "switching days can still save the other day " + away.res.status);
    const switched = await putDay(baseB, date, fromB, hit.mtime);
    assert(switched.res.status === 409, "leaving the conflicted day is not Keep mine " + switched.res.status + " " + JSON.stringify(switched.body));
    assert(switched.body && switched.body.error === "still conflicted", "the refusal is not a resolution");
    await new Promise((r) => setTimeout(r, 500));
    assert(git(["rev-parse", "HEAD"], vaultB).trim() === headBefore, "day switch did not commit Keep mine");
    assert(git(["rev-parse", "main"], bare).trim() === remoteBefore, "day switch did not push Keep mine");
    assert(git(["show", "main:log/" + date + ".md"], bare) === fromA, "the other copy is still the remote version");
    assert(fileText(vaultB, "log/" + date + ".md") === fromB, "the local copy is still on disk");
    const back = await (await fetch(baseB + "/api/sync")).json();
    const again = (back.conflicts || []).find((item) => item && item.path === "log/" + date + ".md");
    assert(again && again.mine === fromB && again.theirs === fromA, "coming back still shows both versions " + JSON.stringify(back.conflicts || []));
    assert(back.join !== true, "the conflict sheet is still the one showing");
    const day = await (await fetch(baseB + "/api/day?date=" + date)).json();
    assert(day.markdown === fromB, "the open day still has the local copy");
  } finally {
    await stop(childA);
    await stop(childB);
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  }
}

function trackedNames(cwd) {
  try {
    return git(["ls-files"], cwd);
  } catch {
    return "";
  }
}

function historyNames(cwd) {
  try {
    return git(["log", "--all", "--name-only", "--pretty=format:"], cwd);
  } catch {
    return "";
  }
}

async function strayFileLeftAlone() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "aidanos-sync-stray-"));
  const bare = seedBare(tmp);
  const vaultA = path.join(tmp, "a");
  const vaultB = path.join(tmp, "b");
  fs.mkdirSync(vaultA, { recursive: true });
  fs.mkdirSync(vaultB, { recursive: true });
  const portA = 36000 + Math.floor(Math.random() * 800);
  const portB = portA + 1;
  const extra = { AIDANOS_VAULT_GIT_SYNC_MS: "0" };
  const childA = spawnServer(serverEnv(portA, vaultA, bare, extra));
  const childB = spawnServer(serverEnv(portB, vaultB, bare, extra));
  const baseA = "http://127.0.0.1:" + portA;
  const baseB = "http://127.0.0.1:" + portB;
  const dayX = "2026-10-20";
  const dayY = "2026-10-21";
  const dayW = "2026-10-18";
  const textX = "day X from A\n";
  const textY = "day Y from B\n";
  const textW = "saved while drifted\n";
  try {
    await waitHealth(baseA, childA);
    await waitHealth(baseB, childB);
    commitFile(vaultA, "log/" + dayX + ".md", textX, "A day X");
    git(["push", "origin", "HEAD"], vaultA);
    commitFile(vaultB, "log/" + dayY + ".md", textY, "B day Y");
    fs.writeFileSync(path.join(vaultB, "private-scratch.txt"), "not for the vault\n", "utf8");
    fs.writeFileSync(path.join(vaultB, "README.md"), "vault\nlocal aside\n", "utf8");
    const later = await putDay(baseB, dayW, textW, 0);
    assert(later.res.ok, "save during drift " + later.res.status + " " + JSON.stringify(later.body));
    const sync = await waitFor(async () => {
      const body = await (await fetch(baseB + "/api/sync")).json();
      return body.join === true ? body : "";
    }, 5000, "drift offers Bring them in");
    assert(sync.left === "Left an unrelated file alone.", "the save says the stray file was left alone " + JSON.stringify(sync));
    assert(!trackedNames(vaultB).includes("private-scratch.txt"), "save did not stage the stray file");
    assert(!historyNames(vaultB).includes("private-scratch.txt"), "save did not commit the stray file");
    assert(git(["show", "HEAD:README.md"], vaultB) === "vault\n", "save did not commit the unrelated edit");
    assert(fileText(vaultB, "README.md") === "vault\nlocal aside\n", "the unrelated edit is still in the working tree");
    const joined = await fetch(baseB + "/api/sync", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ join: true }),
    });
    const joinedBody = await joined.json();
    assert(joined.ok, "Bring them in " + joined.status + " " + JSON.stringify(joinedBody) + " " + childB._log().slice(-500));
    assert(joinedBody.left === "Left an unrelated file alone.", "Bring them in says the stray file was left alone");
    assert(git(["show", "main:log/" + dayX + ".md"], bare) === textX, "A's day was brought in");
    assert(git(["show", "main:log/" + dayY + ".md"], bare) === textY, "B's day was pushed");
    assert(git(["show", "main:log/" + dayW + ".md"], bare) === textW, "the save was pushed");
    assert(git(["show", "main:README.md"], bare) === "vault\n", "the unrelated edit was not pushed");
    let scratchMissing = false;
    try { git(["show", "main:private-scratch.txt"], bare); } catch { scratchMissing = true; }
    assert(scratchMissing, "the stray file was not pushed");
    assert(!historyNames(bare).includes("private-scratch.txt"), "the stray file is not in remote history");
    assert(!trackedNames(vaultB).includes("private-scratch.txt"), "Bring them in did not stage the stray file");
    assert(fileText(vaultB, "private-scratch.txt") === "not for the vault\n", "the stray file is still on disk");
    assert(fileText(vaultB, "README.md") === "vault\nlocal aside\n", "Bring them in left the unrelated edit in place");
    assert(git(["status", "--porcelain", "--", "private-scratch.txt"], vaultB).includes("private-scratch.txt"), "the stray file is still untracked");
  } finally {
    await stop(childA);
    await stop(childB);
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  }
}

function pendingSaved(vault) {
  const file = path.join(vault, ".git", "aidanos-pending");
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

async function otherNoteSurvivesConflict() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "aidanos-sync-other-"));
  const bare = seedBare(tmp);
  const vaultA = path.join(tmp, "a");
  const vaultB = path.join(tmp, "b");
  fs.mkdirSync(vaultA, { recursive: true });
  fs.mkdirSync(vaultB, { recursive: true });
  const portA = 41000 + Math.floor(Math.random() * 400);
  const portB = portA + 1;
  const extra = { AIDANOS_VAULT_GIT_SYNC_MS: "0" };
  const childA = spawnServer(serverEnv(portA, vaultA, bare, extra));
  const childB = spawnServer(serverEnv(portB, vaultB, bare, extra));
  const baseA = "http://127.0.0.1:" + portA;
  const baseB = "http://127.0.0.1:" + portB;
  const today = "2026-10-19";
  const tomorrow = "2026-10-20";
  const fromA = "today from A\n";
  const fromB = "today from B\n";
  const later = "tomorrow from B\n";
  try {
    await waitHealth(baseA, childA);
    await waitHealth(baseB, childB);
    const putA = await putDay(baseA, today, fromA);
    assert(putA.res.ok, "A save " + putA.res.status);
    await waitFor(async () => git(["show", "main:log/" + today + ".md"], bare) === fromA, 8000, "A on remote");
    const putB = await putDay(baseB, today, fromB);
    assert(putB.res.ok, "B save " + putB.res.status + " " + JSON.stringify(putB.body));
    await waitFor(async () => {
      const body = await (await fetch(baseB + "/api/sync")).json();
      const hit = (body.conflicts || []).find((item) => item && item.path === "log/" + today + ".md");
      return hit && hit.mine === fromB && hit.theirs === fromA ? body : "";
    }, 5000, "conflict on today");
    const next = await putDay(baseB, tomorrow, later, 0);
    assert(next.res.ok, "tomorrow save " + next.res.status + " " + JSON.stringify(next.body));
    assert(fileText(vaultB, "log/" + tomorrow + ".md") === later, "tomorrow is on disk");
    await new Promise((r) => setTimeout(r, 500));
    let missing = false;
    try { git(["show", "main:log/" + tomorrow + ".md"], bare); } catch { missing = true; }
    assert(missing, "tomorrow is not pushed while today is in conflict");
    const during = await (await fetch(baseB + "/api/sync")).json();
    const still = (during.conflicts || []).find((item) => item && item.path === "log/" + today + ".md");
    assert(still && still.mine === fromB && still.theirs === fromA, "today still has both versions");
    assert(during.left === "", "tomorrow is not called an unrelated file " + JSON.stringify(during));
    const queued = pendingSaved(vaultB);
    assert(queued.paths.includes("log/" + tomorrow + ".md"), "tomorrow stays pending " + JSON.stringify(queued));
    const kept = await putDay(baseB, today, fromB, still.mtime, "keep");
    assert(kept.res.ok, "resolve today " + kept.res.status + " " + JSON.stringify(kept.body));
    await waitFor(async () => git(["show", "main:log/" + tomorrow + ".md"], bare) === later, 5000, "tomorrow reaches the remote");
    assert(git(["show", "main:log/" + today + ".md"], bare) === fromB, "today resolved to B");
    assert(!git(["ls-files"], vaultB).includes("aidanos-pending"), "the pending list is not a vault file");
    assert(!historyNames(bare).includes("aidanos-pending"), "the pending list was not pushed");
  } finally {
    await stop(childA);
    await stop(childB);
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  }
}

async function otherNoteSurvivesConflictOffline() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "aidanos-sync-other-off-"));
  const bare = seedBare(tmp);
  const vaultA = path.join(tmp, "a");
  const vaultB = path.join(tmp, "b");
  fs.mkdirSync(vaultA, { recursive: true });
  fs.mkdirSync(vaultB, { recursive: true });
  const portA = 43000 + Math.floor(Math.random() * 400);
  const portB = portA + 1;
  const extra = { AIDANOS_VAULT_GIT_SYNC_MS: "0" };
  const childA = spawnServer(serverEnv(portA, vaultA, bare, extra));
  const childB = spawnServer(serverEnv(portB, vaultB, bare, extra));
  const baseA = "http://127.0.0.1:" + portA;
  const baseB = "http://127.0.0.1:" + portB;
  const today = "2026-10-19";
  const tomorrow = "2026-10-20";
  const fromA = "today from A\n";
  const fromB = "today from B\n";
  const later = "tomorrow while offline\n";
  try {
    await waitHealth(baseA, childA);
    await waitHealth(baseB, childB);
    const putA = await putDay(baseA, today, fromA);
    assert(putA.res.ok, "A save " + putA.res.status);
    await waitFor(async () => git(["show", "main:log/" + today + ".md"], bare) === fromA, 8000, "A on remote");
    const putB = await putDay(baseB, today, fromB);
    assert(putB.res.ok, "B save " + putB.res.status);
    const opened = await waitFor(async () => {
      const body = await (await fetch(baseB + "/api/sync")).json();
      const hit = (body.conflicts || []).find((item) => item && item.path === "log/" + today + ".md");
      return hit && hit.mine === fromB && hit.theirs === fromA ? body : "";
    }, 5000, "conflict before the outage");
    git(["remote", "set-url", "origin", path.join(tmp, "down.git")], vaultB);
    const next = await putDay(baseB, tomorrow, later, 0);
    assert(next.res.ok, "tomorrow save during the outage " + next.res.status);
    const failed = await waitFor(async () => {
      const body = await (await fetch(baseB + "/api/sync")).json();
      return body.error ? body : "";
    }, 5000, "sync notices the outage");
    assert(failed.left === "", "an app note is not unrelated during the outage " + JSON.stringify(failed));
    let missing = false;
    try { git(["show", "main:log/" + tomorrow + ".md"], bare); } catch { missing = true; }
    assert(missing, "tomorrow is not on the remote while the network is down");
    assert(pendingSaved(vaultB).paths.includes("log/" + tomorrow + ".md"), "tomorrow stays pending through the failed sync");
    git(["remote", "set-url", "origin", bare], vaultB);
    const kept = await putDay(baseB, today, fromB, opened.conflicts.find((item) => item.path === "log/" + today + ".md").mtime, "keep");
    assert(kept.res.ok, "resolve after the network returns " + kept.res.status + " " + JSON.stringify(kept.body));
    await waitFor(async () => git(["show", "main:log/" + tomorrow + ".md"], bare) === later, 5000, "tomorrow reaches the remote after the network returns");
    assert(git(["show", "main:log/" + today + ".md"], bare) === fromB, "today still resolved to B");
  } finally {
    await stop(childA);
    await stop(childB);
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  }
}

async function pendingSurvivesRestart() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "aidanos-sync-restart-"));
  const bare = seedBare(tmp);
  const vaultA = path.join(tmp, "a");
  const vaultB = path.join(tmp, "b");
  fs.mkdirSync(vaultA, { recursive: true });
  fs.mkdirSync(vaultB, { recursive: true });
  const portA = 45000 + Math.floor(Math.random() * 400);
  const portB = portA + 1;
  const extra = { AIDANOS_VAULT_GIT_SYNC_MS: "0" };
  const childA = spawnServer(serverEnv(portA, vaultA, bare, extra));
  let childB = spawnServer(serverEnv(portB, vaultB, bare, extra));
  const baseA = "http://127.0.0.1:" + portA;
  const baseB = "http://127.0.0.1:" + portB;
  const today = "2026-10-19";
  const tomorrow = "2026-10-20";
  const fromA = "today from A\n";
  const fromB = "today from B\n";
  const later = "tomorrow across a restart\n";
  try {
    await waitHealth(baseA, childA);
    await waitHealth(baseB, childB);
    const putA = await putDay(baseA, today, fromA);
    assert(putA.res.ok, "A save " + putA.res.status);
    await waitFor(async () => git(["show", "main:log/" + today + ".md"], bare) === fromA, 8000, "A on remote");
    const putB = await putDay(baseB, today, fromB);
    assert(putB.res.ok, "B save " + putB.res.status);
    await waitFor(async () => {
      const body = await (await fetch(baseB + "/api/sync")).json();
      const hit = (body.conflicts || []).find((item) => item && item.path === "log/" + today + ".md");
      return hit && hit.mine === fromB && hit.theirs === fromA ? body : "";
    }, 5000, "conflict before restart");
    const next = await putDay(baseB, tomorrow, later, 0);
    assert(next.res.ok, "tomorrow save " + next.res.status);
    await new Promise((r) => setTimeout(r, 400));
    const queued = pendingSaved(vaultB);
    assert(queued.paths.includes("log/" + tomorrow + ".md"), "pending file has tomorrow before the restart " + JSON.stringify(queued));
    assert(fs.existsSync(path.join(vaultB, ".git", "aidanos-pending")), "pending file lives inside .git");
    await stop(childB);
    childB = spawnServer(serverEnv(portB, vaultB, bare, extra));
    await waitHealth(baseB, childB);
    const reopened = await waitFor(async () => {
      const body = await (await fetch(baseB + "/api/sync")).json();
      const hit = (body.conflicts || []).find((item) => item && item.path === "log/" + today + ".md");
      return hit && hit.mine === fromB && hit.theirs === fromA ? body : "";
    }, 5000, "conflict comes back after restart");
    assert(pendingSaved(vaultB).paths.includes("log/" + tomorrow + ".md"), "restart kept tomorrow pending");
    assert(reopened.left === "", "restart does not call tomorrow unrelated");
    const kept = await putDay(baseB, today, fromB, reopened.conflicts.find((item) => item.path === "log/" + today + ".md").mtime, "keep");
    assert(kept.res.ok, "resolve after restart " + kept.res.status + " " + JSON.stringify(kept.body));
    await waitFor(async () => git(["show", "main:log/" + tomorrow + ".md"], bare) === later, 5000, "tomorrow reaches the remote after restart");
    assert(!git(["ls-files"], vaultB).includes("aidanos-pending"), "restart did not commit the pending file");
    assert(!historyNames(vaultB).includes("aidanos-pending"), "the pending file is not in local history");
    assert(!historyNames(bare).includes("aidanos-pending"), "the pending file was not pushed");
  } finally {
    await stop(childA);
    await stop(childB);
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  }
}

async function withChoiceThenSecondEdit(portBase, resolve, chosen, fn) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "aidanos-sync-stale-"));
  const bare = seedBare(tmp);
  const vaultA = path.join(tmp, "a");
  const vaultB = path.join(tmp, "b");
  fs.mkdirSync(vaultA, { recursive: true });
  fs.mkdirSync(vaultB, { recursive: true });
  const portA = portBase + Math.floor(Math.random() * 200);
  const portB = portA + 1;
  const extra = { AIDANOS_VAULT_GIT_SYNC_MS: "0" };
  const childA = spawnServer(serverEnv(portA, vaultA, bare, extra));
  const childB = spawnServer(serverEnv(portB, vaultB, bare, extra));
  const baseB = "http://127.0.0.1:" + portB;
  const overlap = "2026-10-19";
  const textA = "A1\n";
  const textB = "B1\n";
  const textA2 = "A2 second edit\n";
  try {
    await waitHealth("http://127.0.0.1:" + portA, childA);
    await waitHealth(baseB, childB);
    commitFile(vaultA, "log/" + overlap + ".md", textA, "A overlap");
    commitFile(vaultA, "log/2026-10-20.md", "only on A\n", "A disjoint");
    git(["push", "origin", "HEAD"], vaultA);
    commitFile(vaultB, "log/" + overlap + ".md", textB, "B overlap");
    commitFile(vaultB, "log/2026-10-21.md", "only on B\n", "B disjoint");
    const trigger = await putDay(baseB, "2026-10-18", "trigger compare\n", 0);
    assert(trigger.res.ok, "trigger " + trigger.res.status + " " + JSON.stringify(trigger.body));
    const opened = await waitFor(async () => {
      const body = await (await fetch(baseB + "/api/sync")).json();
      const hit = (body.conflicts || []).find((item) => item && item.path === "log/" + overlap + ".md");
      return hit && hit.mine === textB && hit.theirs === textA ? body : "";
    }, 8000, "conflict before the choice");
    const hit = opened.conflicts.find((item) => item.path === "log/" + overlap + ".md");
    const picked = await putDay(baseB, overlap, chosen, hit.mtime, resolve);
    assert(picked.res.ok, resolve + " " + picked.res.status + " " + JSON.stringify(picked.body) + " " + childB._log().slice(-400));
    let lastSync = "";
    try {
      await waitFor(async () => {
        const sync = await (await fetch(baseB + "/api/sync")).json();
        lastSync = JSON.stringify(sync);
        return sync.join === true && !(sync.conflicts || []).length ? sync : "";
      }, 15000, "waiting for Bring them in");
    } catch (err) {
      throw new Error(String(err && err.message || err) + " last=" + lastSync + " log=" + childB._log().slice(-800));
    }
    assert(fileText(vaultB, "log/" + overlap + ".md") === chosen, "the choice is what is on disk");
    commitFile(vaultA, "log/" + overlap + ".md", textA2, "A second edit");
    git(["push", "origin", "HEAD"], vaultA);
    await waitFor(async () => git(["show", "main:log/" + overlap + ".md"], bare) === textA2, 8000, "A2 on remote");
    const remoteAt = git(["rev-parse", "main"], bare).trim();
    await fn({ baseB, vaultB, bare, overlap, textA2, chosen, remoteAt, childB });
  } finally {
    await stop(childA);
    await stop(childB);
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  }
}

async function joinHiddenUntilEveryConflictIsChosen() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "aidanos-sync-join-set-"));
  const bare = seedBare(tmp);
  const vaultA = path.join(tmp, "a");
  const vaultB = path.join(tmp, "b");
  fs.mkdirSync(vaultA, { recursive: true });
  fs.mkdirSync(vaultB, { recursive: true });
  const portA = 45100 + Math.floor(Math.random() * 400);
  const portB = portA + 1;
  const extra = { AIDANOS_VAULT_GIT_SYNC_MS: "0" };
  const childA = spawnServer(serverEnv(portA, vaultA, bare, extra));
  const childB = spawnServer(serverEnv(portB, vaultB, bare, extra));
  const baseB = "http://127.0.0.1:" + portB;
  const first = "2026-10-19";
  const second = "2026-10-20";
  try {
    await waitHealth("http://127.0.0.1:" + portA, childA);
    await waitHealth(baseB, childB);
    commitFile(vaultA, "log/" + first + ".md", "A one\n", "A first");
    commitFile(vaultA, "log/" + second + ".md", "A two\n", "A second");
    commitFile(vaultA, "log/2026-10-21.md", "only on A\n", "A waiting");
    git(["push", "origin", "HEAD"], vaultA);
    commitFile(vaultB, "log/" + first + ".md", "B one\n", "B first");
    commitFile(vaultB, "log/" + second + ".md", "B two\n", "B second");
    const trigger = await putDay(baseB, "2026-10-18", "trigger compare\n", 0);
    assert(trigger.res.ok, "trigger " + trigger.res.status);
    const opened = await waitFor(async () => {
      const body = await (await fetch(baseB + "/api/sync")).json();
      const paths = (body.conflicts || []).map((item) => item && item.path).sort();
      return paths.join(",") === "log/" + first + ".md,log/" + second + ".md" && body.join !== true ? body : "";
    }, 8000, "both conflicts before any choice");
    assert(opened.join !== true, "Bring them in is hidden while both notes are unresolved");
    const one = opened.conflicts.find((item) => item.path === "log/" + first + ".md");
    const keptOne = await putDay(baseB, first, "B one\n", one.mtime, "keep");
    assert(keptOne.res.ok, "first choice " + keptOne.res.status + " " + JSON.stringify(keptOne.body));
    const midway = await waitFor(async () => {
      const body = await (await fetch(baseB + "/api/sync")).json();
      const hit = (body.conflicts || []).find((item) => item && item.path === "log/" + second + ".md");
      return hit && body.join !== true ? body : "";
    }, 8000, "second conflict still open");
    assert(midway.join !== true, "Bring them in stays hidden after only one choice");
    assert((midway.conflicts || []).some((item) => item.path === "log/" + second + ".md"), "the other note is still a conflict");
    const two = midway.conflicts.find((item) => item.path === "log/" + second + ".md");
    const keptTwo = await putDay(baseB, second, "B two\n", two.mtime, "keep");
    assert(keptTwo.res.ok, "second choice " + keptTwo.res.status + " " + JSON.stringify(keptTwo.body));
    const offered = await waitFor(async () => {
      const body = await (await fetch(baseB + "/api/sync")).json();
      return body.join === true && !(body.conflicts || []).length ? body : "";
    }, 8000, "Bring them in after every choice");
    assert(offered.join === true, "Bring them in is shown once every conflicting note has a choice");
  } finally {
    await stop(childA);
    await stop(childB);
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  }
}

async function staleChoiceAfterKeepMine() {
  await withChoiceThenSecondEdit(46100, "keep", "B1\n", async (ctx) => {
    const nudge = await putDay(ctx.baseB, "2026-10-17", "nudge compare\n", 0);
    assert(nudge.res.ok, "nudge " + nudge.res.status);
    const again = await waitFor(async () => {
      const body = await (await fetch(ctx.baseB + "/api/sync")).json();
      const hit = (body.conflicts || []).find((item) => item && item.path === "log/" + ctx.overlap + ".md");
      return hit && hit.mine === "B1\n" && hit.theirs === ctx.textA2 ? body : "";
    }, 8000, "Keep mine reopens with the new text");
    assert(again.join !== true, "Bring them in stays hidden while the new conflict is open");
    assert(fileText(ctx.vaultB, "log/" + ctx.overlap + ".md") === "B1\n", "Keep mine was not overwritten");
    await new Promise((r) => setTimeout(r, 500));
    assert(git(["show", "main:log/" + ctx.overlap + ".md"], ctx.bare) === ctx.textA2, "the old choice did not replace A2");
    assert(git(["rev-parse", "main"], ctx.bare).trim() === ctx.remoteAt, "nothing was pushed over the second edit");
  });
}

async function staleChoiceAfterTakeTheirs() {
  await withChoiceThenSecondEdit(47100, "theirs", "A1\n", async (ctx) => {
    const nudge = await putDay(ctx.baseB, "2026-10-17", "nudge compare\n", 0);
    assert(nudge.res.ok, "nudge " + nudge.res.status);
    const again = await waitFor(async () => {
      const body = await (await fetch(ctx.baseB + "/api/sync")).json();
      const hit = (body.conflicts || []).find((item) => item && item.path === "log/" + ctx.overlap + ".md");
      return hit && hit.mine === "A1\n" && hit.theirs === ctx.textA2 ? body : "";
    }, 8000, "Take theirs reopens with the new text");
    assert(again.join !== true, "Bring them in stays hidden while the new conflict is open");
    assert(fileText(ctx.vaultB, "log/" + ctx.overlap + ".md") === "A1\n", "Take theirs was not overwritten");
    await new Promise((r) => setTimeout(r, 500));
    assert(git(["show", "main:log/" + ctx.overlap + ".md"], ctx.bare) === ctx.textA2, "the old choice did not replace A2");
    assert(git(["rev-parse", "main"], ctx.bare).trim() === ctx.remoteAt, "nothing was pushed over the second edit");
  });
}

async function staleChoiceAfterEdit() {
  const edited = "edited on B\n";
  await withChoiceThenSecondEdit(48100, "edit", edited, async (ctx) => {
    const nudge = await putDay(ctx.baseB, "2026-10-17", "nudge compare\n", 0);
    assert(nudge.res.ok, "nudge " + nudge.res.status);
    const again = await waitFor(async () => {
      const body = await (await fetch(ctx.baseB + "/api/sync")).json();
      const hit = (body.conflicts || []).find((item) => item && item.path === "log/" + ctx.overlap + ".md");
      return hit && hit.mine === edited && hit.theirs === ctx.textA2 ? body : "";
    }, 8000, "Edit reopens with the new text");
    assert(again.join !== true, "Bring them in stays hidden while the new conflict is open");
    assert(fileText(ctx.vaultB, "log/" + ctx.overlap + ".md") === edited, "Edit was not overwritten");
    await new Promise((r) => setTimeout(r, 500));
    assert(git(["show", "main:log/" + ctx.overlap + ".md"], ctx.bare) === ctx.textA2, "the old choice did not replace A2");
    assert(git(["rev-parse", "main"], ctx.bare).trim() === ctx.remoteAt, "nothing was pushed over the second edit");
  });
}

async function staleChoiceBeforeMerge() {
  await withChoiceThenSecondEdit(49100, "keep", "B1\n", async (ctx) => {
    const joined = await fetch(ctx.baseB + "/api/sync", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ join: true }),
    });
    const body = await joined.json();
    assert(joined.status === 409, "Bring them in refuses a stale choice " + joined.status + " " + JSON.stringify(body) + " " + ctx.childB._log().slice(-500));
    const hit = (body.conflicts || []).find((item) => item && item.path === "log/" + ctx.overlap + ".md");
    assert(hit && hit.mine === "B1\n" && hit.theirs === ctx.textA2, "the merge reopens the conflict with the new text " + JSON.stringify(body.conflicts || []));
    assert(body.join !== true, "Bring them in is not offered over the new conflict");
    assert(fileText(ctx.vaultB, "log/" + ctx.overlap + ".md") === "B1\n", "the merge did not overwrite the local copy");
    assert(git(["show", "main:log/" + ctx.overlap + ".md"], ctx.bare) === ctx.textA2, "the merge did not overwrite the second edit");
    assert(git(["rev-parse", "main"], ctx.bare).trim() === ctx.remoteAt, "Bring them in did not push the old choice");
  });
}

try {
  assertClientSurfacesConflict();
  retryUsesSyncQueue();
  await noRemoteUnchanged();
  await livePull();
  await sameFileKeepsBoth();
  await refusedPushIsShown();
  await divergedDifferentFiles();
  await mixedOverlapAndDisjoint();
  await joinHiddenUntilEveryConflictIsChosen();
  await conflictSurvivesDaySwitch();
  await strayFileLeftAlone();
  await otherNoteSurvivesConflict();
  await otherNoteSurvivesConflictOffline();
  await pendingSurvivesRestart();
  await staleChoiceAfterKeepMine();
  await staleChoiceAfterTakeTheirs();
  await staleChoiceAfterEdit();
  await staleChoiceBeforeMerge();
  console.log("vault-sync-test ok");
} catch (err) {
  console.error("FAIL  vault-sync-test  " + (err && err.stack || err));
  process.exit(1);
}
