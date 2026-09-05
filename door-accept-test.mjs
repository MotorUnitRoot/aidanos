#!/usr/bin/env node
import fs from "node:fs";

const src = fs.readFileSync(new URL("./app.js", import.meta.url), "utf8");
const html = fs.readFileSync(new URL("./index.html", import.meta.url), "utf8");
const css = fs.readFileSync(new URL("./day.css", import.meta.url), "utf8");

function grabFn(name, nextName) {
  const start = src.indexOf("function " + name + "(");
  if (start < 0) throw new Error("missing " + name);
  const next = src.indexOf("function " + nextName + "(", start + 1);
  if (next < 0) throw new Error("missing next " + nextName);
  return src.slice(start, next);
}

const helperSrc = grabFn("appendDoorTasks", "hideDoorProposals");
const sandbox = {};
const fn = new Function(
  "sandbox",
  helperSrc + "; sandbox.appendDoorTasks = appendDoorTasks;"
);
fn(sandbox);
const { appendDoorTasks } = sandbox;

const results = [];

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

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

check("empty markdown gets task lines, not the sentence", () => {
  const got = appendDoorTasks("", ["- [ ] sit the door", "- [ ] walk"]);
  assert(got.includes("- [ ] sit the door"), "sit line");
  assert(got.includes("- [ ] walk"), "walk line");
  assert(!got.includes("sit the door and walk"), "must not write the sentence");
  const tasks = got.split("\n").filter((line) => /^- \[ \] /.test(line));
  assert(tasks.length === 2, "only the two proposed tasks");
});

check("keeps existing and drops prose from lines", () => {
  const existing = "# Log — 2026-08-26\n\n## Notes\n";
  const got = appendDoorTasks(existing, [
    "- [ ] sit the door",
    "sit the door and walk",
    "## Extra",
    "- [ ] walk",
  ]);
  assert(got.startsWith("# Log — 2026-08-26"), "keeps existing start");
  assert(got.includes("## Notes"), "keeps existing heading");
  assert(got.includes("- [ ] sit the door"), "adds sit");
  assert(got.includes("- [ ] walk"), "adds walk");
  assert(!got.includes("sit the door and walk"), "drops the sentence");
  assert(!got.includes("## Extra"), "drops extra heading from lines");
  const tasks = got.split("\n").filter((line) => /^- \[ \] /.test(line));
  assert(tasks.length === 2, "did not invent extra tasks");
});

check("whitespace existing is treated as empty", () => {
  const got = appendDoorTasks("  \n", ["- [ ] sit the door"]);
  assert(got.includes("- [ ] sit the door"), "task present");
  assert(!got.trim().startsWith("\n"), "does not keep blank existing");
});

check("blank line before append when existing has content", () => {
  const got = appendDoorTasks("hello", ["- [ ] walk"]);
  assert(got.includes("hello\n\n- [ ] walk"), "separates with a blank line");
});

check("Accept path PUTs today via appendDoorTasks, no sentence inject", () => {
  const accept = doorBlock(
    '$("door-accept").addEventListener("click"',
    '$("door-reject").addEventListener("click"'
  );
  assert(accept.includes("todayIso()"), "uses todayIso, not leftover selectedDate");
  assert(!accept.includes("selectedDate"), "must not use selectedDate");
  assert(accept.includes("appendDoorTasks("), "appendDoorTasks");
  assert(/\/api\/day\?date=/.test(accept), "hits /api/day");
  assert(accept.includes('method: "PUT"') || accept.includes("method: 'PUT'"), "PUT");
  assert(accept.includes("res.status === 409") || accept.includes("status === 409"), "honor 409");
  assert(accept.includes("goToday()"), "goToday after accept");
  assert(accept.includes("openDay("), "openDay so paper shows new lines");
  assert(!accept.includes("saveDay"), "must not saveDay");
  assert(!/dump\.value/.test(accept), "must not write dump.value");
  assert(!/\/api\/file/.test(accept), "must not write a note file");
  assert(!accept.includes("applyDoorPending"), "applyDoorPending stays dead");
  assert(!accept.includes("input.value +"), "must not concat the sentence");
  assert(!/\bsentence\b/.test(accept), "must not inject a sentence var");
});

check("Reject path does not write", () => {
  const reject = doorBlock(
    '$("door-reject").addEventListener("click"',
    '$("toggle-month").addEventListener("click"'
  );
  assert(reject.includes("hideDoorProposals()"), "hides proposals");
  assert(reject.includes('input.value = ""') || reject.includes("input.value = ''"), "clears input");
  assert(!reject.includes("goToday"), "stay on Door");
  assert(!reject.includes("saveDay"), "no saveDay");
  assert(!/\/api\/day/.test(reject), "no /api/day");
  assert(!/dump\.value/.test(reject), "no dump.value");
  assert(!reject.includes("openDay"), "no openDay");
  assert(!reject.includes("applyDoorPending"), "applyDoorPending stays dead");
});

check("Accept uses doorProposed, not the sentence", () => {
  const accept = doorBlock(
    '$("door-accept").addEventListener("click"',
    '$("door-reject").addEventListener("click"'
  );
  assert(accept.includes("doorProposed"), "reads last proposed lines");
  assert(accept.includes("body.markdown"), "GET markdown");
  assert(!accept.includes("textContent"), "must not scrape the proposal box as the note");
});

check("Accept/Reject UI: door-decide row, no Mark / horse", () => {
  assert(html.includes('id="door-decide"'), "decide row");
  assert(html.includes('id="door-accept"'), "accept id");
  assert(html.includes('id="door-reject"'), "reject id");
  const doorHtml = html.slice(html.indexOf('id="view-door"'), html.indexOf('id="view-today"'));
  assert(/id="door-decide"[^>]*class="door-decide"/.test(doorHtml) || /class="door-decide"[^>]*id="door-decide"/.test(doorHtml), "decide class");
  assert(/id="door-decide"[^>]*hidden/.test(doorHtml) || /hidden[^>]*id="door-decide"/.test(doorHtml), "decide hidden until proposals");
  assert(/id="door-accept"[^>]*class="hairline-button"/.test(doorHtml) || /class="hairline-button"[^>]*id="door-accept"/.test(doorHtml), "accept is hairline-button");
  assert(/id="door-reject"[^>]*class="hairline-button"/.test(doorHtml) || /class="hairline-button"[^>]*id="door-reject"/.test(doorHtml), "reject is hairline-button");
  assert(/id="door-skip"[^>]*class="hairline-button"/.test(doorHtml) || /class="hairline-button"[^>]*id="door-skip"/.test(doorHtml), "Get to Work is hairline-button");
  assert(/id="door-capture"[^>]*class="hairline-button"/.test(doorHtml) || /class="hairline-button"[^>]*id="door-capture"/.test(doorHtml), "Capture thoughts is hairline-button");
  assert(doorHtml.includes(">Get to Work<"), "Get to Work label");
  assert(doorHtml.includes(">Capture thoughts<"), "Capture thoughts label");
  assert(!/\bhorse\b/i.test(doorHtml) && !/\bMark\b/.test(doorHtml), "Door HTML never says horse or Mark");
  const paint = grabFn("paintDoorProposals", "goToday");
  assert(paint.includes("door-decide"), "paint shows decide");
  assert(paint.includes("doorProposed"), "paint stores proposed lines");
  const hide = grabFn("hideDoorProposals", "paintDoorProposals");
  assert(hide.includes("door-decide"), "hide conceals decide");
  assert(hide.includes("doorProposed"), "hide clears proposed lines");
  assert(css.includes(".door-decide"), "decide style");
  const doorCssStart = css.indexOf("/* ——— Door ——— */");
  const doorCssEnd = css.indexOf("/* ——— Today room ——— */");
  const doorCss = css.slice(doorCssStart, doorCssEnd);
  assert(!/\bhorse\b/i.test(doorCss) && !/\bMark\b/.test(doorCss), "Door CSS never says horse or Mark");
  const decideCss = (doorCss.match(/\.door-decide[^{]*\{[^}]*\}/) || [""])[0];
  assert(!/gold|#c9a|#ffd|#f1c40f/i.test(decideCss), "no gold");
  assert(!src.includes("function applyDoorPending"), "applyDoorPending stays dead");
});

check("Hairline Door actions: Get to Work + Capture thoughts", () => {
  const doorHtml = html.slice(html.indexOf('id="view-door"'), html.indexOf('id="view-today"'));
  assert(doorHtml.includes(">Get to Work<"), "Get to Work label");
  assert(doorHtml.includes(">Capture thoughts<"), "Capture thoughts label");
  assert(/id="door-skip"[^>]*class="hairline-button"/.test(doorHtml) || /class="hairline-button"[^>]*id="door-skip"/.test(doorHtml), "Get to Work is hairline-button");
  assert(/id="door-capture"[^>]*class="hairline-button"/.test(doorHtml) || /class="hairline-button"[^>]*id="door-capture"/.test(doorHtml), "Capture thoughts is hairline-button");
  assert(css.includes(".hairline-button"), "hairline-button CSS");
  const hair = (css.match(/\.hairline-button\s*\{[^}]*\}/) || [""])[0];
  assert(/border\s*:\s*1px\s+solid/.test(hair), "hairline has 1px solid border");
  assert(!/border\s*:\s*0\b/.test(hair), "hairline border not 0");
  // neither action uses underline-only chrome
  assert(!/id="door-skip"[^>]*style="[^"]*text-decoration\s*:\s*underline/.test(doorHtml), "Get to Work not underline-styled");
  assert(!/id="door-capture"[^>]*style="[^"]*text-decoration\s*:\s*underline/.test(doorHtml), "Capture not underline-styled");
  const capture = doorBlock(
    '$("door-capture").addEventListener("click"',
    '$("door-accept").addEventListener("click"'
  );
  assert(capture.includes("goToday()"), "Capture thoughts goToday");
  assert(capture.includes("hideDoorProposals()"), "Capture hides proposals");
  assert(capture.includes('input.value = ""') || capture.includes("input.value = ''"), "Capture clears input");
});

const failed = results.filter((r) => !r.ok);
console.log("");
if (failed.length) {
  console.log(failed.length + " failed, " + (results.length - failed.length) + " passed");
  process.exit(1);
}
console.log("door-accept-test ok  (" + results.length + " passed)");
