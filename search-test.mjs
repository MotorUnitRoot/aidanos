#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));
const src = fs.readFileSync(path.join(root, "app.js"), "utf8");
const serverSrc = fs.readFileSync(path.join(root, "server.mjs"), "utf8");
const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
const receiptMapPath = path.join(root, "vault", "maps", "file-a-receipt.md");
const receiptMap = fs.readFileSync(receiptMapPath, "utf8");
const theReceipt = fs.readFileSync(path.join(root, "vault", "maps", "the-receipt.md"), "utf8");

const RECEIPT_TASKS = [
  "- [ ] Find the receipt",
  "- [ ] Put it in the vault",
  "- [ ] Note what it was for",
  "- [ ] File the original",
];

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
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

function grab(name, nextName) {
  const start = src.indexOf("function " + name + "(");
  if (start < 0) throw new Error("missing " + name);
  const next = src.indexOf("\nfunction " + nextName + "(", start + 1);
  if (next < 0) throw new Error("missing next " + nextName);
  return src.slice(start, next);
}

const whenRe = src.match(/const WHEN_RE = [^;]+;/);
assert(whenRe, "WHEN_RE");
const sandbox = {};
const fn = new Function(
  "sandbox",
  whenRe[0] +
    "\n" +
    grab("stripWhen", "parseTaskLine") +
    grab("parseTaskLine", "parseBlocks") +
    src.slice(src.indexOf("function taskKey("), src.indexOf("let doorProposed")) +
    "; sandbox.stripWhen = stripWhen;" +
    " sandbox.parseTaskLine = parseTaskLine;" +
    " sandbox.taskKey = taskKey;" +
    " sandbox.appendDoorTasks = appendDoorTasks;" +
    " sandbox.isWorkMapPath = isWorkMapPath;" +
    " sandbox.nextStepTaskLines = nextStepTaskLines;" +
    " sandbox.workMapPathsFromHits = workMapPathsFromHits;" +
    " sandbox.landedDayMarkdown = landedDayMarkdown;"
);
fn(sandbox);
const {
  isWorkMapPath,
  nextStepTaskLines,
  workMapPathsFromHits,
  landedDayMarkdown,
  appendDoorTasks,
} = sandbox;

function todayIso() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return y + "-" + m + "-" + day;
}

function hasAllReceiptTasks(markdown) {
  const text = String(markdown || "");
  return RECEIPT_TASKS.every((line) => text.includes(line));
}

function countTask(markdown, line) {
  return String(markdown || "").split("\n").filter((l) => l === line).length;
}

check("vault/maps/file-a-receipt.md is in this clone", () => {
  assert(fs.existsSync(receiptMapPath), "missing vault/maps/file-a-receipt.md");
  for (const line of RECEIPT_TASKS) {
    assert(receiptMap.includes(line), "map missing " + line);
  }
  assert(/\[\[today\]\]/.test(receiptMap), "map still names [[today]]");
  assert(/\[\[the-receipt\]\]/.test(receiptMap), "last-mile is [[the-receipt]]");
});

check("Door still paints Get to work / the question", () => {
  assert(html.includes("What do you want to do today?"), "Door question");
  assert(html.includes("Get to work"), "Get to work");
  assert(html.includes('id="view-door"'), "Door view");
});

check("server still binds 127.0.0.1 and reads PORT", () => {
  assert(serverSrc.includes('const HOST = "127.0.0.1"'), "HOST");
  assert(/PORT = Number\(process\.env\.PORT\) \|\| 3847/.test(serverSrc), "PORT env");
  assert(/server\.listen\(PORT, HOST/.test(serverSrc), "listen host");
});

check("isWorkMapPath keeps maps/file-a-receipt.md and skips maps/the-*", () => {
  assert(isWorkMapPath("maps/file-a-receipt.md") === true, "receipt map");
  assert(isWorkMapPath("maps/reply-to-a-letter.md") === true, "letter map");
  assert(isWorkMapPath("maps/the-receipt.md") === false, "last-mile receipt");
  assert(isWorkMapPath("maps/the-reply.md") === false, "last-mile reply");
  assert(isWorkMapPath("log/2026-08-31.md") === false, "day file");
});

check("nextStepTaskLines reads the four receipt tasks and skips [[today]]", () => {
  const lines = nextStepTaskLines(receiptMap);
  assert(lines.length === 4, "expected 4, got " + JSON.stringify(lines));
  assert(RECEIPT_TASKS.every((t) => lines.includes(t)), "four tasks");
  assert(!lines.some((l) => /today/.test(l)), "must not copy [[today]]");
  assert(nextStepTaskLines(theReceipt).length === 0, "the-receipt has no next steps");
});

check("landedDayMarkdown appends onto empty and dedups", () => {
  const once = landedDayMarkdown("", [receiptMap, theReceipt]);
  assert(hasAllReceiptTasks(once), "landed four tasks");
  assert(!once.includes("[[today]]"), "no wiki dump");
  const twice = landedDayMarkdown(once, [receiptMap]);
  assert(twice === once, "dedup leaves the paper alone");
  for (const line of RECEIPT_TASKS) {
    assert(countTask(once, line) === 1, "exactly one " + line);
  }
  const already = "- [x] Find the receipt\nhello\n";
  const merged = landedDayMarkdown(already, [receiptMap]);
  assert(countTask(merged, "- [ ] Find the receipt") === 0, "done task is not re-added");
  assert(merged.includes("- [ ] Put it in the vault"), "other tasks still land");
});

check("Ask search of receipt lands via runAsk; Get to work does not dump", () => {
  const runStart = src.indexOf("async function runAsk(");
  const runEnd = src.indexOf("\nfunction shiftDay(", runStart);
  const run = src.slice(runStart, runEnd);
  assert(run.includes('/api/search?q='), "Ask still searches");
  assert(run.includes("workMapPathsFromHits"), "Ask picks work maps from hits");
  assert(run.includes("landMapNextSteps"), "Ask lands next steps");
  assert(run.includes("openVaultSearchHit"), "clicking a hit still opens the file");
  const landStart = src.indexOf("async function landMapNextSteps(");
  const land = src.slice(landStart, src.indexOf("async function runAsk(", landStart));
  assert(land.includes('/api/day?date='), "lands through GET/PUT /api/day");
  assert(land.includes('method: "PUT"'), "PUT /api/day");
  assert(land.includes("landedDayMarkdown"), "same notepad append");
  assert(!land.includes("openVaultNote"), "landing does not open the map");
  const goStart = src.indexOf("function goToday(");
  const go = src.slice(goStart, src.indexOf("$(\"door-form\")", goStart));
  assert(!go.includes("landMapNextSteps"), "Get to work does not land maps");
  assert(go.includes("openDay(todayIso())"), "Get to work opens today");
  const skip = src.slice(src.indexOf('$("door-skip")'), src.indexOf('$("door-accept")'));
  assert(skip.includes("goToday()"), "Get to work still calls goToday");
  assert(!skip.includes("landMapNextSteps"), "skip does not dump tasks");
});

check("appendDoorTasks still the Door shape", () => {
  const next = appendDoorTasks("", ["- [ ] Find the receipt"]);
  assert(next === "- [ ] Find the receipt\n", JSON.stringify(next));
});

async function waitHealth(base, child) {
  const deadline = Date.now() + 8000;
  let last = "";
  while (Date.now() < deadline) {
    if (child.exitCode != null) {
      throw new Error("server exited " + child.exitCode + " " + last);
    }
    try {
      const res = await fetch(base + "/api/health");
      if (res.ok) return;
    } catch (e) {
      last = String(e.message || e);
    }
    await new Promise((r) => setTimeout(r, 80));
  }
  throw new Error("health timeout " + last);
}

async function liveSearchAndLand() {
  const vault = fs.mkdtempSync(path.join(os.tmpdir(), "aidanos-search-"));
  fs.mkdirSync(path.join(vault, "maps"), { recursive: true });
  fs.mkdirSync(path.join(vault, "log"), { recursive: true });
  for (const name of ["file-a-receipt.md", "the-receipt.md", "reply-to-a-letter.md", "the-reply.md"]) {
    fs.copyFileSync(path.join(root, "vault", "maps", name), path.join(vault, "maps", name));
  }
  const port = 18000 + Math.floor(Math.random() * 2000);
  const child = spawn(process.execPath, ["server.mjs"], {
    cwd: root,
    env: { ...process.env, PORT: String(port), AIDANOS_VAULT: vault },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let errOut = "";
  child.stderr.on("data", (buf) => { errOut += String(buf); });
  const base = "http://127.0.0.1:" + port;
  try {
    await waitHealth(base, child);
    const date = todayIso();
    const empty = await fetch(base + "/api/day?date=" + date);
    assert(empty.ok, "GET /api/day");
    const emptyBody = await empty.json();
    assert(!String(emptyBody.markdown || "").trim(), "empty Get to work paper stays empty");

    const search = await fetch(base + "/api/search?q=" + encodeURIComponent("receipt"));
    assert(search.ok, "GET /api/search");
    const found = await search.json();
    const hits = found.hits || [];
    assert(
      hits.some((h) => String(h.path || "").replace(/\\/g, "/") === "maps/file-a-receipt.md"),
      "Ask/search of receipt finds maps/file-a-receipt.md: " + JSON.stringify(hits.map((h) => h.path))
    );
    const maps = workMapPathsFromHits(hits);
    assert(maps.includes("maps/file-a-receipt.md"), "work map from hits");
    assert(!maps.includes("maps/the-receipt.md"), "does not land maps/the-receipt.md");

    const mapBodies = [];
    for (const rel of maps) {
      const file = await fetch(base + "/api/file?path=" + encodeURIComponent(rel));
      assert(file.ok, "GET /api/file " + rel);
      const body = await file.json();
      mapBodies.push(body.markdown || "");
    }
    const day = await fetch(base + "/api/day?date=" + date);
    const dayBody = await day.json();
    const next = landedDayMarkdown(dayBody.markdown || "", mapBodies);
    const put = await fetch(base + "/api/day?date=" + date, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        date,
        paper: next,
        markdown: next,
        mtime: Number(dayBody.mtime) || 0,
      }),
    });
    assert(put.ok, "PUT /api/day " + put.status);
    const after = await fetch(base + "/api/day?date=" + date);
    const afterBody = await after.json();
    assert(hasAllReceiptTasks(afterBody.markdown), "today paper has the four tasks");
    const disk = fs.readFileSync(path.join(vault, "log", date + ".md"), "utf8");
    assert(hasAllReceiptTasks(disk), "disk log/" + date + ".md has the four tasks");
    for (const line of RECEIPT_TASKS) {
      assert(countTask(disk, line) === 1, "disk has one " + line);
    }

    const again = landedDayMarkdown(afterBody.markdown, mapBodies);
    const put2 = await fetch(base + "/api/day?date=" + date, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        date,
        paper: again,
        markdown: again,
        mtime: Number(afterBody.mtime) || 0,
      }),
    });
    assert(put2.ok, "dedup PUT");
    const disk2 = fs.readFileSync(path.join(vault, "log", date + ".md"), "utf8");
    for (const line of RECEIPT_TASKS) {
      assert(countTask(disk2, line) === 1, "dedup still one " + line);
    }

    const writeHere = await fetch(base + "/api/search?q=" + encodeURIComponent("Write here"));
    const writeHits = (await writeHere.json()).hits || [];
    assert(workMapPathsFromHits(writeHits).length === 0, "the-* last-mile hits do not land");
  } finally {
    try { child.kill("SIGTERM"); } catch (e) {}
    const deadline = Date.now() + 2000;
    while (child.exitCode == null && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 40));
    }
    try { child.kill("SIGKILL"); } catch (e) {}
    try { fs.rmSync(vault, { recursive: true, force: true }); } catch (e) {}
    if (errOut && !results.some((r) => r.name && r.name.includes("live"))) {
      // keep for the failing check
    }
  }
}

await check("Ask/search receipt finds the map and lands next steps on a day file", liveSearchAndLand);

const failed = results.filter((r) => !r.ok);
console.log("");
if (failed.length) {
  console.log(failed.length + " failed, " + (results.length - failed.length) + " passed");
  process.exit(1);
}
console.log("search-test ok  (" + results.length + " passed)");
