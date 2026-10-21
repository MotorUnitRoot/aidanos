#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));
const app = fs.readFileSync(path.join(root, "app.js"), "utf8");
const server = fs.readFileSync(path.join(root, "server.mjs"), "utf8");

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

function grab(src, start, end) {
  const i = src.indexOf(start);
  assert(i >= 0, "missing " + start);
  const j = src.indexOf(end, i + start.length);
  assert(j > i, "missing " + end + " after " + start);
  return src.slice(i, j);
}

const results = [];
function check(name, run) {
  try {
    const out = run();
    if (out && typeof out.then === "function") {
      return out.then(() => {
        results.push({ name, ok: true });
        console.log("pass  " + name);
      }).catch((err) => {
        results.push({ name, ok: false, error: err.message });
        console.log("FAIL  " + name + "  " + err.message);
      });
    }
    results.push({ name, ok: true });
    console.log("pass  " + name);
  } catch (err) {
    results.push({ name, ok: false, error: err.message });
    console.log("FAIL  " + name + "  " + err.message);
  }
}

check("hide, close, and refresh do not save a clean page", () => {
  const leave = grab(app, "function flushOnLeave(", "function applyRemoteNote(");
  const dirtyAt = leave.indexOf("if (!state.dirty) return;");
  const saveAt = leave.indexOf("saveDay(");
  assert(dirtyAt >= 0 && saveAt > dirtyAt, "flushOnLeave returns before saveDay when nothing is unsaved");
  assert(!leave.slice(0, dirtyAt).includes("fetch("), "the clean return does not fetch");
  assert(!leave.slice(0, dirtyAt).includes("saveDay("), "the clean return does not save");
  assert(app.includes('window.addEventListener("pagehide", flushOnLeave)'), "pagehide flushes through the dirty check");
  assert(app.includes('window.addEventListener("beforeunload", flushOnLeave)'), "beforeunload flushes through the dirty check");
  const vis = grab(app, 'document.addEventListener("visibilitychange"', "(function wireRailToggle(");
  assert(vis.includes('visibilityState === "hidden"') && vis.includes("flushOnLeave()"), "hiding the tab flushes through the dirty check");
  assert(!vis.includes("saveDay("), "visibility does not save on its own");
  const noteLeave = grab(app, "async function leaveCurrentPaper(", "async function loadWeek(");
  assert(
    noteLeave.indexOf("if (!state.dirty) return;") < noteLeave.indexOf("await saveDay()"),
    "leaving a clean note does not save",
  );
});

check("day switch does not save a clean page", () => {
  const fn = grab(app, "async function openDay(", "\nfunction renderDay(");
  const gate = "if (leavingDay && !conflictOpen && state.dirty)";
  assert(fn.includes(gate), "day switch still skips an open conflict and also requires unsaved edits");
  assert(fn.includes("leavingDay && !conflictOpen"), "day switch does not re-save an open conflict");
  assert(fn.indexOf("putRawDay(") > fn.indexOf(gate), "putRawDay stays inside the dirty check");
  assert(!/await putRawDay/.test(fn), "day switch still does not wait on the old day");
  assert(fn.indexOf("renderDay()") < fn.indexOf("putRawDay("), "paint before saving the old day");
});

check("a close-time 409 does not open the conflict sheet", () => {
  const handle = grab(app, "function handleSaveConflict(", "function conflictMineNow(");
  assert(handle.indexOf("if (keepalive) return;") < handle.indexOf("openPaperConflict("), "keepalive 409 returns before the sheet");
  const save = grab(app, "async function saveDay(", "function currentView(");
  assert(save.includes("handleSaveConflict(snap, body, { keepalive })"), "save 409 uses the existing conflict handler");
  assert(!save.includes("openPaperConflict("), "saveDay does not open a second sheet");
  assert(!/putNote\(Number\(body\.mtime\)/.test(save), "409 does not retry the write");
});

check("own-write exemption stays on the watcher only", () => {
  const dayPut = grab(server, 'if (pathname === "/api/day" && req.method === "PUT")', 'if (pathname === "/api/plan"');
  assert(!dayPut.includes("isSelfWrite"), "day save does not skip the stale check for an app write");
  assert(dayPut.includes('error: "disk newer"'), "day save still answers disk newer");
  assert(dayPut.includes("sendDayWatch(date, mtime)"), "day save alerts with the new mtime");
  const filePut = grab(server, 'if (pathname === "/api/file" && req.method === "PUT")', 'if (pathname === "/api/tree"');
  assert(!filePut.includes("isSelfWrite"), "note save does not skip the stale check for an app write");
  assert(filePut.includes('error: "disk newer"'), "note save still answers disk newer");
  assert(filePut.includes("sendWatch({ path: relPath, mtime })"), "note save alerts with path and mtime");
  const watch = grab(server, "function startLogWatch(", "function sendFile(");
  const skip = watch.indexOf("if (isSelfWrite(date, mtime)) return;");
  const tell = watch.indexOf("sendDayWatch(date, mtime)");
  assert(skip >= 0 && tell > skip, "the log watcher still ignores the server's own write");
});

async function waitHealth(base, child) {
  const deadline = Date.now() + 8000;
  let last = "";
  while (Date.now() < deadline) {
    if (child.exitCode != null) throw new Error("server exited " + child.exitCode + " " + last);
    try {
      const res = await fetch(base + "/api/health");
      if (res.ok) return;
    } catch (e) {
      last = String(e.message || e);
    }
    await new Promise((r) => setTimeout(r, 40));
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

async function liveTwoClients() {
  const vault = fs.mkdtempSync(path.join(os.tmpdir(), "aidanos-stale-"));
  const date = "2026-10-21";
  const noteRel = "maps/shared.md";
  const dayPath = path.join(vault, "log", date + ".md");
  const notePath = path.join(vault, "maps", "shared.md");
  fs.mkdirSync(path.join(vault, "log"), { recursive: true });
  fs.mkdirSync(path.join(vault, "maps"), { recursive: true });
  fs.writeFileSync(dayPath, "loaded\n", "utf8");
  fs.writeFileSync(notePath, "loaded note\n", "utf8");
  const past = new Date(Date.now() - 10_000);
  fs.utimesSync(dayPath, past, past);
  fs.utimesSync(notePath, past, past);

  const port = 21000 + Math.floor(Math.random() * 2000);
  const child = spawn(process.execPath, ["server.mjs"], {
    cwd: root,
    env: {
      ...process.env,
      PORT: String(port),
      AIDANOS_HOST: "127.0.0.1",
      AIDANOS_VAULT: vault,
      AIDANOS_VAULT_GIT_URL: "",
      AIDANOS_VAULT_GIT_TOKEN: "",
      GITHUB_TOKEN: "",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let errOut = "";
  child.stderr.on("data", (buf) => { errOut += String(buf); });
  child.stdout.on("data", (buf) => { errOut += String(buf); });
  const base = "http://127.0.0.1:" + port;
  const fail = (msg) => new Error(msg + (errOut ? " :: " + errOut.slice(-400) : ""));

  try {
    await waitHealth(base, child);

    const loadedA = await (await fetch(base + "/api/day?date=" + date)).json();
    const loadedB = await (await fetch(base + "/api/day?date=" + date)).json();
    assert(loadedA.markdown === "loaded\n" && loadedB.markdown === loadedA.markdown, "both clients loaded the day");
    assert(loadedA.mtime > 0 && loadedA.mtime === loadedB.mtime, "both clients share the day mtime");

    const dayWatch = await fetch(base + "/api/day-watch");
    assert(dayWatch.ok, "day watch " + dayWatch.status);
    const dayAlert = readSseUntil(dayWatch, (data) => data && data.date === date, 4000);
    const phone = "from the phone\n";
    const saved = await fetch(base + "/api/day?date=" + date, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ date, paper: phone, markdown: phone, mtime: loadedA.mtime }),
    });
    const savedBody = await saved.json();
    assert(saved.status === 200, "client A day save " + saved.status + " " + JSON.stringify(savedBody));
    const alert = await dayAlert;
    assert(alert.date === date, "day alert names the day");
    assert(alert.mtime === savedBody.mtime, "day alert carries the saved mtime");
    assert(alert.mtime > loadedB.mtime, "day alert is newer than the other client's copy");

    const stale = await fetch(base + "/api/day?date=" + date, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        date,
        paper: loadedB.markdown,
        markdown: loadedB.markdown,
        mtime: loadedB.mtime,
      }),
    });
    const staleBody = await stale.json();
    assert(stale.status === 409, "client B stale day save got " + stale.status + " " + JSON.stringify(staleBody));
    assert(staleBody.error === "disk newer", "stale day 409 is disk newer");
    assert(staleBody.markdown === phone, "stale day 409 returns the phone text");
    assert(staleBody.mtime === savedBody.mtime, "stale day 409 returns the phone mtime");
    assert(fs.readFileSync(dayPath, "utf8") === phone, "stale day save left the phone text on disk");

    await new Promise((r) => setTimeout(r, 30));
    const outsideWatch = await fetch(base + "/api/day-watch");
    const outsideAlert = readSseUntil(
      outsideWatch,
      (data) => data && data.date === date && data.mtime > savedBody.mtime,
      4000,
    );
    fs.writeFileSync(dayPath, "edited outside\n", "utf8");
    const outside = await outsideAlert;
    assert(outside.date === date && outside.mtime > savedBody.mtime, "an outside day edit still alerts");

    const noteA = await (await fetch(base + "/api/file?path=" + encodeURIComponent(noteRel))).json();
    const noteB = await (await fetch(base + "/api/file?path=" + encodeURIComponent(noteRel))).json();
    assert(noteA.markdown === "loaded note\n" && noteB.mtime === noteA.mtime, "both clients loaded the note");
    const noteWatch = await fetch(base + "/api/day-watch");
    const noteAlert = readSseUntil(noteWatch, (data) => data && data.path === noteRel && !data.date, 4000);
    const phoneNote = "phone note\n";
    const noteSaved = await fetch(base + "/api/file?path=" + encodeURIComponent(noteRel), {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: noteRel, paper: phoneNote, markdown: phoneNote, mtime: noteA.mtime }),
    });
    const noteSavedBody = await noteSaved.json();
    assert(noteSaved.status === 200, "client A note save " + noteSaved.status + " " + JSON.stringify(noteSavedBody));
    const noteNotice = await noteAlert;
    assert(noteNotice.path === noteRel, "note alert names the path");
    assert(noteNotice.mtime === noteSavedBody.mtime, "note alert carries the saved mtime");
    assert(noteNotice.mtime > noteB.mtime, "note alert is newer than the other client's copy");

    const noteStale = await fetch(base + "/api/file?path=" + encodeURIComponent(noteRel), {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        path: noteRel,
        paper: noteB.markdown,
        markdown: noteB.markdown,
        mtime: noteB.mtime,
      }),
    });
    const noteStaleBody = await noteStale.json();
    assert(noteStale.status === 409, "client B stale note save got " + noteStale.status + " " + JSON.stringify(noteStaleBody));
    assert(noteStaleBody.error === "disk newer", "stale note 409 is disk newer");
    assert(noteStaleBody.markdown === phoneNote, "stale note 409 returns the phone text");
    assert(fs.readFileSync(notePath, "utf8") === phoneNote, "stale note save left the phone text on disk");
  } catch (e) {
    throw fail(e && e.message || String(e));
  } finally {
    await stop(child);
    try { fs.rmSync(vault, { recursive: true, force: true }); } catch {}
  }
}

await check("two clients: stale save is 409, newer text stays, and the other client is told", liveTwoClients);

const failed = results.filter((r) => !r.ok);
console.log("");
if (failed.length) {
  console.log(failed.length + " failed, " + (results.length - failed.length) + " passed");
  process.exit(1);
}
console.log("stale-save-test ok  (" + results.length + " passed)");
