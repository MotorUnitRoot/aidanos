#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));
const src = fs.readFileSync(path.join(root, "app.js"), "utf8");
const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
const css = fs.readFileSync(path.join(root, "day.css"), "utf8");
const letterPath = path.join(root, "vault", "maps", "reply-to-a-letter.md");
const letter = fs.readFileSync(letterPath, "utf8");
const receipt = fs.readFileSync(path.join(root, "vault", "maps", "file-a-receipt.md"), "utf8");

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

const sandbox = {};
new Function(
  "sandbox",
  grab("isWorkMapPath", "isMapDoc") +
    grab("parseTaskLine", "parseBlocks") +
    grab("stageGateText", "mapNextStepLines") +
    grab("mapNextStepLines", "taskLineKey") +
    grab("taskLineKey", "appendMapTasks") +
    grab("appendMapTasks", "appendDoorTasks") +
    grab("appendDoorTasks", "hideDoorProposals") +
    "\nsandbox.isWorkMapPath = isWorkMapPath;" +
    " sandbox.parseProcessMap = parseProcessMap;" +
    " sandbox.processMapLints = processMapLints;" +
    " sandbox.stageGateText = stageGateText;" +
    " sandbox.stageNextStepLines = stageNextStepLines;" +
    " sandbox.mapNextStepLines = mapNextStepLines;" +
    " sandbox.appendMapTasks = appendMapTasks;"
)(sandbox);

const {
  isWorkMapPath,
  parseProcessMap,
  processMapLints,
  stageGateText,
  stageNextStepLines,
  mapNextStepLines,
  appendMapTasks,
} = sandbox;

check("Door stays empty of process chrome", () => {
  const door = html.slice(html.indexOf('id="view-door"'), html.indexOf('id="view-today"'));
  assert(door.includes("What do you want to do today?"), "question");
  assert(door.includes("Get to Work"), "Get to Work");
  assert(door.includes("Capture thoughts"), "Capture thoughts");
  assert(!door.includes("map-room"), "no map room on Door");
  assert(!door.includes("map-canvas"), "no canvas on Door");
  assert(!door.includes("stage-sheet"), "no stage paper on Door");
  assert(!/process map/i.test(door), "no process copy on Door");
});

check("Today holds canvas and stage paper; paper stays 42rem", () => {
  const today = html.slice(html.indexOf('id="view-today"'), html.indexOf('id="view-plan"'));
  assert(today.includes('id="map-room"'), "map room");
  assert(today.includes('id="map-canvas"'), "canvas");
  assert(today.includes('id="stage-sheet"'), "stage paper");
  assert(today.includes("Ask quietly"), "stage ask");
  assert(css.includes("width: 42rem"), "42rem paper");
  assert(css.includes("body.doc-map"), "map chrome hide");
  assert(css.includes(".stage-sheet"), "stage sheet");
  assert(src.includes("aidanos-shell-v22") || fs.readFileSync(path.join(root, "sw.js"), "utf8").includes("aidanos-shell-v22"), "shell bump");
});

check("Paper and dump refuse iOS autofill accessories", () => {
  const dumpTag = (html.match(/<textarea[^>]*id="dump"[^>]*>/) || [])[0] || "";
  const paperTag = (html.match(/<div[^>]*id="paper"[^>]*>/) || [])[0] || "";
  assert(dumpTag, "dump tag");
  assert(paperTag, "paper tag");
  assert(dumpTag.includes('name="day-write"'), "dump name is not password/email/cc");
  assert(!/name="(password|email|username|q|cc|card|address)"/i.test(dumpTag), "dump avoids autofill names");
  for (const tag of [dumpTag, paperTag]) {
    assert(/autocomplete="off"/.test(tag), "autocomplete off");
    assert(/autocorrect="on"/.test(tag), "autocorrect on for prose");
    assert(/autocapitalize="sentences"/.test(tag), "sentences for prose");
    assert(/data-lpignore="true"/.test(tag), "LastPass ignore");
    assert(/data-1p-ignore="true"/.test(tag), "1Password ignore");
    assert(!/type="password"/.test(tag), "no password-input trick");
    assert(!/autocomplete="(new-password|current-password|username|email|cc-|street-address|one-time-code)"/.test(tag), "no password/cc/address token");
  }
  assert(paperTag.includes('contenteditable="true"'), "paper stays a writing surface");
  assert(html.includes('?v=task1'), "asset query bump");
});

check("isWorkMapPath keeps work maps and skips last-mile the-*", () => {
  assert(isWorkMapPath("maps/reply-to-a-letter.md") === true, "letter");
  assert(isWorkMapPath("maps/file-a-receipt.md") === true, "receipt");
  assert(isWorkMapPath("maps/the-reply.md") === false, "the-reply");
  assert(isWorkMapPath("maps/the-receipt.md") === false, "the-receipt");
  assert(isWorkMapPath("log/2026-09-06.md") === false, "day");
});

check("letter map parses stages, one named fork, Enter/Exit", () => {
  const map = parseProcessMap(letter);
  assert(map.title === "Reply to a letter", map.title);
  assert(map.stages.length === 5, "five stages, got " + map.stages.length);
  assert(map.stages.map((s) => s.title).join(",") === "Receive,Decide,Write,Send,Waiting", "names");
  assert(stageGateText(map.stages[0], "enter") === "Letter arrives", "receive enter");
  assert(stageGateText(map.stages[0], "exit") === "Letter logged", "receive exit");
  assert(map.forks.length === 1, "one fork");
  assert(map.forks[0].title === "Should I reply?", map.forks[0].title);
  assert(map.forks[0].forkKind === "only-one", map.forks[0].forkKind);
  assert(map.forks[0].branches.some((b) => b.label === "Yes" && /Write/i.test(b.target)), "yes → write");
  assert(map.forks[0].branches.some((b) => b.label === "No" && /Waiting/i.test(b.target)), "no → waiting");
  const write = map.stages.find((s) => s.title === "Write");
  assert(write && write.why.includes("closes the loop"), "write why");
  assert(write.enterItems.length === 4, "write enter checks");
  assert(write.exitItems.length === 4, "write exit checks");
  assert(write.nextItems.length === 4, "write next steps");
  assert(processMapLints(map).length === 0, "complete letter is quiet: " + processMapLints(map).join(" "));
  const mapSteps = mapNextStepLines(letter);
  assert(mapSteps.length === 4, "map still has four today tasks");
  assert(mapSteps.includes("- [ ] Read the letter"), "read the letter");
});

check("soft lint speaks plain English", () => {
  const broken = parseProcessMap([
    "# Thin map",
    "",
    "## Stages",
    "",
    "### 1. Receive",
    "Enter: Letter arrives",
    "",
    "### Fork:",
    "- Yes → Receive",
  ].join("\n"));
  const lints = processMapLints(broken);
  assert(lints.some((l) => /missing an Exit/i.test(l)), "missing Exit: " + lints.join(" | "));
  assert(lints.some((l) => /no name/i.test(l)), "unlabeled fork: " + lints.join(" | "));
  assert(lints.every((l) => !/runtime|engine|invalid|error code/i.test(l)), "no engine talk");
  const empty = processMapLints(parseProcessMap(receipt));
  assert(empty.some((l) => /no stages yet/i.test(l)), "receipt has no stages yet");
});

check("stage next steps land as Today checkboxes", () => {
  const map = parseProcessMap(letter);
  const write = map.stages.find((s) => s.title === "Write");
  const steps = stageNextStepLines(write);
  assert(steps.includes("- [ ] Send the reply."), "send");
  const day = appendMapTasks("", mapNextStepLines(letter).concat(steps));
  assert(day.includes("- [ ] Read the letter"), "map task");
  assert(day.includes("- [ ] Send the reply."), "stage task");
  assert(!day.includes("## Next steps"), "not a second map");
});

check("Ask and wiki open a work map through the same last-mile", () => {
  const open = src.slice(src.indexOf("async function openVaultNote("), src.indexOf("async function openVaultSearchHit("));
  assert(open.includes("renderNote()"), "openVaultNote paints the note");
  const render = src.slice(src.indexOf("function renderNote("), src.indexOf("async function openVaultNote("));
  assert(render.includes("isWorkMapPath"), "renderNote knows work maps");
  assert(render.includes("renderMap()"), "work map draws the canvas");
  assert(src.includes("openVaultSearchHit"), "Ask hit still opens the file");
  assert(src.includes("async function openWiki("), "wiki still opens");
  const wiki = src.slice(src.indexOf("async function openWiki("), src.indexOf("function wikiNameAtPoint("));
  assert(wiki.includes("openVaultPath"), "wiki uses the vault path");
  assert(!/celonis|salesforce flow|swimlane|crm canvas/i.test(src), "no refused products");
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
    await new Promise((r) => setTimeout(r, 80));
  }
  throw new Error("health timeout " + last);
}

async function liveCopyDeleteAndOpen() {
  const vault = fs.mkdtempSync(path.join(os.tmpdir(), "aidanos-map-"));
  fs.mkdirSync(path.join(vault, "maps"), { recursive: true });
  fs.mkdirSync(path.join(vault, "log"), { recursive: true });
  for (const name of ["reply-to-a-letter.md", "the-reply.md", "file-a-receipt.md", "the-receipt.md"]) {
    fs.copyFileSync(path.join(root, "vault", "maps", name), path.join(vault, "maps", name));
  }
  const port = 18100 + Math.floor(Math.random() * 2000);
  const child = spawn(process.execPath, ["server.mjs"], {
    cwd: root,
    env: { ...process.env, PORT: String(port), AIDANOS_HOST: "127.0.0.1", AIDANOS_VAULT: vault },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const base = "http://127.0.0.1:" + port;
  try {
    await waitHealth(base, child);
    const file = await fetch(base + "/api/file?path=" + encodeURIComponent("maps/reply-to-a-letter.md"));
    assert(file.ok, "GET work map");
    const body = await file.json();
    const parsed = parseProcessMap(body.markdown);
    assert(parsed.stages.length === 5, "opened map has stages");
    assert(parsed.forks.length === 1, "opened map has a fork");

    const search = await fetch(base + "/api/search?q=" + encodeURIComponent("reply to a letter"));
    assert(search.ok, "search");
    const hits = (await search.json()).hits || [];
    assert(
      hits.some((h) => String(h.path || "").replace(/\\/g, "/") === "maps/reply-to-a-letter.md"),
      "Ask finds the letter map: " + JSON.stringify(hits.map((h) => h.path))
    );

    fs.copyFileSync(
      path.join(vault, "maps", "reply-to-a-letter.md"),
      path.join(vault, "maps", "reply-to-a-letter-copy.md")
    );
    const copy = await fetch(base + "/api/file?path=" + encodeURIComponent("maps/reply-to-a-letter-copy.md"));
    assert(copy.ok, "copied map is just another vault file");
    const copyBody = await copy.json();
    assert(parseProcessMap(copyBody.markdown).forks.length === 1, "copy is the same map");

    fs.unlinkSync(path.join(vault, "maps", "reply-to-a-letter-copy.md"));
    const gone = await fetch(base + "/api/file?path=" + encodeURIComponent("maps/reply-to-a-letter-copy.md"));
    assert(gone.status === 404, "delete drops the map, got " + gone.status);

    const date = "2026-09-06";
    const steps = mapNextStepLines(body.markdown);
    const day = await (await fetch(base + "/api/day?date=" + date)).json();
    const next = appendMapTasks(day.markdown || "", steps);
    const put = await fetch(base + "/api/day?date=" + date, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ date, paper: next, markdown: next, mtime: day.mtime || 0 }),
    });
    assert(put.ok, "PUT day");
    const disk = fs.readFileSync(path.join(vault, "log", date + ".md"), "utf8");
    assert(disk.includes("- [ ] Read the letter"), "today has the checkbox");
    assert(!disk.includes("## Stages"), "today is not the map");
  } finally {
    try { child.kill("SIGTERM"); } catch {}
    const deadline = Date.now() + 2000;
    while (child.exitCode == null && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 40));
    }
    try { child.kill("SIGKILL"); } catch {}
    try { fs.rmSync(vault, { recursive: true, force: true }); } catch {}
  }
}

await check("vault file copy, delete, Ask, and Today checkboxes use the current ABI", liveCopyDeleteAndOpen);

const failed = results.filter((r) => !r.ok);
console.log("");
if (failed.length) {
  console.log(failed.length + " failed, " + (results.length - failed.length) + " passed");
  process.exit(1);
}
console.log("process-map-test ok  (" + results.length + " passed)");
