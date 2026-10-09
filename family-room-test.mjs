#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));
const src = fs.readFileSync(path.join(root, "app.js"), "utf8");
const letter = fs.readFileSync(path.join(root, "vault/maps/reply-to-a-letter.md"), "utf8");
const mapMd = fs.readFileSync(path.join(root, "vault/family-room-to-office/map.md"), "utf8");
const planMd = fs.readFileSync(path.join(root, "vault/family-room-to-office/plan.md"), "utf8");
const answersMd = fs.readFileSync(path.join(root, "vault/family-room-to-office/answers.md"), "utf8");

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
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
    grab("appendDoorTasks", "hideDoorProposals") +
    grab("mapCanvasRows", "paintStagePaper") +
    "\nsandbox.isWorkMapPath = isWorkMapPath;" +
    " sandbox.parseProcessMap = parseProcessMap;" +
    " sandbox.stageNextStepLines = stageNextStepLines;" +
    " sandbox.familyRoomStops = familyRoomStops;" +
    " sandbox.linesToAddToday = linesToAddToday;" +
    " sandbox.planMarkdownFromChecks = planMarkdownFromChecks;" +
    " sandbox.placeStopsFirst = placeStopsFirst;" +
    " sandbox.ensureFamilySeason = ensureFamilySeason;" +
    " sandbox.familyRoomSeed = familyRoomSeed;" +
    " sandbox.mapCanvasRows = mapCanvasRows;"
)(sandbox);

const {
  isWorkMapPath,
  parseProcessMap,
  stageNextStepLines,
  familyRoomStops,
  linesToAddToday,
  planMarkdownFromChecks,
  placeStopsFirst,
  ensureFamilySeason,
  familyRoomSeed,
  mapCanvasRows,
} = sandbox;

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

check("a missing answers file still opens the eight questions", () => {
  const md = familyRoomSeed("family-room-to-office/answers.md");
  const qs = md.split("\n").filter((line) => /^\d+\.\s/.test(line));
  assert(qs.length === 8, "eight lines, got " + qs.length);
  assert(qs[0].includes("Which room"), qs[0]);
  assert(qs[7].includes("building department"), qs[7]);
  assert(familyRoomSeed("family-room-to-office/plan.md").includes("- [ ] Overall sizes"), "drawing seed");
  assert(familyRoomSeed("family-room-to-office/map.md").includes("Cut the wall"), "map seed");
  assert(familyRoomSeed("family-room-to-office/walk.md").startsWith("# From the doorway"), "walk seed");
  assert(familyRoomSeed("maps/reply-to-a-letter.md") === "", "other notes are not seeded");
  const open = src.slice(src.indexOf("async function openVaultNote("), src.indexOf("async function openVaultSearchHit("));
  assert(open.includes("familyRoomSeed"), "a missing file falls through to the seed");
  assert(open.includes("isMissingFileError"), "only a missing file");
  assert(open.includes("renderNote()"), "the note still paints");
});

check("exact Door sentence opens Questions and nothing else does", () => {
  const submit = src.slice(src.indexOf('$("door-form")'), src.indexOf('$("door-skip")'));
  const sentenceAt = submit.indexOf("FAMILY_ROOM_SENTENCE");
  assert(sentenceAt >= 0, "submit knows the sentence");
  assert(sentenceAt < submit.indexOf("landDoorQueryOnToday"), "sentence before map search");
  assert(submit.includes("openFamilyRoomQuestions"), "sentence opens Questions");
  assert(submit.indexOf("landDoorQueryOnToday") < submit.indexOf("proposeDoorLines"), "other sentences still search then propose");
  const skip = src.slice(src.indexOf('$("door-skip")'), src.indexOf("(function wireDoorCapture()"));
  assert(!skip.includes("openFamilyRoomQuestions"), "Get to work does not open Questions");
  assert(!skip.includes("FAMILY_ROOM_SENTENCE"), "Get to work ignores the sentence");
  const capture = src.slice(src.indexOf("(function wireDoorCapture()"), src.indexOf('$("door-accept")'));
  assert(!capture.includes("openFamilyRoomQuestions"), "Capture thoughts does not open Questions");
  assert(!capture.includes("landDoorQueryOnToday"), "Capture thoughts does not land maps");
});

check("job map is the only canvas in the folder", () => {
  assert(isWorkMapPath("family-room-to-office/map.md") === true, "map.md");
  assert(isWorkMapPath("family-room-to-office/answers.md") === false, "answers");
  assert(isWorkMapPath("family-room-to-office/plan.md") === false, "plan");
  assert(isWorkMapPath("maps/reply-to-a-letter.md") === true, "letter still a map");
  assert(isWorkMapPath("maps/the-reply.md") === false, "last-mile still skipped");
});

check("two forks and the last two stages share the next row", () => {
  const map = parseProcessMap(mapMd);
  assert(map.title === "Family room to office", map.title);
  assert(map.stages.map((s) => s.title).join(" | ") === "See the room | Name the use | Read the structure | Ask the town | Rough | Close and finish | Final", map.stages.map((s) => s.title).join(" | "));
  assert(map.forks.length === 2, "two forks, got " + map.forks.length);
  assert(map.forks[0].title === "Wall stays / might carry load", map.forks[0].title);
  assert(map.forks[1].title === "Surface only / open the wall", map.forks[1].title);
  assert(map.forks.every((f) => f.forkKind === "only-one"), "both forks are only one");
  const rows = mapCanvasRows(map);
  assert(rows.length === 2, "two rows, got " + rows.length);
  const second = rows[1].filter((n) => n.type === "stage").map((n) => n.stage.title);
  assert(second.join(" | ") === "Close and finish | Final", second.join(" | "));
  assert(rows[0].filter((n) => n.type === "fork").length === 2, "both forks stay on the first row");
  const letterMap = parseProcessMap(letter);
  assert(letterMap.stages.length === 5, "letter stages");
  assert(letterMap.forks.length === 1, "letter fork");
  assert(mapCanvasRows(letterMap).length === 1, "letter stays one row");
});

check("drawing writes checks and invents no measurements", () => {
  assert(planMd.includes("- [ ] Overall sizes"), "seed starts unchecked");
  assert(!/\d+\s*(ft|feet|in|inch|inches)/i.test(planMd), "seed has no measurements");
  const written = planMarkdownFromChecks(["Door swing and window"]);
  assert(written.includes("- [x] Door swing and window"), "checked line stays");
  assert(written.includes("- [ ] Overall sizes"), "unchecked stays unchecked");
  assert(written.includes("- [ ] Where the built-in meets the floor"), "last line stays");
  assert(!/\d+\s*(ft|feet|in|inch|inches)/i.test(written), "no invented measurements");
  assert(!written.includes("- [ ] Cut"), "no cut line");
});

check("a stop blocks the next cut", () => {
  const sleeping = answersMd.replace(
    "1. Which room, and will anyone sleep there?",
    "1. Which room, and will anyone sleep there? Yes, someone will sleep there."
  );
  const stops = familyRoomStops(sleeping, planMd);
  assert(stops[0] === "Someone would sleep there. Stop.", stops.join(" | "));
  const lines = linesToAddToday([
    "- [ ] Paint",
    "- [ ] Open the wall",
    "- [ ] Cut the wall",
  ], stops);
  assert(lines.length === 1 && lines[0] === "- [ ] Paint", lines.join(" | "));
  const quiet = familyRoomStops(answersMd, planMd);
  assert(quiet.some((s) => /building department/i.test(s)), "empty town answer is a stop");
  assert(!quiet.some((s) => /sleep there/i.test(s)), "blank sleep answer is not a stop");
  const notCalled = answersMd.replace(
    "8. What did the building department say?",
    "8. What did the building department say? Not called yet"
  );
  const town = familyRoomStops(notCalled, planMd);
  assert(town.some((s) => /building department/i.test(s)), "Not called yet is the town stop");
  const rough = parseProcessMap(mapMd).stages.find((s) => s.title === "Rough");
  const roughSteps = stageNextStepLines(rough);
  assert(roughSteps.some((s) => /Cut the wall/.test(s)), "Rough has a cut to refuse");
  assert(roughSteps.some((s) => /rough inspection/i.test(s)), "Rough has a step to add");
  const added = linesToAddToday(roughSteps, town);
  assert(!added.some((s) => /Cut the wall/i.test(s)), "cut stays off today: " + added.join(" | "));
  assert(added.some((s) => /rough inspection/i.test(s)), "inspection still lands");
  const walk = placeStopsFirst("# From the doorway\n\nA chair.\n", stops);
  assert(walk.indexOf("Someone would sleep there. Stop.") < walk.indexOf("A chair."), "stop is first");
  const season = ensureFamilySeason("# Stay on the plan\n\n## Why\nThe week is already written.\n", stops);
  assert(season.includes("# Stay on the plan"), "season title stays");
  assert(season.includes("## Before you cut"), "before you cut");
  assert(season.includes("Someone would sleep there. Stop."), "stop in the season file");
  const cutAt = season.indexOf("## Before you cut");
  const linkAt = season.indexOf("[[Map]] [[Drawing]]");
  assert(linkAt > cutAt, "map and drawing links sit under Before you cut");
  assert(season.indexOf("Someone would sleep there. Stop.") < linkAt, "the stop stays ahead of the links");
  const finish = parseProcessMap(mapMd).stages.find((s) => s.title === "Close and finish");
  const finishSteps = stageNextStepLines(finish).map((s) => s.replace(/^- \[ \] /, ""));
  assert(finishSteps.join(" | ") === "Prime | Casing and crown | The hard floor | Base | Plates and grilles | Paint | A simple built-in", finishSteps.join(" | "));
  assert(finishSteps.filter((s) => /casing/i.test(s)).length === 1, "casing once");
  const finalStage = parseProcessMap(mapMd).stages.find((s) => s.title === "Final");
  const finalSteps = stageNextStepLines(finalStage);
  assert(finalSteps.length === 1 && /final inspection/i.test(finalSteps[0]), finalSteps.join(" | "));
  assert(/subfloor/.test(finalStage.why) && /finish floor/.test(finalStage.why), "built-in placement stays in the why");
  const seeded = parseProcessMap(familyRoomSeed("family-room-to-office/map.md"));
  const seededFinish = stageNextStepLines(seeded.stages.find((s) => s.title === "Close and finish")).map((s) => s.replace(/^- \[ \] /, ""));
  assert(seededFinish.join(" | ") === finishSteps.join(" | "), "fresh vault seed matches the map");
  const noteStart = src.indexOf("function renderNote(");
  const noteEnd = src.indexOf("async function openVaultNote(", noteStart);
  const note = src.slice(noteStart, noteEnd);
  assert(note.includes('path === "family-room-to-office/plan.md"'), "drawing is named in renderNote");
  assert(/drawing \? formatPaperTitle\(/.test(note), "day title stays beside the arrows");
  assert(/drawing \? formatRailDate\(/.test(note), "week rail keeps the day");
  assert(planMarkdownFromChecks([]).startsWith("# The room as it is\n"), "the paper keeps the one heading");
});

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

check("a drop on the paper uploads the picture", () => {
  const start = src.indexOf('$("paper").addEventListener("drop"');
  const end = src.indexOf('document.addEventListener("selectionchange"', start);
  const paperDrop = src.slice(start, end);
  assert(paperDrop.includes("saveJobPicture"), paperDrop.slice(0, 240));
  assert(paperDrop.includes("jobPictureRel()"), "paper drop only uploads on the drawing and the walk");
  const save = src.slice(src.indexOf("function saveJobPicture("), src.indexOf("const paperWrap"));
  assert(save.includes("family-room-to-office/plan.png") || src.includes('return "family-room-to-office/plan.png"'), "drawing drop writes plan.png");
  assert(src.includes('return "family-room-to-office/walk.png"'), "walk drop writes walk.png");
});

check("the picture is painted from the file url", () => {
  const urlFn = src.slice(src.indexOf("function jobPictureUrl("), src.indexOf("async function paintJobPicture("));
  const start = src.indexOf("async function paintJobPicture(");
  const end = src.indexOf("function seasonSection(", start);
  const paint = src.slice(start, end);
  assert(urlFn.includes('"/api/file?path="'), "same-origin file url");
  assert(paint.includes("jobPictureUrl(rel)"), "picture uses that url");
  assert(!paint.includes("createObjectURL"), "no blob url");
  assert(!/img-src[^"]*blob:/.test(fs.readFileSync(path.join(root, "server.mjs"), "utf8")), "csp is not loosened");
});

check("the picture sits under the heading at the paper width", () => {
  const css = fs.readFileSync(path.join(root, "day.css"), "utf8");
  const block = css.slice(css.indexOf(".job-picture {"), css.indexOf(".job-season {"));
  assert(block.includes("width: 100%"), "picture uses the paper width");
  assert(block.includes("border: 0"), "no frame");
  assert(block.includes("box-shadow: none"), "no card");
  assert(block.includes("background: transparent"), "no card fill");
  const place = src.slice(src.indexOf("function placeJobPicture("), src.indexOf("function seasonSection("));
  assert(place.includes('paper.querySelector(".md-line.h1")'), "under the heading");
  assert(place.includes("heading.after(picture)"), "checkboxes stay below the picture");
  const painted = src.slice(src.indexOf("function paintPaper()"), src.indexOf("function paintPaperAt("));
  assert(painted.includes("parkJobPicture()"), "a repaint does not drop the picture");
  assert(painted.includes("placeJobPicture()"), "a repaint puts the picture back under the heading");
  const hidden = css.slice(css.indexOf(".job-picture[hidden]"), css.indexOf(".job-picture {"));
  assert(hidden.includes("display: none"), "no picture leaves no gap");
});

async function pngRoundTrip() {
  const vault = fs.mkdtempSync(path.join(os.tmpdir(), "aidanos-room-"));
  fs.mkdirSync(path.join(vault, "family-room-to-office"), { recursive: true });
  fs.mkdirSync(path.join(vault, "maps"), { recursive: true });
  fs.writeFileSync(path.join(vault, "maps", "secret.txt"), "SECRET_TXT\n");
  const port = 18600 + Math.floor(Math.random() * 2000);
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
  const base = "http://127.0.0.1:" + port;
  try {
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
      if (child.exitCode != null) throw new Error("server exited");
      try {
        const res = await fetch(base + "/api/health");
        if (res.ok) break;
      } catch {}
      await new Promise((r) => setTimeout(r, 40));
    }
    const outside = await fetch(base + "/api/file?path=" + encodeURIComponent("maps/note.png"), {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ png: PNG }),
    });
    assert(outside.status === 400, "png outside the folder got " + outside.status);
    const txt = await fetch(base + "/api/file?path=" + encodeURIComponent("maps/secret.txt"));
    assert(txt.status === 400, "plain text still refused");
    const put = await fetch(base + "/api/file?path=" + encodeURIComponent("family-room-to-office/plan.png"), {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ png: PNG }),
    });
    assert(put.ok, "png in the job folder");
    const got = await fetch(base + "/api/file?path=" + encodeURIComponent("family-room-to-office/plan.png"));
    assert(got.ok, "read the png");
    assert(got.headers.get("content-type") === "image/png", got.headers.get("content-type"));
    const buf = Buffer.from(await got.arrayBuffer());
    assert(buf[0] === 0x89 && buf.toString("ascii", 1, 4) === "PNG", "bytes are a png");
    assert(!fs.existsSync(path.join(root, "vault/family-room-to-office/plan.png")), "repo seed has no generated png");
    assert(!fs.existsSync(path.join(root, "vault/family-room-to-office/walk.png")), "repo seed has no walk png");
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

await check("png stays inside the job folder", pngRoundTrip);

async function pngSymlinkStaysInJob() {
  const vault = fs.mkdtempSync(path.join(os.tmpdir(), "aidanos-room-"));
  const job = path.join(vault, "family-room-to-office");
  const logDir = path.join(vault, "log");
  fs.mkdirSync(job, { recursive: true });
  fs.mkdirSync(logDir, { recursive: true });
  const day = path.join(logDir, "2026-10-09.md");
  fs.writeFileSync(day, "SECRET_DAY_NOTE\n");
  const port = 20600 + Math.floor(Math.random() * 2000);
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
  const base = "http://127.0.0.1:" + port;
  const putPng = (rel) => fetch(base + "/api/file?path=" + encodeURIComponent(rel), {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ png: PNG }),
  });
  try {
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
      if (child.exitCode != null) throw new Error("server exited");
      try {
        const res = await fetch(base + "/api/health");
        if (res.ok) break;
      } catch {}
      await new Promise((r) => setTimeout(r, 40));
    }
    const walkPut = await putPng("family-room-to-office/walk.png");
    assert(walkPut.ok, "walk.png in the real folder");
    fs.unlinkSync(path.join(job, "walk.png"));
    fs.symlinkSync(day, path.join(job, "walk.png"));
    const leaked = await fetch(base + "/api/file?path=" + encodeURIComponent("family-room-to-office/walk.png"));
    const leakedBody = Buffer.from(await leaked.arrayBuffer());
    assert(leaked.status === 400, "symlink read got " + leaked.status);
    assert(!leakedBody.includes("SECRET_DAY_NOTE"), "symlink must not return the day note");
    const overwrite = await putPng("family-room-to-office/walk.png");
    assert(overwrite.status === 400, "symlink write got " + overwrite.status);
    assert(fs.readFileSync(day, "utf8") === "SECRET_DAY_NOTE\n", "day note stays");
    assert(fs.lstatSync(path.join(job, "walk.png")).isSymbolicLink(), "write does not replace the symlink");
    fs.rmSync(job, { recursive: true, force: true });
    fs.symlinkSync(logDir, job);
    const escaped = await putPng("family-room-to-office/plan.png");
    assert(escaped.status === 400, "directory symlink write got " + escaped.status);
    assert(!fs.existsSync(path.join(logDir, "plan.png")), "plan.png must not land in log");
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

await check("a symlink cannot leave the job folder", pngSymlinkStaysInJob);

const failed = results.filter((r) => !r.ok);
console.log("");
if (failed.length) {
  console.log(failed.length + " failed, " + (results.length - failed.length) + " passed");
  process.exit(1);
}
console.log("family-room-test ok  (" + results.length + " passed)");
