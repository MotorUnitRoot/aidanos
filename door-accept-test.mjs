#!/usr/bin/env node
import fs from "node:fs";

const src = fs.readFileSync(new URL("./app.js", import.meta.url), "utf8");
const html = fs.readFileSync(new URL("./index.html", import.meta.url), "utf8");
const css = fs.readFileSync(new URL("./day.css", import.meta.url), "utf8");

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

function buttonClass(id) {
  const re = new RegExp('id="' + id + '"[^>]*class="([^"]*)"|class="([^"]*)"[^>]*id="' + id + '"');
  const m = html.match(re);
  return ((m && (m[1] || m[2])) || "").trim();
}

const results = [];
function check(name, run) {
  try {
    run();
    results.push({ name, ok: true });
    console.log("pass  " + name);
  } catch (err) {
    results.push({ name, ok: false, error: err.message });
    console.log("FAIL  " + name + "  " + err.message);
  }
}

function doorBlock(from, until) {
  const start = src.indexOf(from);
  const end = src.indexOf(until, start + 1);
  assert(start >= 0 && end > start, "block " + from);
  return src.slice(start, end);
}

check("Accept and Reject are hairline-button, not door-skip", () => {
  for (const id of ["door-accept", "door-reject"]) {
    const cls = buttonClass(id);
    assert(cls.includes("hairline-button"), id + " must have class hairline-button, got " + buttonClass(id));
    assert(!cls.split(/\s+/).includes("door-skip"), id + " must not use door-skip class");
  }
});

check("Get to Work and Capture thoughts are hairline-button", () => {
  assert(html.includes(">Get to Work<"), "Get to Work label");
  assert(html.includes(">Capture thoughts<"), "Capture thoughts label");
  for (const id of ["door-skip", "door-capture"]) {
    const cls = buttonClass(id);
    assert(cls.includes("hairline-button"), id + " must have class hairline-button, got " + buttonClass(id));
  }
});

check("Capture thoughts calls openCaptureNote", () => {
  const capture = doorBlock(
    '$("door-capture").addEventListener("click"',
    '$("door-accept").addEventListener("click"'
  );
  assert(src.includes("async function openCaptureNote("), "openCaptureNote exists");
  assert(capture.includes("openCaptureNote()"), "Capture thoughts openCaptureNote");
  assert(capture.includes("preventDefault()"), "Capture click preventDefault");
  assert(capture.includes("stopPropagation()"), "Capture click stopPropagation");
  assert(!capture.includes("goToday()"), "Capture does not goToday");
  assert(capture.includes("hideDoorProposals()"), "Capture hides proposals");
});

check("Capture is not stolen back to Today", () => {
  const open = src.slice(src.indexOf("async function openVaultNote("), src.indexOf("async function openVaultSearchHit("));
  assert(open.includes("const noteGen = ++state.openDayGen"), "openVaultNote bumps openDayGen");
  assert(open.includes("if (noteGen !== state.openDayGen) return"), "openVaultNote cancels stale fetch");
  const day = src.slice(src.indexOf("async function openDay("), src.indexOf("function renderDay("));
  assert(day.includes("if (isNoteDoc()) return;"), "openDay does not wipe a note");
  const week = src.slice(src.indexOf("async function loadWeek("), src.indexOf("function renderWeek("));
  assert(week.includes("if (isNoteDoc())"), "loadWeek returns when a note is open");
  assert(!/if \(inWeek\) await openDay/.test(week.split("if (isNoteDoc())")[0] || ""), "loadWeek does not openDay before the note check");
});

check("Empty Write. cue and save snapshot stay on Capture", () => {
  assert(src.includes("function paperHasVisibleText("), "paperHasVisibleText");
  assert(src.includes("function syncPaperEmptyClass("), "syncPaperEmptyClass");
  assert(src.includes("function ensureDumpMatchesPaper("), "ensureDumpMatchesPaper");
  const save = src.slice(src.indexOf("async function saveDay("), src.indexOf("function currentView("));
  assert(save.indexOf("const snap = paperSaveSnapshot()") > save.indexOf("const run = async ()"), "saveDay snapshots inside the chain");
  assert(!src.includes('classList.remove("is-empty")'), "focus does not drop is-empty");
  assert(/position:\s*relative/.test(css.slice(css.indexOf(".paper {"), css.indexOf(".paper {") + 280)), "paper is relative");
  const cue = css.slice(css.indexOf(".paper.is-empty:before"), css.indexOf(".paper.is-empty:before") + 220);
  assert(/position:\s*absolute/.test(cue), "Write. cue is absolute");
  assert(/z-index:\s*1/.test(cue), "Write. cue sits over the seed line");
  const phone = css.slice(css.lastIndexOf("@media (max-width: 720px)"));
  assert(phone.includes("body.doc-capture .week-row"), "phone hides week-row on Capture");
  assert(phone.includes("body.doc-capture .today-rail"), "phone hides today-rail on Capture");
  assert(phone.includes("body.doc-capture .day-shift"), "phone hides day-shift on Capture");
  assert(phone.includes("body.doc-capture #timeline"), "phone hides timeline on Capture");
});

check("Door actions row and Capture chrome locks", () => {
  assert(html.includes('class="door-actions"'), "index wraps buttons in door-actions");
  assert(css.includes(".door-actions {"), "day.css has .door-actions");
  assert(/flex-direction:\s*row/.test(css.slice(css.indexOf(".door-actions {"), css.indexOf(".door-actions {") + 220)), "door-actions is a row");
  assert(css.includes("body.doc-capture"), "day.css has body.doc-capture");
  const show = src.slice(src.indexOf("function showView("), src.indexOf("function route("));
  assert(show.includes("!isNoteDoc()"), "showView must not openDay when isNoteDoc");
  const open = src.slice(src.indexOf("async function openVaultNote("), src.indexOf("async function openVaultSearchHit("));
  assert(open.includes("history.replaceState"), "openVaultNote uses replaceState for #today");
});

check("day.css hairline-button is a 1px solid square", () => {
  const start = css.indexOf(".hairline-button {");
  assert(start >= 0, "missing .hairline-button");
  const end = css.indexOf("}", start);
  const block = css.slice(start, end + 1);
  assert(/border:\s*1px solid/.test(block), "hairline-button has border: 1px solid");
  assert(/border-radius:\s*0/.test(block), "hairline-button border-radius 0");
  assert(!/border:\s*0\b/.test(block), "hairline border not 0");
  assert(!/text-decoration:\s*underline/.test(block), "not underline-only");
});

const failed = results.filter((r) => !r.ok);
console.log("");
if (failed.length) {
  console.log(failed.length + " failed, " + (results.length - failed.length) + " passed");
  process.exit(1);
}
console.log("door-accept-test ok  (" + results.length + " passed)");
