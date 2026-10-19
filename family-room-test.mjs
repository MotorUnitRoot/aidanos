#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, execFileSync } from "node:child_process";
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
    grab("mapRowJoinPath", "mapCanvasRows") +
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
    " sandbox.mapRowJoinPath = mapRowJoinPath;" +
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
  mapRowJoinPath,
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
  assert(note.includes("jobNoteUsesDayChrome(path)"), "job papers keep the day beside the arrows");
  assert(/jobDay \? formatPaperTitle\(/.test(note), "day title stays beside the arrows");
  assert(/jobDay \? formatRailDate\(/.test(note), "week rail keeps the day");
  assert(!note.includes("writeJobFile") && !/vault\/log|log\//.test(note), "the day title is not written into the day file");
  const chromeStart = src.indexOf("function jobNoteUsesDayChrome(");
  const chrome = src.slice(chromeStart, src.indexOf("function notePaperTitle(", chromeStart));
  assert(chrome.includes("family-room-to-office/answers.md"), "questions use the day chrome");
  assert(chrome.includes("family-room-to-office/plan.md"), "drawing uses the day chrome");
  assert(chrome.includes("family-room-to-office/walk.md"), "walk uses the day chrome");
  assert(chrome.includes("family-room-to-office/today.md"), "today note uses the day chrome");
  assert(planMarkdownFromChecks([]).startsWith("# The room as it is\n"), "the paper keeps the one heading");
});

check("line 8 is not called unless it reports what the town said", () => {
  const ask = (phrase) => familyRoomStops(answersMd.replace(
    "8. What did the building department say?",
    "8. What did the building department say? " + phrase
  ), planMd);
  const town = (stops) => stops.some((s) => /building department/i.test(s));
  for (const phrase of ["Not asked yet", "not asked", "not yet", "no", "TBD", "Not called yet", ""]) {
    assert(town(ask(phrase)), JSON.stringify(phrase) + " is not a town answer");
  }
  for (const phrase of ["No permit needed", "The town said no", "Called Maria on October 19"]) {
    assert(!town(ask(phrase)), JSON.stringify(phrase) + " is what the town said");
  }
});

check("no walls change never offers Cut the wall", () => {
  const walls = answersMd
    .replace(
      "3. Will any wall or opening change?",
      "3. Will any wall or opening change? No walls change"
    )
    .replace(
      "8. What did the building department say?",
      "8. What did the building department say? No permit needed"
    );
  const stops = familyRoomStops(walls, planMd);
  assert(!stops.some((s) => /building department/i.test(s)), "the permit answer is not a town stop");
  assert(stops.some((s) => /wall stays closed/i.test(s)), "no walls change keeps the wall closed");
  const rough = parseProcessMap(mapMd).stages.find((s) => s.title === "Rough");
  const roughSteps = stageNextStepLines(rough);
  const offered = linesToAddToday(roughSteps, stops, walls);
  assert(!offered.some((s) => /Cut the wall/i.test(s)), "cut stays off: " + offered.join(" | "));
  assert(offered.some((s) => /rough inspection/i.test(s)), "the inspection still lands");
  const fromAnswer = linesToAddToday(roughSteps, [], walls);
  assert(!fromAnswer.some((s) => /Cut the wall/i.test(s)), "the answer blocks the cut with no other stop");
  const changing = answersMd
    .replace(
      "3. Will any wall or opening change?",
      "3. Will any wall or opening change? The north wall will change"
    )
    .replace(
      "8. What did the building department say?",
      "8. What did the building department say? No permit needed"
    );
  const openStops = familyRoomStops(changing, planMd);
  const openOffer = linesToAddToday(roughSteps, openStops, changing);
  assert(openOffer.some((s) => /Cut the wall/i.test(s)), "a wall that changes can still be cut");
});

check("a click on a numbered line does not land inside the first word", () => {
  const start = src.indexOf("function sourceCaretFromRendered(");
  const end = src.indexOf("\nfunction activateLine(", start);
  assert(start >= 0 && end > start, "caret mapper is in the paper");
  const box = {};
  new Function("box", src.slice(start, end) + "\nbox.sourceCaretFromRendered = sourceCaretFromRendered;")(box);
  const md = "1. Which room, and will anyone sleep there?";
  const body = "Which room, and will anyone sleep there?";
  const marker = "1.".length;
  assert(box.sourceCaretFromRendered(md, body, marker, marker) === 3, "the number click is the start of the question");
  assert(box.sourceCaretFromRendered(md, body, marker + 1, marker) === 4, "the first letter stays the first letter");
  assert(md.slice(box.sourceCaretFromRendered(md, body, marker, marker)).startsWith("Which"), "the tail is not hich room");
  assert(box.sourceCaretFromRendered(md, body, marker + body.length, marker) === md.length, "the end of the question stays the end");
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

check("the season block lines up with the day heading", () => {
  const css = fs.readFileSync(path.join(root, "day.css"), "utf8");
  const season = css.slice(css.indexOf(".job-season {"), css.indexOf(".job-season .stage-kicker"));
  assert(/width:\s*42rem/.test(season), "season column is the paper width");
  assert(/max-width:\s*100%/.test(season), "season column shrinks with the paper");
  assert(/margin:\s*0 auto/.test(season), "season column is centered with the heading");
});

check("Map and Drawing open their own screens and Today comes back", () => {
  const noteStart = src.indexOf("function renderNote(");
  const note = src.slice(noteStart, src.indexOf("async function openVaultNote(", noteStart));
  assert(note.includes("paintJobSeason()"), "opening a note clears the season block off the day paper");
  const season = src.slice(src.indexOf("async function paintJobSeason("), src.indexOf("const jobButton"));
  assert(season.includes("isNoteDoc()"), "a note does not keep the day season");
  assert(season.includes('setAttribute("hidden"'), "the season block hides");
  const wiki = src.slice(src.indexOf("async function openWiki("), src.indexOf("function wikiNameAtPoint("));
  assert(wiki.includes('openVaultNote("family-room-to-office/map.md")'), "Map opens the map");
  assert(wiki.includes('openVaultNote("family-room-to-office/plan.md")'), "Drawing opens the drawing");
  const back = src.slice(src.indexOf("async function goToday("), src.indexOf("document.querySelectorAll(\"a[href='#today']\")"));
  assert(back.includes("doc-map"), "Today drops the map screen");
  assert(back.includes("openDay(todayIso()"), "Today opens the day again");
});

check("Only one sits clear of the diamond and the next row is joined", () => {
  const css = fs.readFileSync(path.join(root, "day.css"), "utf8");
  const fork = css.slice(css.indexOf(".map-fork {"), css.indexOf(".map-fork span"));
  const kind = css.slice(css.indexOf(".map-fork-kind {"), css.indexOf(".map-fork-no"));
  const size = Number((fork.match(/width:\s*([0-9.]+)rem/) || [])[1]);
  const margin = Number((kind.match(/margin:\s*([0-9.]+)rem/) || [])[1]);
  const hang = size * (Math.SQRT2 - 1) / 2;
  assert(size === 7.1, "diamond size");
  assert(margin > hang + 0.7, "caption clears the point: margin " + margin + " hang " + hang);
  assert(css.includes(".map-board.is-overflow"), "a wide map starts at the left");
  assert(src.includes("mapBoardOverflows"), "overflow pins the map to the left edge");
  const sched = src.slice(src.indexOf("function scheduleMapRowJoins("), src.indexOf("scheduleMapRowJoins.gen = 0"));
  assert(sched.includes("clearMapRowJoin(board)"), "resize clears the old line");
  assert(sched.indexOf("clearMapRowJoin(board)") < sched.indexOf("mapBoardOverflows(board)"), "the old line is gone before the width is measured");
  assert(src.includes('addEventListener("resize"') && src.includes("scheduleMapRowJoins()"), "a resize measures the map again");
  const join = mapRowJoinPath({ x: 100, y: 10, w: 40, h: 20 }, { x: 10, y: 80, w: 40, h: 20 });
  assert(join === "M 120 30 L 120 55 L 30 55 L 30 80", join);
  const render = src.slice(src.indexOf("function renderMap("), src.indexOf("function mapRowJoinPath("));
  assert(render.includes("scheduleMapRowJoins()"), "the canvas draws the join");
  assert(src.includes("function drawMapRowJoins("), "a line is drawn between rows");
  assert(src.includes('class", "map-row-svg"'), "the join is a line on the canvas");
});

check("a narrow map starts at the left edge and scrolls", () => {
  const css = fs.readFileSync(path.join(root, "day.css"), "utf8");
  const at = css.indexOf(".map-board {\n    align-items: flex-start;");
  assert(at > css.indexOf("@media (max-width: 720px)"), "the left start is the phone map");
  const narrow = css.slice(at, css.indexOf("/* NotePlan", at));
  const board = narrow.slice(0, narrow.indexOf(".map-flow {"));
  assert(/align-items:\s*flex-start/.test(board), "rows start at the left");
  assert(/overflow:\s*auto/.test(board), "the map scrolls");
  assert(/min-width:\s*0/.test(board), "the board can be narrower than the map");
  const flow = narrow.slice(narrow.indexOf(".map-flow {"), narrow.indexOf("\n}"));
  assert(/justify-content:\s*flex-start/.test(flow), "the first stage is the start of the row");
  assert(/width:\s*max-content/.test(flow), "the row keeps its width and scrolls");
});

check("Map, Drawing, and the day arrows have a 44px tap area", () => {
  const css = fs.readFileSync(path.join(root, "day.css"), "utf8");
  const hit = css.slice(css.indexOf(".job-links .text-link::before,"), css.indexOf(".job-links .text-link::before {"));
  assert(hit.includes(".day-shift .text-link::before"), "date arrows");
  assert(hit.includes(".week-arrows .icon-btn::before"), "day strip arrows");
  const box = css.slice(css.indexOf(".job-links .text-link::before,"), css.indexOf(".job-links .text-link::before {") + 180);
  assert(/width:\s*44px/.test(box) && /height:\s*44px/.test(box), "44px box");
  assert(css.includes("#prev-day::before") && css.includes("#next-day::before"), "each date arrow");
  assert(css.includes("#prev-week::before") && css.includes("#next-week::before"), "each week arrow");
  const dayShift = css.slice(css.indexOf(".day-shift .text-link {"), css.indexOf(".view-today .dump-src"));
  assert(!/min-width:\s*44px/.test(dayShift) && !/min-height:\s*44px/.test(dayShift), "the date row keeps its size");
  const weekBtn = css.slice(css.indexOf(".view-today .icon-btn {"), css.indexOf(".view-today .icon-btn:hover"));
  assert(!/::before|:before/.test(weekBtn), "the week arrow glyph is not a pseudo element");
  const iconCss = fs.readFileSync(path.join(root, "styles.css"), "utf8");
  const iconBtn = iconCss.slice(iconCss.indexOf("\n.icon-btn {"), iconCss.indexOf(".icon-btn:hover"));
  assert(!/::before|:before/.test(iconBtn), "icon buttons do not paint their glyph with ::before");
  const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
  assert(html.includes('id="prev-week"') && html.includes("&#8249;"), "the week arrow glyph is a character");
  assert(html.includes('id="next-week"') && html.includes("&#8250;"), "the next week arrow glyph is a character");
  const links = src.slice(src.indexOf("links.className = \"job-links\""), src.indexOf("host.appendChild(button)"));
  assert(links.includes("openWiki(\"Map\")") && links.includes("openWiki(\"Drawing\")"), "the season links are Map and Drawing");
});

async function pngReadIsOnlyThePicture() {
  const vault = fs.mkdtempSync(path.join(os.tmpdir(), "aidanos-room-"));
  const job = path.join(vault, "family-room-to-office");
  fs.mkdirSync(job, { recursive: true });
  fs.mkdirSync(path.join(vault, "maps"), { recursive: true });
  const port = 24600 + Math.floor(Math.random() * 2000);
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
  const picture = (rel) => base + "/api/file?path=" + encodeURIComponent(rel);
  const putPng = (rel, png) => fetch(picture(rel), {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ png }),
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
    const secret = path.join(vault, "maps", "secret.txt");
    fs.writeFileSync(secret, "SECRET_HARD_LINK\n");
    fs.linkSync(secret, path.join(job, "plan.png"));
    const linked = await fetch(picture("family-room-to-office/plan.png"));
    const linkedBody = Buffer.from(await linked.arrayBuffer());
    assert(linked.status === 400, "hard link read got " + linked.status);
    assert(linkedBody.length < 400, "hard link response is the file");
    assert(!linkedBody.includes(Buffer.from("SECRET_HARD_LINK")), "hard link must not return the other file");
    assert(!linkedBody.includes(Buffer.from(vault)), "hard link error must not include the vault path");
    const pngBytes = Buffer.from(PNG, "base64");
    const other = path.join(job, "other.png");
    fs.writeFileSync(other, pngBytes);
    fs.unlinkSync(path.join(job, "plan.png"));
    fs.linkSync(other, path.join(job, "plan.png"));
    const linkedPng = await fetch(picture("family-room-to-office/plan.png"));
    const linkedPngBody = Buffer.from(await linkedPng.arrayBuffer());
    assert(linkedPng.status === 400, "png hard link read got " + linkedPng.status);
    assert(!linkedPngBody.includes(pngBytes), "a hard-linked png is not served");
    const replaced = await putPng("family-room-to-office/plan.png", PNG);
    assert(replaced.ok, "a new picture can replace the hard link name");
    assert(Buffer.compare(fs.readFileSync(other), pngBytes) === 0, "the other name keeps its bytes");
    const got = await fetch(picture("family-room-to-office/plan.png"));
    assert(got.ok && got.headers.get("content-type") === "image/png", "replaced picture reads back");
    assert(got.headers.get("x-content-type-options") === "nosniff", "picture response is not sniffed");
    const gotBytes = Buffer.from(await got.arrayBuffer());
    assert(gotBytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])), "full png signature");
    fs.writeFileSync(path.join(job, "walk.png"), "SECRET_PLAIN_FILE\n");
    const plain = await fetch(picture("family-room-to-office/walk.png"));
    const plainBody = Buffer.from(await plain.arrayBuffer());
    assert(plain.status === 400, "plain file read got " + plain.status);
    assert(!plainBody.includes(Buffer.from("SECRET_PLAIN_FILE")), "plain file must not be returned");
    const fake = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.alloc(8)]).toString("base64");
    const badPut = await putPng("family-room-to-office/walk.png", fake);
    assert(badPut.status === 400, "short signature got " + badPut.status);
    assert(fs.readFileSync(path.join(job, "walk.png"), "utf8") === "SECRET_PLAIN_FILE\n", "short signature is not stored");
    fs.writeFileSync(path.join(job, "walk.png"), Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.alloc(1_000_000),
    ]));
    const huge = await fetch(picture("family-room-to-office/walk.png"));
    const hugeBody = Buffer.from(await huge.arrayBuffer());
    assert(huge.status === 400, "oversize picture got " + huge.status);
    assert(hugeBody.length < 400, "oversize picture was sent to the client");
    fs.unlinkSync(path.join(job, "walk.png"));
    fs.symlinkSync("plan.png", path.join(job, "walk.png"));
    fs.unlinkSync(path.join(job, "plan.png"));
    fs.symlinkSync("walk.png", path.join(job, "plan.png"));
    const loop = await fetch(picture("family-room-to-office/plan.png"));
    const loopBody = Buffer.from(await loop.arrayBuffer());
    assert(loop.status === 400, "symlink loop got " + loop.status);
    assert(!loopBody.includes(Buffer.from(vault)), "symlink loop must not include the vault path");
    fs.unlinkSync(path.join(job, "walk.png"));
    execFileSync("mkfifo", [path.join(job, "walk.png")]);
    const started = Date.now();
    const pipe = await fetch(picture("family-room-to-office/walk.png"));
    assert(Date.now() - started < 2000, "fifo read stalled");
    assert(pipe.status === 400, "fifo read got " + pipe.status);
    assert(fs.lstatSync(path.join(job, "walk.png")).isFIFO(), "fifo is left in place");
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

await check("picture bytes have to be the picture", pngReadIsOnlyThePicture);

const failed = results.filter((r) => !r.ok);
console.log("");
if (failed.length) {
  console.log(failed.length + " failed, " + (results.length - failed.length) + " passed");
  process.exit(1);
}
console.log("family-room-test ok  (" + results.length + " passed)");
