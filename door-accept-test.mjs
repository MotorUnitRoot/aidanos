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
  assert(!capture.includes("goToday()"), "Capture does not goToday");
  assert(capture.includes("hideDoorProposals()"), "Capture hides proposals");
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
